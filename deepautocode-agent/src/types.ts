import { z } from 'zod';

/**
 * Section 5.1 & 5.2: Runtime Backend Modes
 */
export type BackendMode = 'local' | 'auto' | 'hub' | 'remote';

/**
 * Section 9.2: Agent Execution Modes
 * - plan: Strictly read-only; mutating tools/commands are blocked.
 * - auto: Low-risk allowlisted operations auto-approved; high-risk require explicit approval.
 * - manual: All file mutations and command executions require explicit user approval.
 */
export type AgentExecutionMode = 'plan' | 'auto' | 'manual';

/**
 * Risk levels for tool calls and approvals
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Section 6.2: Message Protocol Schemas (Webview <-> Extension Host <-> Agent Bridge)
 * Webview never depends on internal @cline/sdk types directly.
 */
export const RequestMessageSchema = z.object({
  category: z.literal('request'),
  type: z.enum([
    'session.create',
    'session.list',
    'session.resume',
    'session.send',
    'session.cancel',
    'session.delete',
    'approval.respond',
    'diff.review',
    'provider.get',
    'provider.update',
    'provider.test',
    'backend.status',
    'backend.switch',
    'capability.invoke',
    'extensions.check',
    'diagnostics.export',
  ]),
  requestId: z.string().min(1),
  sessionId: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
});

export type RequestMessage = z.infer<typeof RequestMessageSchema>;

export const ResponseMessageSchema = z.object({
  category: z.literal('response'),
  type: z.string().min(1),
  requestId: z.string().min(1),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
});

export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;

export const EventMessageSchema = z.object({
  category: z.literal('event'),
  type: z.enum([
    'assistant.text.delta',
    'assistant.text.done',
    'tool.call.started',
    'tool.call.completed',
    'tool.call.failed',
    'approval.requested',
    'approval.resolved',
    'diff.proposed',
    'diff.updated',
    'session.state.changed',
    'backend.state.changed',
    'runtime.error',
  ]),
  sessionId: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
  payload: z.record(z.unknown()),
});

export type EventMessage = z.infer<typeof EventMessageSchema>;

export const ApprovalRequestPayloadSchema = z.object({
  approvalId: z.string().min(1),
  sessionId: z.string().min(1),
  toolName: z.string().min(1),
  summary: z.string().min(1),
  targetPath: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  expiresAt: z.string(),
  arguments: z.record(z.unknown()).default({}),
});

export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestPayloadSchema>;

export const CancelRequestSchema = z.object({
  category: z.literal('cancel'),
  requestId: z.string().optional(),
  sessionId: z.string().min(1),
  reason: z.string().optional(),
});

export type CancelRequest = z.infer<typeof CancelRequestSchema>;

export const ResumeRequestSchema = z.object({
  category: z.literal('resume'),
  sessionId: z.string().min(1),
  lastSequence: z.number().int().nonnegative().default(0),
  cursor: z.string().optional(),
});

export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

/**
 * Session & Message models for persistence (PoC-L1 & PoC-L2)
 */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending_approval' | 'running' | 'completed' | 'rejected' | 'failed' | 'cancelled';
  risk: RiskLevel;
  approvalId?: string;
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface DiffChangeRecord {
  diffId: string;
  sessionId: string;
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  originalContent: string;
  proposedContent: string;
  unifiedDiff: string;
  status: 'pending' | 'accepted' | 'rejected' | 'revising';
  feedback?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  sequence: number;
  timestamp: string;
  toolCalls?: ToolCallRecord[];
  diffIds?: string[];
}

export interface SessionManifest {
  sessionId: string;
  title: string;
  workspaceRoot: string;
  providerId: string;
  modelId: string;
  backendMode: BackendMode;
  executionMode: AgentExecutionMode;
  status: 'idle' | 'running' | 'awaiting_approval' | 'cancelled' | 'error' | 'completed';
  createdAt: string;
  updatedAt: string;
  lastSequence: number;
  sdkManaged: boolean;
  storagePath?: string;
}

/**
 * Appendix B: Capability Definitions & Code - OSS API Mapping Metadata
 */
export type CapabilityName =
  | 'open-file'
  | 'reveal-diff'
  | 'run-build'
  | 'read-file'
  | 'write-file';

export interface CapabilityDefinition<TInput = unknown, TOutput = unknown> {
  name: CapabilityName;
  description: string;
  caller: 'agent-runtime' | 'hub' | 'extension-host';
  executor: 'ide-client';
  codeOssApi: string;
  requiresApprovalByDefault: boolean;
  allowedInPlanMode: boolean;
  defaultTimeoutMs: number;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  auditFields: string[];
}

export interface CapabilityExecutionContext {
  sessionId: string;
  workspaceRoot: string;
  executionMode: AgentExecutionMode;
  signal?: AbortSignal;
}

export interface CapabilityAuditEntry {
  auditId: string;
  timestamp: string;
  sessionId: string;
  capability: CapabilityName;
  caller: string;
  sanitizedParams: Record<string, unknown>;
  approved: boolean;
  approvalId?: string;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
}

