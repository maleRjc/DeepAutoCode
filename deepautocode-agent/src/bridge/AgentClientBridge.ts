import {
  CancelRequestSchema,
  RequestMessageSchema,
  ResponseMessageSchema,
  ResumeRequestSchema,
  type AgentExecutionMode,
  type BackendMode,
  type CapabilityName,
  type EventMessage,
  type ResponseMessage,
} from '../types.js';
import { sanitizeObjectForLog } from '../security.js';
import { ProviderManager, type SecretStorageAdapter } from '../../providers/index.js';
import { CapabilityRegistry } from '../capabilities/CapabilityRegistry.js';
import { BackendManager } from '../runtime/BackendManager.js';
import { ResourceManager } from '../runtime/ResourceManager.js';
import { RuntimeFactory, type IClineCoreInstance } from '../runtime/RuntimeFactory.js';
import { ApprovalBridge } from './ApprovalBridge.js';
import { EventBridge, type UIEventListener } from './EventBridge.js';
import { SessionBridge } from './SessionBridge.js';

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024; // 2MB protection against oversized Webview messages

/**
 * Section 3.3, 4.1 & 6.4: Unified Agent Client Bridge
 * Acts as the trusted boundary in the Extension Host between the AI Webview and Cline SDK Runtime.
 */
export class AgentClientBridge {
  public readonly storageDir: string;
  public readonly workspaceRoot: string;
  public readonly backendManager: BackendManager;
  public readonly resourceManager: ResourceManager;
  public readonly eventBridge: EventBridge;
  public readonly approvalBridge: ApprovalBridge;
  public readonly capabilityRegistry: CapabilityRegistry;
  public readonly providerManager: ProviderManager;
  public sessionBridge!: SessionBridge;
  private runtime!: IClineCoreInstance;

  private readonly processedRequestIds = new Map<string, ResponseMessage>();
  private readonly inFlightRequestIds = new Set<string>();

  private constructor(params: {
    storageDir: string;
    workspaceRoot: string;
    initialBackendMode?: BackendMode;
    secretStorage?: SecretStorageAdapter;
    approvalTimeoutMs?: number;
  }) {
    this.storageDir = params.storageDir;
    this.workspaceRoot = params.workspaceRoot;
    this.backendManager = new BackendManager({
      initialMode: params.initialBackendMode ?? 'local',
    });
    this.resourceManager = new ResourceManager();
    this.eventBridge = new EventBridge();
    this.approvalBridge = new ApprovalBridge(this.eventBridge, {
      defaultTimeoutMs: params.approvalTimeoutMs ?? 120_000,
    });
    this.providerManager = new ProviderManager(params.secretStorage);
    this.capabilityRegistry = new CapabilityRegistry({
      approvalHandler: async (req) => {
        const decision = await this.approvalBridge.requestApproval({
          sessionId: req.sessionId,
          toolName: req.capability,
          summary: req.summary,
          risk: req.risk,
          targetPath: req.targetPath,
          command: req.command,
          cwd: req.cwd,
          arguments: req.arguments,
        });
        return {
          approved: decision.approved,
          approvalId: decision.approvalId,
          reason: decision.reason,
        };
      },
    });
  }

  static async create(params: {
    storageDir: string;
    workspaceRoot: string;
    initialBackendMode?: BackendMode;
    secretStorage?: SecretStorageAdapter;
    approvalTimeoutMs?: number;
  }): Promise<AgentClientBridge> {
    const bridge = new AgentClientBridge(params);
    await bridge.initializeRuntime(params.initialBackendMode ?? 'local');
    return bridge;
  }

  private async initializeRuntime(mode?: BackendMode): Promise<void> {
    this.runtime = await RuntimeFactory.create({
      storageDir: this.storageDir,
      backendManager: this.backendManager,
      capabilityRegistry: this.capabilityRegistry,
      providerManager: this.providerManager,
      preferredMode: mode,
    });

    this.resourceManager.register({
      id: `runtime:${this.runtime.instanceId}`,
      category: 'runtime',
      dispose: async () => {
        await this.runtime.dispose();
      },
    });

    if (!this.sessionBridge) {
      this.sessionBridge = new SessionBridge({
        runtime: this.runtime,
        eventBridge: this.eventBridge,
        approvalBridge: this.approvalBridge,
        resourceManager: this.resourceManager,
      });
    } else {
      this.sessionBridge.rebindRuntime(this.runtime);
    }
  }

  /**
   * Simulate Extension Host Restart (PoC-L2 verification):
   * Disposes current runtime & creates a brand-new ClineCore instance backed by the same storage directory.
   */
  async restartRuntimeInstance(): Promise<{ oldInstanceId: string; newInstanceId: string }> {
    const oldInstanceId = this.runtime.instanceId;
    await this.runtime.dispose();
    await this.initializeRuntime(this.backendManager.getConfiguredMode());
    return {
      oldInstanceId,
      newInstanceId: this.runtime.instanceId,
    };
  }

  /**
   * Attach a Webview UI listener with automatic resource registration (no duplicate subscriptions on reopen)
   */
  attachWebview(webviewId: string, listener: UIEventListener): () => Promise<void> {
    const unsub = this.eventBridge.subscribeUI(webviewId, listener);
    this.resourceManager.attachWebview(webviewId, unsub);
    return async () => {
      await this.resourceManager.onWebviewClosed(webviewId);
    };
  }

  /**
   * Section 6.2 & 6.4: Handle incoming raw Webview message with strict schema validation,
   * oversized message protection, and duplicate requestId idempotency.
   */
  async handleWebviewMessage(rawMessage: unknown): Promise<ResponseMessage> {
    const serializedSize = JSON.stringify(rawMessage ?? '').length;
    if (serializedSize > MAX_MESSAGE_BYTES) {
      return this.buildErrorResponse(
        'unknown',
        'oversized_check',
        'MESSAGE_TOO_LARGE',
        `Message payload (${serializedSize} bytes) exceeds maximum allowed limit (${MAX_MESSAGE_BYTES} bytes)`
      );
    }

    if (!rawMessage || typeof rawMessage !== 'object') {
      return this.buildErrorResponse(
        'unknown',
        'malformed',
        'MALFORMED_MESSAGE',
        'Incoming Webview message must be a JSON object'
      );
    }

    const msgObj = rawMessage as Record<string, unknown>;
    const category = msgObj.category;

    // Handle 'cancel' category
    if (category === 'cancel') {
      const parsedCancel = CancelRequestSchema.safeParse(rawMessage);
      if (!parsedCancel.success) {
        return this.buildErrorResponse(
          'session.cancel',
          String(msgObj.requestId ?? 'cancel_err'),
          'INVALID_SCHEMA',
          parsedCancel.error.message
        );
      }
      const res = await this.sessionBridge.cancelSession(
        parsedCancel.data.sessionId,
        parsedCancel.data.reason
      );
      return ResponseMessageSchema.parse({
        category: 'response',
        type: 'session.cancel',
        requestId: parsedCancel.data.requestId ?? `cancel_${Date.now()}`,
        ok: true,
        data: res,
      });
    }

    // Handle 'resume' category
    if (category === 'resume') {
      const parsedResume = ResumeRequestSchema.safeParse(rawMessage);
      if (!parsedResume.success) {
        return this.buildErrorResponse(
          'session.resume',
          'resume_err',
          'INVALID_SCHEMA',
          parsedResume.error.message
        );
      }
      try {
        const snapshot = await this.sessionBridge.resumeSession(
          parsedResume.data.sessionId,
          parsedResume.data.lastSequence
        );
        return ResponseMessageSchema.parse({
          category: 'response',
          type: 'session.resume',
          requestId: `resume_${parsedResume.data.sessionId}_${Date.now()}`,
          ok: true,
          data: snapshot,
        });
      } catch (err) {
        return this.buildErrorResponse(
          'session.resume',
          `resume_${parsedResume.data.sessionId}`,
          'RESUME_FAILED',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Handle standard 'request' category
    const parsedReq = RequestMessageSchema.safeParse(rawMessage);
    if (!parsedReq.success) {
      return this.buildErrorResponse(
        String(msgObj.type ?? 'unknown'),
        String(msgObj.requestId ?? 'invalid_req'),
        'INVALID_SCHEMA',
        parsedReq.error.message
      );
    }

    const req = parsedReq.data;

    // Section 6.4: Duplicate requestId check
    if (this.inFlightRequestIds.has(req.requestId)) {
      return this.buildErrorResponse(
        req.type,
        req.requestId,
        'DUPLICATE_REQUEST_ID',
        `Request "${req.requestId}" is already in-flight`
      );
    }
    if (this.processedRequestIds.has(req.requestId)) {
      return this.buildErrorResponse(
        req.type,
        req.requestId,
        'DUPLICATE_REQUEST_ID',
        `Request "${req.requestId}" was already processed`
      );
    }

    this.inFlightRequestIds.add(req.requestId);
    try {
      const data = await this.dispatchRequest(req.type, req.sessionId, req.payload);
      const response = ResponseMessageSchema.parse({
        category: 'response',
        type: req.type,
        requestId: req.requestId,
        ok: true,
        data,
      });
      this.processedRequestIds.set(req.requestId, response);
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes(':') ? msg.split(':')[0] : 'REQUEST_FAILED';
      const errResp = this.buildErrorResponse(req.type, req.requestId, code, msg);
      this.processedRequestIds.set(req.requestId, errResp);
      return errResp;
    } finally {
      this.inFlightRequestIds.delete(req.requestId);
    }
  }

  private async dispatchRequest(
    type: string,
    sessionId: string | undefined,
    payload: Record<string, unknown>
  ): Promise<unknown> {
    switch (type) {
      case 'session.create': {
        const { provider, model } = await this.providerManager.getActiveProviderWithKeyStatus();
        const apiKey = await this.providerManager.resolveApiKey(
          (payload.providerId as string | undefined) ?? provider.providerId
        );
        return this.sessionBridge.createSession({
          title: payload.title as string | undefined,
          prompt: payload.prompt as string | undefined,
          workspaceRoot: (payload.workspaceRoot as string | undefined) ?? this.workspaceRoot,
          providerId: (payload.providerId as string | undefined) ?? provider.providerId,
          modelId: (payload.modelId as string | undefined) ?? model.modelId,
          apiKey,
          executionMode: (payload.executionMode as AgentExecutionMode | undefined) ?? 'auto',
        });
      }

      case 'session.list': {
        return this.sessionBridge.listSessions();
      }

      case 'session.resume': {
        const targetId = sessionId ?? (payload.sessionId as string);
        const lastSequence = typeof payload.lastSequence === 'number' ? payload.lastSequence : 0;
        return this.sessionBridge.resumeSession(targetId, lastSequence);
      }

      case 'session.send': {
        const targetId = sessionId ?? (payload.sessionId as string);
        const prompt = String(payload.prompt ?? '');
        const executionMode = payload.executionMode as AgentExecutionMode | undefined;
        const modelId =
          typeof payload.modelId === 'string' && payload.modelId.trim()
            ? payload.modelId.trim()
            : undefined;
        const workspaceRoot =
          (payload.workspaceRoot as string | undefined) ?? this.workspaceRoot;
        return this.sessionBridge.sendPrompt({
          sessionId: targetId,
          prompt,
          workspaceRoot,
          executionMode,
          modelId,
        });
      }

      case 'session.cancel': {
        const targetId = sessionId ?? (payload.sessionId as string);
        return this.sessionBridge.cancelSession(targetId, payload.reason as string | undefined);
      }

      case 'session.delete': {
        const targetId = sessionId ?? (payload.sessionId as string);
        return { deleted: await this.sessionBridge.deleteSession(targetId) };
      }

      case 'approval.respond': {
        const approvalId = String(payload.approvalId ?? '');
        const approved = Boolean(payload.approved);
        const reason = payload.reason as string | undefined;
        return this.approvalBridge.respond(approvalId, approved, reason);
      }

      case 'diff.review': {
        const targetId = sessionId ?? (payload.sessionId as string);
        const diffId = String(payload.diffId ?? '');
        const action = payload.action as 'accept' | 'reject' | 'revise';
        const feedback = payload.feedback as string | undefined;
        return this.sessionBridge.reviewDiff({
          sessionId: targetId,
          diffId,
          action,
          feedback,
        });
      }

      case 'provider.get': {
        const active = await this.providerManager.getActiveProviderWithKeyStatus();
        return {
          active,
          providers: this.providerManager.listProviders(),
        };
      }

      case 'provider.update': {
        const updated = await this.providerManager.configureProvider({
          providerId: String(payload.providerId ?? 'deepseek'),
          apiEndpoint: payload.apiEndpoint as string | undefined,
          modelId: payload.modelId as string | undefined,
          apiKey: payload.apiKey as string | undefined,
        });
        const active = await this.providerManager.getActiveProviderWithKeyStatus();
        return { updated, active };
      }

      case 'provider.test': {
        return this.providerManager.runSmokeTest({
          providerId: payload.providerId as string | undefined,
          modelId: payload.modelId as string | undefined,
        });
      }

      case 'backend.status': {
        return {
          diagnostics: this.backendManager.getDiagnostics(),
          sdkVerification: await RuntimeFactory.verifyLockedSdk(),
          resources: this.resourceManager.getStats(),
        };
      }

      case 'backend.switch': {
        const mode = payload.mode as BackendMode;
        const hubEndpoint = payload.hubEndpoint as string | undefined;
        const diag = await this.backendManager.resolveBackend(mode, hubEndpoint);
        await this.initializeRuntime(mode);
        if (sessionId) {
          this.eventBridge.emit(sessionId, 'backend.state.changed', { ...diag });
        }
        return diag;
      }

      case 'capability.invoke': {
        const capability = payload.capability as CapabilityName;
        const params = payload.params ?? {};
        const executionMode = (payload.executionMode as AgentExecutionMode | undefined) ?? 'auto';
        return this.capabilityRegistry.invoke(capability, params, {
          sessionId: sessionId ?? 'direct_cap',
          workspaceRoot: this.workspaceRoot,
          executionMode,
        });
      }

      case 'diagnostics.export': {
        // Section 9.1: Export redacted diagnostic bundle with explicit scope explanation
        const activeProvider = await this.providerManager.getActiveProviderWithKeyStatus();
        return sanitizeObjectForLog({
          exportedAt: new Date().toISOString(),
          privacyNotice:
            'All API Keys, tokens, environment secrets, and raw file contents have been automatically redacted.',
          backend: this.backendManager.getDiagnostics(),
          sdk: await RuntimeFactory.verifyLockedSdk(),
          activeProvider: {
            providerId: activeProvider.provider.providerId,
            modelId: activeProvider.model.modelId,
            apiEndpoint: activeProvider.provider.apiEndpoint,
            hasApiKeyConfigured: activeProvider.hasApiKeyConfigured,
          },
          resources: this.resourceManager.getStats(),
          capabilityAuditTrail: this.capabilityRegistry.getAuditLog(sessionId),
        });
      }

      default:
        throw new Error(`UNKNOWN_REQUEST_TYPE: "${type}"`);
    }
  }

  private buildErrorResponse(
    type: string,
    requestId: string,
    code: string,
    message: string
  ): ResponseMessage {
    return ResponseMessageSchema.parse({
      category: 'response',
      type,
      requestId,
      ok: false,
      error: {
        code,
        message,
      },
    });
  }

  async dispose(): Promise<void> {
    this.approvalBridge.dispose();
    this.eventBridge.dispose();
    await this.resourceManager.disposeAll();
  }
}

