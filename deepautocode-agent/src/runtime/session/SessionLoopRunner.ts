import dns from 'node:dns';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const dnsCache = new Map<string, { address: string; expiresAt: number }>();

function cachedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
) {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > now) {
    if ((options as any)?.all) {
      callback(null, [{ address: cached.address, family: 4 }]);
    } else {
      callback(null, cached.address, 4);
    }
    return;
  }
  dns.lookup(hostname, { family: 4 }, (err, address, family) => {
    if (!err && typeof address === 'string') {
      dnsCache.set(hostname, { address, expiresAt: Date.now() + 5 * 60 * 1000 });
      if ((options as any)?.all) {
        callback(null, [{ address, family: family || 4 }]);
        return;
      }
    }
    callback(err, address as any, family);
  });
}

async function postJsonOnce(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; text: string }> {
  const parsedUrl = new URL(params.url);
  const isHttps = parsedUrl.protocol === 'https:';
  const payload = JSON.stringify(params.body);
  const timeoutMs = params.timeoutMs ?? 60000;

  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new Error('CAPABILITY_CANCELLED: Request aborted'));
      return;
    }

    const reqFn = isHttps ? https.request : http.request;
    const req = reqFn(
      parsedUrl,
      {
        method: 'POST',
        agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
        family: 4,
        lookup:
          parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost'
            ? undefined
            : (cachedLookup as any),
        headers: {
          ...params.headers,
          'Content-Length': String(Buffer.byteLength(payload, 'utf-8')),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 500;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text,
          });
        });
      }
    );

    const onAbort = () => {
      req.destroy(new Error('CAPABILITY_CANCELLED: Request aborted'));
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      params.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    req.on('close', () => {
      params.signal?.removeEventListener('abort', onAbort);
    });

    req.write(payload);
    req.end();
  });
}

async function postJsonResilient(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; text: string }> {
  const parsedUrl = new URL(params.url);
  const isPrivateLan = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(
    parsedUrl.hostname
  );
  if (
    isPrivateLan &&
    (sshRelayLanHosts.has(parsedUrl.host) || shouldUseSshRelayForLanHost(parsedUrl.hostname))
  ) {
    return postJsonViaSshRelay({
      url: params.url,
      headers: params.headers,
      bodyStr: JSON.stringify(params.body),
      timeoutMs: params.timeoutMs,
    });
  }

  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await postJsonOnce(params);
      if ((res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429) && attempt < maxAttempts && !params.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransientSocketErr =
        /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|EAI_AGAIN|ENOTFOUND|network/i.test(msg);
      if (isPrivateLan && isTransientSocketErr && !params.signal?.aborted) {
        try {
          const relayed = await postJsonViaSshRelay({
            url: params.url,
            headers: params.headers,
            bodyStr: JSON.stringify(params.body),
            timeoutMs: params.timeoutMs,
          });
          sshRelayLanHosts.add(parsedUrl.host);
          return relayed;
        } catch {
          // continue to standard retry if SSH relay is unavailable
        }
      }
      if (isTransientSocketErr && attempt < maxAttempts && !params.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
import type {
  AgentExecutionMode,
  CapabilityName,
  SessionManifest,
  ToolCallRecord,
} from '../../types.js';
import type { ClineRuntimeEvent } from '../RuntimeFactory.js';
import { globalTaskTraceStore } from '../../core/trace/TaskTrace.js';
import {
  DEEPSEEK_FLASH,
  buildDeepSeekRequestControls,
  deepSeekChatBodyExtras,
  estimateDeepSeekTurnCostCny,
  extractDeepSeekCacheUsage,
  isDeepSeekPeakHour,
  isDeepSeekModelId,
} from '../../core/DeepSeekModels.js';
import { SessionReadCache } from '../../core/AgentLoop.js';
import type { PermissionRuleset } from '../../core/RulePermission.js';
import {
  isLocalOrPrivateEndpoint,
  postJsonViaSshRelay,
  resolveChatCompletionsUrl,
  shouldUseSshRelayForLanHost,
} from '../../../providers/index.js';
import { createUnifiedDiff } from '../tools/FileEditEngine.js';

const sessionReadCaches = new Map<string, SessionReadCache>();
const sshRelayLanHosts = new Set<string>();

export { postJsonOnce, postJsonResilient };

export async function executeLiveLlmAgentLoop(runtimeCtx: any, params: {
  manifest: SessionManifest;
  prompt: string;
  apiKey: string;
  signal: AbortSignal;
  chunks: string[];
  streamText: (text: string) => Promise<void>;
  runCapabilityTool: (
    capability: CapabilityName,
    args: Record<string, unknown>,
    risk?: ToolCallRecord['risk']
  ) => Promise<unknown>;
  diffIds: string[];
  taskId?: string;
  onCircuitTriggered?: () => void;
  emitTraceUpdated?: (event: unknown) => void;
  policyGate?: {
    executionMode: AgentExecutionMode;
    permissionRuleset: PermissionRuleset;
  };
  images?: Array<{ name?: string; dataUrl: string; mimeType?: string }>;
}): Promise<{ content: string }> {
  const {
    manifest,
    prompt,
    apiKey,
    signal,
    chunks,
    streamText,
    runCapabilityTool,
    diffIds,
    taskId,
    onCircuitTriggered,
    emitTraceUpdated,
    policyGate,
    images,
  } = params;
  const sessionId = manifest.sessionId;
  const provider =
    typeof runtimeCtx.providerManager.getProviderById === 'function'
      ? runtimeCtx.providerManager.getProviderById(manifest.providerId)
      : runtimeCtx.providerManager.getActiveProvider().provider;
  const endpoint = resolveChatCompletionsUrl(provider.apiEndpoint);
  const isSshMirrorWorkspace = manifest.workspaceRoot.includes('ssh-mirrors');

  // Build top-level workspace file list for context
  let workspaceFilesHint = '';
  try {
    const topEntries = await fs.readdir(manifest.workspaceRoot, { withFileTypes: true });
    workspaceFilesHint = topEntries
      .filter((e) => !['node_modules', '.git', 'dist', '.deepautocode-data'].includes(e.name))
      .slice(0, 30)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join(', ');
  } catch {
    workspaceFilesHint = '';
  }

  const sdk = await import('../../core/index.js');
  const {
    Agent,
    createBuiltinTools,
    createTool,
    extractCodeOutline,
    getClineDefaultSystemPrompt,
    generateWorkspaceInfo,
    enrichPromptWithMentions,
    expandSlashCommandPrompt,
    createToolPoliciesWithPreset,
    overlayToolPoliciesWithHardRules,
    FileStateCache,
    WorkspaceFileIndex,
    searchIndexedFiles,
    createGoalState,
    buildGoalContinuationPrompt,
    buildGoalBudgetLimitPrompt,
    isGoalTokenBudgetExceeded,
    DEFAULT_GOAL_TOKEN_BUDGET,
    resolveTieredModelForTurn,
    classifyPromptIntent,
    ensureAgentSandboxBranch,
    rollbackSessionMutations,
    loadVerifyConfig,
    formatVerifyCommandsForPrompt,
    isVerifiableSourcePath,
    parseBuildDiagnostics,
    formatDiagnosticsForPrompt,
    extractFailedTestHints,
    diagnoseTypeScriptFile,
    diagnoseEditedFile,
    attachDiagnosticSnippets,
    loadWorkspaceProblemsText,
    applyPatchToContent,
    applyMultiFilePatch,
    listPatchFiles,
    McpHost,
    loadMcpConfigsFromWorkspace,
    applyStandardToolAliases,
    SessionTodoList,
    runResearchSubagent,
    runPlannerSubagent,
    runEditSubagent,
    createSubagentSandbox,
    runDiagnoseAndVerify,
    loadAgentMemory,
    formatAgentMemoryForPrompt,
    appendAgentMemory,
    digestTextToMemorySummary,
    MAX_SELF_HEAL_ATTEMPTS,
    MAX_VERIFY_NUDGES,
    MistakeTracker,
    LoopDetection,
    getShadowGitCheckpoint,
    discoverHierarchicalRulesForPaths,
    runLifecycleHooks,
    globalBackgroundTaskManager,
    globalQuestionBridge,
    performWebSearch,
    globalSubagentOrchestrator,
    globalScheduleManager,
    globalTranscriptLogger,
    migrateExternalAgentSettings,
    migrateLegacyWorkflowsToSkills,
    searchMarketplace,
    installCatalogPlugin,
    listPluginAccounts,
  } = sdk;
  const selfHealBudget =
    typeof MAX_SELF_HEAL_ATTEMPTS === 'number' ? MAX_SELF_HEAL_ATTEMPTS : 5;
  const verifyNudgeBudget =
    typeof MAX_VERIFY_NUDGES === 'number' ? MAX_VERIFY_NUDGES : 4;

  const verifyConfig =
    typeof loadVerifyConfig === 'function'
      ? await loadVerifyConfig(manifest.workspaceRoot)
      : {
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        combinedCommand: 'npm run build && npm test',
        sourceGlobs: ['**/*.{ts,tsx,js,jsx,c,cc,cpp,h,hpp}'],
        enableEvolveSandbox: true,
        source: 'default' as const,
      };
  const verifyPromptBlock =
    typeof formatVerifyCommandsForPrompt === 'function'
      ? formatVerifyCommandsForPrompt(verifyConfig)
      : `Build: \`${verifyConfig.buildCommand}\`\nTest: \`${verifyConfig.testCommand}\``;
  const preferredVerifyCommand =
    verifyConfig.combinedCommand?.trim() ||
    `${verifyConfig.buildCommand} && ${verifyConfig.testCommand}`;

  const mcpHost = typeof McpHost === 'function' ? new McpHost() : null;
  let mcpBootstrapNote = '';
  let mcpConfigsCached: any[] = [];
  if (mcpHost && typeof loadMcpConfigsFromWorkspace === 'function') {
    try {
      mcpConfigsCached = await loadMcpConfigsFromWorkspace(manifest.workspaceRoot);
      if (mcpConfigsCached.length > 0) {
        await mcpHost.connectAll(mcpConfigsCached, manifest.workspaceRoot);
        const toolsListed = mcpHost.listTools();
        const disabledCount = mcpConfigsCached.reduce(
          (n: number, c: any) => n + (Array.isArray(c.disabledTools) ? c.disabledTools.length : 0),
          0
        );
        mcpBootstrapNote =
          toolsListed.length > 0
            ? `Connected MCP tools: ${toolsListed
              .slice(0, 24)
              .map((t: any) => t.qualifiedName)
              .join(', ')}${toolsListed.length > 24 ? '…' : ''}${disabledCount ? ` (${disabledCount} disabled)` : ''
            }`
            : mcpHost.getLastError() || 'MCP configs found but no tools connected.';
      }
    } catch (err) {
      mcpBootstrapNote = `MCP bootstrap failed: ${(err as Error).message || String(err)}`;
    }
  }

  const slashExpanded =
    typeof expandSlashCommandPrompt === 'function'
      ? expandSlashCommandPrompt(prompt)
      : { expandedPrompt: prompt };
  const basePromptForTurn = slashExpanded.expandedPrompt || prompt;

  const fileStateCache = new FileStateCache();
  const workspaceFileIndex =
    typeof WorkspaceFileIndex === 'function'
      ? new WorkspaceFileIndex(manifest.workspaceRoot, { ttlMs: 30_000, maxFiles: 12_000 })
      : null;
  // Warm the path index in the background so the first search_codebase is faster.
  void workspaceFileIndex?.ensureFresh().catch(() => undefined);
  const activeGoal = createGoalState(
    basePromptForTurn,
    typeof DEFAULT_GOAL_TOKEN_BUDGET === 'number' ? DEFAULT_GOAL_TOKEN_BUDGET : 180_000
  );
  let budgetLimitNotified = false;
  const promptIntent = classifyPromptIntent(basePromptForTurn);
  const isReadOnlyTurn =
    slashExpanded.suggestedMode === 'plan' ||
    manifest.executionMode === 'plan' ||
    (!promptIntent.allowFileMutations && slashExpanded.suggestedMode !== 'auto');
  // Hard Plan/readonly: CapabilityRegistry must see executionMode=plan even when
  // manifest stays auto (intent-classified read-only turns).
  if (policyGate && isReadOnlyTurn) {
    policyGate.executionMode = 'plan';
  }

  // 0. Reuse @cline/sdk native workspace metadata & @file mention enricher
  let workspaceInfo: any = { rootPath: manifest.workspaceRoot, hint: path.basename(manifest.workspaceRoot) };
  try {
    if (typeof generateWorkspaceInfo === 'function') {
      workspaceInfo = await generateWorkspaceInfo(manifest.workspaceRoot);
    }
  } catch {
    // fallback to basic workspaceInfo
  }

  let effectivePrompt = basePromptForTurn;
  try {
    if (typeof enrichPromptWithMentions === 'function' && basePromptForTurn.includes('@')) {
      const enriched = await enrichPromptWithMentions(basePromptForTurn, manifest.workspaceRoot, {
        maxFiles: 5,
        maxFileBytes: 32000,
      });
      if (enriched?.prompt) {
        effectivePrompt = enriched.prompt;
      }
    }
  } catch {
    effectivePrompt = basePromptForTurn;
  }

  // Zero-Roundtrip Auto-Prefetch: If the user's prompt mentions specific source files (e.g. src/enqueue.cc:782-811),
  // pre-read up to 3 referenced files in parallel BEFORE Turn 1 so the LLM skips 1-3 exploratory tool round-trips.
  try {
    const promptTokens = prompt.split(/[\s,;()[\]{}<>"'`，；。（）【】「」|]+/);
    const seenPrefetchPaths = new Set<string>();
    const prefetchTargets: Array<{ relPath: string; startLine?: number; endLine?: number }> = [];

    for (const tok of promptTokens) {
      if (!tok || !tok.includes('.') || /^https?:\/\//i.test(tok)) continue;
      const m = tok.match(
        /^([a-zA-Z0-9_./-]+\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|py|ts|tsx|js|jsx|go|rs|java|sh|cmake))(?::(\d+)(?:[-:](\d+))?)?$/i
      );
      if (!m) continue;
      const relPath = runtimeCtx.normalizeWorkspaceRelativePath(m[1], manifest.workspaceRoot);
      if (!relPath || relPath.startsWith('..') || seenPrefetchPaths.has(relPath)) continue;
      seenPrefetchPaths.add(relPath);
      prefetchTargets.push({
        relPath,
        startLine: m[2] ? Number(m[2]) : undefined,
        endLine: m[3] ? Number(m[3]) : undefined,
      });
      if (prefetchTargets.length >= 3) break;
    }

    if (prefetchTargets.length > 0) {
      const prefetchedSnippets = await Promise.all(
        prefetchTargets.map(async (target) => {
          try {
            const absPath = path.resolve(manifest.workspaceRoot, target.relPath);
            const rawText = await fs.readFile(absPath, 'utf-8');
            const allLines = rawText.split(/\r?\n/);
            const sLine = target.startLine ? Math.max(1, target.startLine - 35) : 1;
            const eLine = target.endLine
              ? Math.min(allLines.length, target.endLine + 45)
              : target.startLine
                ? Math.min(allLines.length, target.startLine + 65)
                : Math.min(allLines.length, 160);
            const numbered = allLines
              .slice(sLine - 1, eLine)
              .map((l, idx) => `${sLine + idx}: ${l}`)
              .join('\n');
            fileStateCache.recordRead({
              filePath: target.relPath,
              content: rawText,
              startLine: sLine,
              endLine: eLine,
            });
            return `\n--- [Pre-fetched File: ${target.relPath} (lines ${sLine}-${eLine} of ${allLines.length})] ---\n${numbered}`;
          } catch {
            return '';
          }
        })
      );
      const validSnippets = prefetchedSnippets.filter((s) => s.length > 0);
      if (validSnippets.length > 0) {
        effectivePrompt = `${effectivePrompt}\n\n[Auto-Prefetched Workspace Files — Already loaded in context, no need to re-read these same line ranges:]${validSnippets.join('\n')}`;
      }
      if (typeof discoverHierarchicalRulesForPaths === 'function') {
        const subRules = await discoverHierarchicalRulesForPaths(
          manifest.workspaceRoot,
          prefetchTargets.map((t) => t.relPath)
        );
        if (subRules) {
          effectivePrompt = `${effectivePrompt}\n\n${subRules}`;
        }
      }
    }
  } catch {
    // ignore prefetch errors
  }

  if (Array.isArray(images) && images.length > 0) {
    effectivePrompt = `${effectivePrompt}\n\n[Attached User Images (${images.length}): ${images
      .map((img, i) => img.name || `image_${i + 1}`)
      .join(', ')}]`;
  }

  if (globalSubagentOrchestrator) {
    await globalSubagentOrchestrator
      .loadWorkspaceSubagents(manifest.workspaceRoot)
      .catch(() => []);
    const wakeupBlock = globalSubagentOrchestrator.drainWakeupMessagesForPrompt(sessionId);
    if (wakeupBlock) {
      effectivePrompt = `${wakeupBlock}\n\n${effectivePrompt}`;
    }
  }

  const sessionWrittenFiles: string[] = [];
  const sessionOriginalContents = new Map<string, string>();
  const sessionCreatedFiles = new Set<string>();
  const readCountsByRange = new Map<string, number>();
  const executedCommandCounts = new Map<string, number>();
  let hasUnverifiedCompiledEdit = false;
  let hasUnverifiedTestAfterEdit = false;
  let lastBuildOrTestFailed = false;
  let lastSemanticFailed = false;
  let lastSemanticDiagSnippet = '';
  let lastFailureOutputSnippet = '';
  let lastFailedTestHints: string[] = [];
  let selfHealCount = 0;
  let verifyNudgeCount = 0;
  let autoContinuationCount = 0;
  let editMismatchCount = 0;
  let lastVerifierPass: boolean | null = null;
  let sandboxBranchEnsured = false;
  let circuitBroken = false;
  let circuitBreakerNotified = false;
  const mistakeTracker =
    typeof MistakeTracker === 'function' ? new MistakeTracker() : null;
  const loopDetection =
    typeof LoopDetection === 'function' ? new LoopDetection() : null;
  let shadowCheckpointCount = 0;
  const sessionTodos =
    typeof SessionTodoList === 'function' ? new SessionTodoList() : null;

  const persistSessionArtifact = async (params: {
    artifactType: 'plan' | 'task_list' | 'walkthrough' | 'report';
    title: string;
    content: string;
    source?: string;
  }): Promise<{ artifactId: string; artifactType: string; title: string }> => {
    const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const artifactsDir = path.join(runtimeCtx.storageDir, '..', 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    const artifactRecord = {
      id: artifactId,
      sessionId,
      artifactType: params.artifactType,
      title: params.title,
      content: params.content,
      workspaceRoot: manifest.workspaceRoot,
      source: params.source || 'agent',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(artifactsDir, `${artifactId}.json`),
      JSON.stringify(artifactRecord, null, 2),
      'utf-8'
    );
    runtimeCtx.emit({
      type: 'artifact_created',
      sessionId,
      payload: {
        artifactId,
        artifactType: params.artifactType,
        title: params.title,
        source: params.source || 'agent',
      },
    });
    return {
      artifactId,
      artifactType: params.artifactType,
      title: params.title,
    };
  };

  const hasTestTargetInContext =
    /(?:_perf\b|nccl-test\b|\btests?\b|\bctest\b|\bpytest\b|测试)/i.test(
      `${workspaceFilesHint} ${prompt}`
    );

  const ensureSandboxOnce = async () => {
    if (
      sandboxBranchEnsured ||
      manifest.executionMode === 'manual' ||
      isReadOnlyTurn ||
      verifyConfig.enableEvolveSandbox === false
    ) {
      return;
    }
    sandboxBranchEnsured = true;
    if (typeof ensureAgentSandboxBranch === 'function') {
      const sandbox = await ensureAgentSandboxBranch(manifest.workspaceRoot).catch(() => null);
      if (sandbox?.enabled && sandbox.branch) {
        runtimeCtx.emit({
          type: 'sandbox_branch_created',
          sessionId,
          payload: {
            branch: sandbox.branch,
            previousBranch: sandbox.previousBranch,
            message: sandbox.message,
          },
        });
      }
    }
  };

  const trackOriginalForRollback = (
    filePath: string,
    originalContent: string,
    operation: 'create' | 'modify'
  ) => {
    if (operation === 'create') {
      sessionCreatedFiles.add(filePath);
      return;
    }
    if (!sessionOriginalContents.has(filePath)) {
      sessionOriginalContents.set(filePath, originalContent);
    }
  };

  const applyFileEdit = (targetFile: string, proposedContent: string) => {
    if (circuitBroken) {
      return Promise.reject(
        new Error(
          'CIRCUIT_BREAKER_ACTIVE: Session mutations were rolled back after repeated verification failures. Do not edit files further; summarize the failure instead.'
        )
      );
    }
    return runtimeCtx.proposeAndApplyFileEdit({
      sessionId,
      manifest,
      targetFile,
      proposedContent,
      signal,
      runCapabilityTool,
      diffIds,
      // Always write after policy/approval: Manual hits ApprovalBridge; Auto writes directly.
      applyImmediately: true,
      onBeforeFirstMutation: ensureSandboxOnce,
      trackOriginal: trackOriginalForRollback,
    });
  };

  const recordCompiledFileEdit = (filePath: string) => {
    sessionWrittenFiles.push(filePath);
    executedCommandCounts.clear();
    const normKeyPrefix = `${filePath}:`;
    for (const k of Array.from(readCountsByRange.keys())) {
      if (k.startsWith(normKeyPrefix)) {
        readCountsByRange.delete(k);
      }
    }
    const needsVerify =
      typeof isVerifiableSourcePath === 'function'
        ? isVerifiableSourcePath(filePath, verifyConfig)
        : /\.(?:c|cc|cpp|cu|h|hpp|ts|tsx|js|jsx|py|go|rs)$/i.test(filePath);
    if (needsVerify) {
      hasUnverifiedCompiledEdit = true;
      if (hasTestTargetInContext || Boolean(verifyConfig.testCommand)) {
        hasUnverifiedTestAfterEdit = true;
      }
    }
  };

  const recordCommandOutcome = (cmd: string, res: { exitCode: number; stdout?: string; stderr?: string }) => {
    const combinedOut = `${res.stdout || ''}\n${res.stderr || ''}`;
    const isBuildCmd =
      /\b(?:make|cmake|ninja|gcc|g\+\+|hipcc|nvcc|cargo\s+build|go\s+build|npm\s+run\s+(?:build|typecheck)|tsc|py_compile|compileall|pyinstaller|dotnet\s+build|javac|mvn|gradle)\b/i.test(
        cmd
      );
    const isTestCmd =
      /(?:_perf\b|\bctest\b|\bpytest\b|\bvitest\b|\bnpm\s+test\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bpython3?\s+(?:-m\s+unittest\b|[^\s;|&]*test[^\s;|&]*\.py\b)|\bverify-[a-z0-9_.-]+|\.\/(?:build\/)?[a-z0-9_]+_perf\b)/i.test(
        cmd
      );
    if (!isBuildCmd && !isTestCmd) {
      return;
    }
    const hasRuntimeOrCompileFailure =
      res.exitCode !== 0 ||
      /(?:Test NCCL failure|# Out of bounds values\s*:\s*[1-9]\d*\s+FAILED|\bfatal error:|\berror:\s+[^\n]+|\bSegmentation fault\b|\bAborted\s*\(core dumped\))/i.test(
        combinedOut
      );
    if (isBuildCmd && !hasRuntimeOrCompileFailure) {
      hasUnverifiedCompiledEdit = false;
    }
    if (isTestCmd) {
      hasUnverifiedCompiledEdit = false;
      hasUnverifiedTestAfterEdit = false;
    }
    lastBuildOrTestFailed = hasRuntimeOrCompileFailure;
    if (hasRuntimeOrCompileFailure) {
      activeGoal.consecutiveBlockedTurns += 1;
      lastFailureOutputSnippet = combinedOut.trim().slice(-1200);
      lastFailedTestHints =
        typeof extractFailedTestHints === 'function'
          ? extractFailedTestHints(combinedOut, 6)
          : [];
      sessionTodos?.ensureVerifyTodo(preferredVerifyCommand);
      mistakeTracker?.recordMistake('verify_fail', cmd.slice(0, 120));
    } else {
      activeGoal.consecutiveBlockedTurns = 0;
      activeGoal.verifiedByCommand = true;
      lastFailureOutputSnippet = '';
      lastFailedTestHints = [];
      lastSemanticFailed = false;
      lastSemanticDiagSnippet = '';
      sessionTodos?.completeMatching((c) => /verify|test|build|编译|测试|验证/i.test(c));
      mistakeTracker?.recordSuccess();
      // DS-P3: shadow-git step checkpoint only after verify pass
      void (async () => {
        try {
          if (typeof getShadowGitCheckpoint !== 'function') return;
          const shadow = getShadowGitCheckpoint(manifest.workspaceRoot);
          shadowCheckpointCount += 1;
          const label = `verify-pass #${shadowCheckpointCount} · ${isBuildCmd ? 'build' : 'test'
            } · ${cmd.slice(0, 80)}`;
          const ckpt = await shadow.create(label);
          const signalEvt = globalTaskTraceStore.recordSignal?.({
            workspaceRoot: manifest.workspaceRoot,
            sessionId,
            taskId,
            signal: 'checkpoint',
            summary: ckpt.ok
              ? `shadow-git ${ckpt.skipped ? 'unchanged' : 'commit'} ${ckpt.commit?.slice(0, 8) || ''} · ${label}`
              : `shadow-git failed: ${ckpt.reason || 'unknown'}`,
            detail: { commit: ckpt.commit, skipped: ckpt.skipped, ok: ckpt.ok },
          });
          if (signalEvt) emitTraceUpdated?.(signalEvt);
          runtimeCtx.emit({
            type: 'checkpoint_created',
            sessionId,
            payload: {
              kind: 'shadow-git',
              ok: ckpt.ok,
              skipped: ckpt.skipped,
              commit: ckpt.commit,
              message: label,
              reason: ckpt.reason,
            },
          });
        } catch {
          // non-fatal
        }
      })();
    }
    const verifyEvt = globalTaskTraceStore.recordVerify({
      workspaceRoot: manifest.workspaceRoot,
      sessionId,
      taskId,
      passed: !hasRuntimeOrCompileFailure,
      summary: `${isBuildCmd ? 'build' : 'test'} exit=${res.exitCode} · ${cmd}`,
    });
    if (verifyEvt) emitTraceUpdated?.(verifyEvt);
  };

  const runPostEditDiagnostics = async (
    filePath: string,
    content: string
  ): Promise<{
    diagnostics?: unknown[];
    semanticErrors?: string;
    mandatoryFixHint?: string;
    workspaceProblems?: string;
  }> => {
    const diagnose =
      typeof diagnoseEditedFile === 'function'
        ? diagnoseEditedFile
        : typeof diagnoseTypeScriptFile === 'function'
          ? async (p: {
            workspaceRoot: string;
            filePath: string;
            content: string;
          }) => diagnoseTypeScriptFile(p)
          : null;

    let workspaceProblems = '';
    if (typeof runLifecycleHooks === 'function') {
      try {
        const hookRes = await runLifecycleHooks({
          workspaceRoot: manifest.workspaceRoot,
          event: 'postFileEdit',
          sessionId,
          filePath,
        });
        if (hookRes.feedbackMessage) {
          workspaceProblems = hookRes.feedbackMessage;
        }
      } catch {
        // ignore lifecycle hook error
      }
    }
    if (typeof loadWorkspaceProblemsText === 'function') {
      try {
        const all = await loadWorkspaceProblemsText(manifest.workspaceRoot, 60);
        const norm = filePath.replace(/\\/g, '/');
        const base = path.basename(norm);
        const matchedProblems = all
          .split('\n')
          .filter((line) => {
            const l = line.replace(/\\/g, '/');
            return l.includes(norm) || l.includes(`/${base}:`) || l.includes(`${base}:`);
          })
          .slice(0, 20)
          .join('\n');
        if (matchedProblems) {
          workspaceProblems = workspaceProblems
            ? `${workspaceProblems}\n${matchedProblems}`
            : matchedProblems;
        }
      } catch {
        // ignore
      }
    }

    if (!diagnose) {
      if (workspaceProblems) {
        lastSemanticFailed = true;
        lastSemanticDiagSnippet = workspaceProblems.slice(0, 3500);
        return {
          workspaceProblems,
          semanticErrors: lastSemanticDiagSnippet,
          mandatoryFixHint:
            'WORKSPACE_PROBLEMS: Fix Problems-panel diagnostics for this file via edit_file/apply_patch, then re-verify.',
        };
      }
      return {};
    }
    try {
      const diags = await diagnose({
        workspaceRoot: manifest.workspaceRoot,
        filePath,
        content,
      });
      const errors = (diags || []).filter((d: { severity: string }) => d.severity === 'error');
      if (errors.length === 0 && !workspaceProblems) {
        lastSemanticFailed = false;
        lastSemanticDiagSnippet = '';
        return { diagnostics: diags, workspaceProblems: '' };
      }
      if (errors.length === 0 && workspaceProblems) {
        lastSemanticFailed = true;
        lastSemanticDiagSnippet = workspaceProblems.slice(0, 3500);
        return {
          diagnostics: diags,
          workspaceProblems,
          semanticErrors: lastSemanticDiagSnippet,
          mandatoryFixHint:
            'WORKSPACE_PROBLEMS: IDE/build Problems remain for this file. Fix them before claiming success.',
        };
      }
      lastSemanticFailed = true;
      const formatted =
        typeof formatDiagnosticsForPrompt === 'function'
          ? formatDiagnosticsForPrompt(errors, 20)
          : errors
            .map(
              (d: { severity: string; file: string; line: number; message: string }) =>
                `${d.severity} ${d.file}:${d.line} ${d.message}`
            )
            .join('\n');
      const snippets =
        typeof attachDiagnosticSnippets === 'function'
          ? attachDiagnosticSnippets(content, errors, 2)
          : '';
      const merged = `${formatted}${snippets ? `\n${snippets}` : ''}${workspaceProblems ? `\n\n[Workspace Problems for file]\n${workspaceProblems}` : ''
        }`;
      lastSemanticDiagSnippet = merged.slice(0, 3500);
      return {
        diagnostics: errors,
        workspaceProblems: workspaceProblems || undefined,
        semanticErrors: lastSemanticDiagSnippet,
        mandatoryFixHint:
          'SEMANTIC_DIAGNOSTICS_FAILED: Fix the language diagnostics above via edit_file or apply_patch before claiming success. Prefer fixing types/imports/syntax, then re-run verify.',
      };
    } catch {
      return workspaceProblems
        ? {
          workspaceProblems,
          semanticErrors: workspaceProblems.slice(0, 3500),
          mandatoryFixHint: 'WORKSPACE_PROBLEMS: Fix Problems-panel diagnostics, then re-verify.',
        }
        : {};
    }
  };

  const fullReadExpandedFiles = new Set<string>();
  const autoExpandPartialSedRead = async (cmd: string, stdout: string): Promise<string> => {
    const sedMatch = cmd.match(/\bsed\s+-n\s+['"]?(\d+)\s*,\s*(\d+)p['"]?\s+([^\s;|&>'"]+)/);
    if (!sedMatch) {
      return stdout;
    }
    const endLine = Number(sedMatch[2]);
    const rawTargetFile = sedMatch[3];
    if (!endLine || !rawTargetFile) {
      return stdout;
    }
    try {
      const relFile = runtimeCtx.normalizeWorkspaceRelativePath(rawTargetFile, manifest.workspaceRoot);
      if (fullReadExpandedFiles.has(relFile)) {
        return `[DUPLICATE_FILE_SLICE_NOTICE]: Complete file '${relFile}' was already returned in full earlier in this turn. Do NOT run additional sed/cat commands on '${relFile}'; proceed directly to edit_file / write_file or compile/test!`;
      }
      const absFile = path.resolve(manifest.workspaceRoot, relFile);
      let fileContent = await fs.readFile(absFile, 'utf-8').catch(() => '');
      if (!fileContent.trim()) {
        const pulled = (await runtimeCtx.capabilityRegistry.invoke(
          'read-file',
          { filePath: relFile },
          {
            sessionId,
            workspaceRoot: manifest.workspaceRoot,
            executionMode: 'plan',
            signal,
          }
        )) as { content: string };
        fileContent = pulled?.content || '';
      }
      const allLines = fileContent.split(/\r?\n/);
      if (allLines.length > 1 && allLines.length <= 400) {
        fullReadExpandedFiles.add(relFile);
        const numberedFull = allLines.map((line, idx) => `${idx + 1}: ${line}`).join('\n');
        return `/* [DeepAutoCode Function-Completeness Auto-Expand (Full-File Auto-Read): '${relFile}' has ${allLines.length} lines total. Returning the ENTIRE file (1..${allLines.length}) below so you do not miss #if 0 blocks or tail logic — do NOT run any more sed/grep slices on '${relFile}'!] */\n${numberedFull}`;
      }
      if (endLine < allLines.length) {
        const appendUntil = Math.min(allLines.length, endLine + 120);
        const extraSnippet = allLines
          .slice(endLine, appendUntil)
          .map((line, idx) => `${endLine + 1 + idx}: ${line}`)
          .join('\n');
        return `${stdout}\n/* [DeepAutoCode Function-Completeness Auto-Expand: lines ${endLine + 1}..${appendUntil} of ${relFile} appended automatically so you do not miss #if 0 blocks or tail logic] */\n${extraSnippet}`;
      }
    } catch {
      // ignore if file is not accessible
    }
    return stdout;
  };

  /**
   * Automatically parses compiler/runtime errors (GCC, Clang, hipcc, nvcc, tsc, Python, Rust)
   * from build/test output and pre-loads the exact offending source lines (±22 lines) into context
   * so the Agent can immediately call `edit_file` on the very next turn without an extra `read_file` round-trip.
   */
  const autoExtractCompilerErrorContext = async (
    stdout: string,
    stderr: string
  ): Promise<string> => {
    const parsed =
      typeof parseBuildDiagnostics === 'function'
        ? parseBuildDiagnostics(stdout || '', stderr || '', { maxItems: 12 })
        : [];
    const seenLocs = new Set<string>();
    const targets: Array<{ relFile: string; line: number; msg: string }> = [];
    for (const d of parsed) {
      if (d.severity !== 'error') continue;
      const relFile = runtimeCtx.normalizeWorkspaceRelativePath(d.file, manifest.workspaceRoot);
      const key = `${relFile}:${Math.floor(d.line / 20)}`;
      if (!relFile || relFile.startsWith('..') || seenLocs.has(key)) continue;
      seenLocs.add(key);
      targets.push({ relFile, line: d.line, msg: d.message });
      if (targets.length >= 3) break;
    }

    if (targets.length === 0) {
      return '';
    }

    const snippets = await Promise.all(
      targets.map(async (t) => {
        try {
          const pulled = (await runCapabilityTool(
            'read-file',
            { filePath: t.relFile },
            'low'
          )) as { content: string };
          if (!pulled?.content) return '';
          const allLines = pulled.content.split(/\r?\n/);
          const s = Math.max(1, t.line - 18);
          const e = Math.min(allLines.length, t.line + 22);
          fileStateCache.recordRead({
            filePath: t.relFile,
            content: pulled.content,
            startLine: s,
            endLine: e,
          });
          const numbered = allLines
            .slice(s - 1, e)
            .map((l, idx) => `${s + idx === t.line ? '>> ' : '   '}${s + idx}: ${l}`)
            .join('\n');
          return `\n--- [Auto-Loaded Error Source: ${t.relFile}:${t.line} (${t.msg})] ---\n${numbered}`;
        } catch {
          return '';
        }
      })
    );

    const valid = snippets.filter(Boolean);
    return valid.length > 0
      ? `\n\n[DeepAutoCode Auto-Diagnosed Compiler Error Context — Immediately call edit_file to fix these lines and re-run build]:${valid.join('\n')}`
      : '';
  };

  // 1. Create In-tree Antigravity-Enhanced Builtin Tools wired to DeepAutoCode CapabilityRegistry
  const builtinTools = createBuiltinTools({
    cwd: manifest.workspaceRoot,
    shell: isSshMirrorWorkspace ? '/bin/bash' : undefined,
    enableEditor: manifest.executionMode !== 'plan' && !isReadOnlyTurn,
    enableApplyPatch: false,
    executionMode:
      manifest.executionMode === 'plan' || isReadOnlyTurn ? 'plan' : manifest.executionMode,
    ...(workspaceFileIndex ? { fileIndex: workspaceFileIndex } : {}),
    executors: {
      search: async (query: string, subDir?: string, contextLines = 3) => {
        if (isSshMirrorWorkspace) {
          const safeQuery = String(query || '').replace(/'/g, `'\\''`);
          const safeSubDir = subDir
            ? runtimeCtx.normalizeWorkspaceRelativePath(subDir, manifest.workspaceRoot).replace(
              /'/g,
              `'\\''`
            )
            : '.';
          const ctx = Math.max(0, Math.min(8, Number(contextLines) || 3));
          const res = (await runCapabilityTool(
            'run-build',
            {
              command: `(command -v rg >/dev/null 2>&1 && rg -n -C ${ctx} --hidden -g '!node_modules/**' -g '!.git/**' -F -- '${safeQuery}' '${safeSubDir}' 2>/dev/null || grep -rnI -C ${ctx} --exclude-dir=.git --exclude-dir=build --exclude-dir=node_modules -- '${safeQuery}' '${safeSubDir}' 2>/dev/null) | head -n 120`,
            },
            'low'
          )) as { stdout: string };
          return res.stdout?.trim() || 'No matches found.';
        }
        if (workspaceFileIndex && typeof searchIndexedFiles === 'function') {
          return searchIndexedFiles({
            root: manifest.workspaceRoot,
            index: workspaceFileIndex,
            query,
            under: subDir,
            contextLines,
          });
        }
        return 'No matches found.';
      },
      readFile: async (item: any) => {
        const rawFilePath = typeof item === 'string' ? item : item?.path;
        const filePath = runtimeCtx.normalizeWorkspaceRelativePath(
          rawFilePath,
          manifest.workspaceRoot
        );
        const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
          content: string;
          byteLength: number;
        };
        const allLines = res.content.split(/\r?\n/);
        const start = Math.max(1, item?.start_line ?? 1);
        const end = Math.min(allLines.length, item?.end_line ?? allLines.length);
        fileStateCache.recordRead({
          filePath,
          content: res.content,
          startLine: start,
          endLine: end,
        });
        return allLines
          .slice(start - 1, end)
          .map((line, idx) => `${start + idx}: ${line}`)
          .join('\n');
      },
      editor: async (input: any) => {
        const filePath = runtimeCtx.normalizeWorkspaceRelativePath(
          input.path || input.filePath || input.file_path,
          manifest.workspaceRoot
        );
        const oldText = input.old_text ?? input.old_str;
        const newText = input.new_text ?? input.new_str ?? input.file_text ?? '';

        if (input.command === 'view') {
          const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
          };
          fileStateCache.recordRead({ filePath, content: res.content });
          return res.content.slice(0, 12000);
        }

        if (input.insert_line != null || input.command === 'insert') {
          let currentContent = '';
          try {
            const current = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
              content: string;
            };
            currentContent = current.content;
            fileStateCache.makeSnapshot(filePath, currentContent);
          } catch {
            currentContent = '';
          }
          const lines = currentContent ? currentContent.split(/\r?\n/) : [];
          const idx = Math.max(0, Math.min(lines.length, input.insert_line ?? lines.length));
          lines.splice(idx, 0, newText);
          const updated = lines.join('\n');
          const writeRes = await applyFileEdit(filePath, updated);
          fileStateCache.recordRead({ filePath, content: updated, isPartialView: false });
          recordCompiledFileEdit(filePath);
          workspaceFileIndex?.invalidate();
          return `Inserted into ${filePath} (${writeRes.bytesWritten} bytes, diffId=${writeRes.diffId}${writeRes.appliedToDisk ? '' : ', pending user Accept'})`;
        }

        if (oldText != null && oldText.length > 0) {
          const current = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
          };
          fileStateCache.makeSnapshot(filePath, current.content);
          let updated: string;
          try {
            updated = runtimeCtx.applySmartTextReplacement(
              current.content,
              oldText,
              newText,
              filePath
            );
          } catch {
            const diag = fileStateCache.diagnoseEditMismatch(filePath, current.content, oldText);
            throw new Error(diag.hintMessage);
          }
          const writeRes = await applyFileEdit(filePath, updated);
          fileStateCache.recordRead({ filePath, content: updated, isPartialView: false });
          recordCompiledFileEdit(filePath);
          workspaceFileIndex?.invalidate();
          return `Updated ${filePath} (${writeRes.bytesWritten} bytes, diffId=${writeRes.diffId}${writeRes.appliedToDisk ? '' : ', pending user Accept'})`;
        }

        const writeRes = await applyFileEdit(filePath, newText);
        fileStateCache.recordRead({ filePath, content: newText, isPartialView: false });
        recordCompiledFileEdit(filePath);
        workspaceFileIndex?.invalidate();
        return `Created/Updated ${filePath} (${writeRes.bytesWritten} bytes, diffId=${writeRes.diffId}${writeRes.appliedToDisk ? '' : ', pending user Accept'})`;
      },
      bash: async (input: any) => {
        let cmd = '';
        if (typeof input === 'string') {
          cmd = input;
        } else if (input && typeof input === 'object') {
          const baseCmd = String(input.command ?? input.cmd ?? '').trim();
          const argsList = Array.isArray(input.args)
            ? input.args.map((a: unknown) => String(a)).join(' ')
            : '';
          cmd = argsList ? `${baseCmd} ${argsList}` : baseCmd;
        }
        const normCmd = cmd.trim().replace(/\s+/g, ' ');
        const prevCmdCount = executedCommandCounts.get(normCmd) ?? 0;
        if (normCmd && prevCmdCount >= 1) {
          executedCommandCounts.set(normCmd, prevCmdCount + 1);
          return `[DUPLICATE_COMMAND_SKIPPED]: You already executed this exact command in this turn and received its output above. Do NOT repeat the same command; proceed immediately to the next step!`;
        }
        if (normCmd) {
          executedCommandCounts.set(normCmd, prevCmdCount + 1);
        }
        const res = (await runCapabilityTool('run-build', { command: cmd }, 'high')) as {
          exitCode: number;
          stdout: string;
          stderr: string;
          durationMs: number;
        };
        recordCommandOutcome(cmd, res);
        const expandedStdout = await autoExpandPartialSedRead(cmd, res.stdout || '');
        const combined = [expandedStdout.trim(), res.stderr?.trim()].filter(Boolean).join('\n');
        return (combined || `Exit code ${res.exitCode}`).slice(0, 8000);
      },
    } as any,
  });

  // 2. Register DeepAutoCode Workspace Capability Tools via @cline/sdk `createTool`
  const deepAutoCodeTools = [
    createTool({
      name: 'list_files',
      description:
        'List files and directories inside a workspace directory (relative path, e.g. "." or "src").',
      inputSchema: {
        type: 'object',
        properties: {
          dirPath: {
            type: 'string',
            description: 'Relative directory path inside workspace (default ".")',
          },
        },
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const relDir = runtimeCtx.normalizeWorkspaceRelativePath(
          String(rawArgs?.dirPath || '.'),
          manifest.workspaceRoot
        );
        const targetDir = path.resolve(manifest.workspaceRoot, relDir);
        if (!targetDir.startsWith(path.resolve(manifest.workspaceRoot))) {
          throw new Error('PATH_BOUNDARY_VIOLATION: Directory outside workspace');
        }
        const entries = await fs.readdir(targetDir, { withFileTypes: true });
        const items = entries
          .filter((e) => !['node_modules', '.git', '.deepautocode-data'].includes(e.name))
          .slice(0, 80)
          .map((e) => (e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`));
        return { dirPath: relDir, entries: items };
      },
    }),
    createTool({
      name: 'outline_file',
      description:
        'Extract functions/structs/classes/enums/macros with exact 1-based start–end line ranges (TS/JS via AST, C/C++/other via enhanced heuristics). Ideal for navigating large files before read_file with start_line/end_line.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Relative path to the source/header file (e.g. "src/enqueue.cc" or "src/include/comm.h")',
          },
        },
        required: ['filePath'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const filePath = runtimeCtx.normalizeWorkspaceRelativePath(
          String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
          manifest.workspaceRoot
        );
        const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
          content: string;
          byteLength: number;
        };
        const totalLines = res.content.split(/\r?\n/).length;
        const symbols = extractCodeOutline(res.content, 150, filePath);
        return {
          filePath,
          totalLines,
          symbolCount: symbols.length,
          outline: symbols.join('\n'),
        };
      },
    }),
    createTool({
      name: 'read_file',
      description:
        'Read the contents of a text, image, pdf, video, or audio file inside the workspace or session scratch/ directory (supports optional start_line, end_line, and byteOffset; each read returns at most 800 lines or 46,080 bytes and attaches a symbol outline for large files).',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Relative path to the file in the workspace (or "scratch/<file>")',
          },
          start_line: {
            type: 'number',
            description: 'Optional 1-based start line number (inclusive)',
          },
          end_line: {
            type: 'number',
            description: 'Optional 1-based end line number (inclusive)',
          },
          byteOffset: {
            type: 'number',
            description:
              'Optional byte offset into the line range to continue reading when content is truncated by the 46,080-byte limit.',
          },
        },
        required: ['filePath'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const rawInputPath = String(
          rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || rawArgs?.Path || ''
        ).trim();
        const sessionDir = runtimeCtx.getSessionDir(sessionId);
        const scratchDir = path.join(sessionDir, 'scratch');
        const normRaw = rawInputPath.replace(/\\/g, '/').replace(/^\.\//, '');
        const isScratchPath =
          normRaw.startsWith('scratch/') ||
          path.resolve(rawInputPath).startsWith(path.resolve(sessionDir));
        const filePath = isScratchPath
          ? normRaw
          : runtimeCtx.normalizeWorkspaceRelativePath(rawInputPath, manifest.workspaceRoot);
        const absTarget = isScratchPath
          ? normRaw.startsWith('scratch/')
            ? path.resolve(scratchDir, normRaw.slice('scratch/'.length))
            : path.resolve(rawInputPath)
          : path.resolve(manifest.workspaceRoot, filePath);

        // Multimodal file detection (image, pdf, audio, video)
        const extMatch = filePath.match(
          /\.(png|jpe?g|gif|webp|bmp|ico|pdf|mp3|wav|ogg|mp4|webm|mov)$/i
        );
        if (extMatch) {
          const ext = extMatch[1].toLowerCase();
          const buf = await fs.readFile(absTarget);
          const byteLength = buf.byteLength;
          if (/^(png|jpe?g|gif|webp|bmp|ico)$/.test(ext)) {
            const mimeMap: Record<string, string> = {
              png: 'image/png',
              jpg: 'image/jpeg',
              jpeg: 'image/jpeg',
              gif: 'image/gif',
              webp: 'image/webp',
              bmp: 'image/bmp',
              ico: 'image/x-icon',
            };
            let width: number | undefined;
            let height: number | undefined;
            if (ext === 'png' && buf.length >= 24) {
              width = buf.readUInt32BE(16);
              height = buf.readUInt32BE(20);
            } else if (ext === 'gif' && buf.length >= 10) {
              width = buf.readUInt16LE(6);
              height = buf.readUInt16LE(8);
            }
            const base64Str = buf.subarray(0, 64 * 1024).toString('base64');
            return {
              filePath,
              mediaType: 'image',
              mimeType: mimeMap[ext] || 'image/png',
              byteLength,
              width,
              height,
              dataUrlPreview: `data:${mimeMap[ext] || 'image/png'};base64,${base64Str}`,
              content: `[Image File: ${filePath} (${mimeMap[ext] || ext}, ${byteLength} bytes${width && height ? `, ${width}x${height}px` : ''})]`,
            };
          }
          if (ext === 'pdf') {
            const latin = buf.toString('latin1');
            const pageMatches = latin.match(/\/Type\s*\/Page\b/g);
            const pageCount = pageMatches ? pageMatches.length : 1;
            const textLiterals = [...latin.matchAll(/\(([^()\\]{2,200})\)/g)]
              .map((m) => m[1])
              .filter((s) => /[A-Za-z0-9]{2,}/.test(s))
              .slice(0, 400)
              .join(' ');
            return {
              filePath,
              mediaType: 'pdf',
              mimeType: 'application/pdf',
              byteLength,
              pageCount,
              content:
                textLiterals.slice(0, 46080) ||
                `[PDF Document: ${filePath} (${pageCount} page(s), ${byteLength} bytes)]`,
            };
          }
          const isAudio = /^(mp3|wav|ogg)$/.test(ext);
          return {
            filePath,
            mediaType: isAudio ? 'audio' : 'video',
            mimeType: `${isAudio ? 'audio' : 'video'}/${ext}`,
            byteLength,
            content: `[${isAudio ? 'Audio' : 'Video'} File: ${filePath} (${byteLength} bytes)]`,
          };
        }

        const startLine = Number(rawArgs?.start_line ?? rawArgs?.startLine ?? rawArgs?.StartLine ?? 0);
        const endLine = Number(rawArgs?.end_line ?? rawArgs?.endLine ?? rawArgs?.EndLine ?? 0);
        const byteOffset = Math.max(
          0,
          Number(rawArgs?.byteOffset ?? rawArgs?.byte_offset ?? rawArgs?.ByteOffset ?? 0)
        );
        const rangeKey = `${filePath}:${startLine > 0 ? startLine : 1}-${endLine > 0 ? endLine : 'EOF'}:${byteOffset}`;
        const fullKey = `${filePath}:1-EOF:0`;
        const prevCount =
          (readCountsByRange.get(rangeKey) ?? 0) +
          (rangeKey !== fullKey && byteOffset === 0 ? (readCountsByRange.get(fullKey) ?? 0) : 0);
        const cached = fileStateCache.get(filePath);
        if (cached && prevCount >= 1) {
          readCountsByRange.set(rangeKey, prevCount + 1);
          return {
            filePath,
            totalLines: cached.totalLines,
            alreadyInContext: true,
            notice: `[DUPLICATE_READ_SKIPPED]: '${filePath}' was ALREADY read in this turn and has not been modified since. Do NOT call read_file on '${filePath}' again! If changes are still needed, call edit_file / write_file immediately; if '${filePath}' already contains the target fix, proceed directly to run_command or output the final summary.`,
          };
        }
        const res = isScratchPath
          ? await (async () => {
            const rawText = await fs.readFile(absTarget, 'utf-8');
            return {
              content: rawText,
              byteLength: Buffer.byteLength(rawText, 'utf-8'),
              truncated: false,
            };
          })()
          : ((await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
            byteLength: number;
            truncated: boolean;
          });
        const allLines = res.content.split(/\r?\n/);
        const totalLines = allLines.length;
        let contentOut = res.content;
        readCountsByRange.set(rangeKey, (readCountsByRange.get(rangeKey) ?? 0) + 1);
        const effectiveStart = startLine > 0 ? startLine : 1;
        const maxLineSpan = endLine > 0 ? Math.min(endLine, effectiveStart + 799) : Math.min(totalLines, effectiveStart + 799);
        fileStateCache.recordRead({
          filePath,
          content: res.content,
          startLine: effectiveStart,
          endLine: maxLineSpan,
        });
        if (startLine > 0 || endLine > 0 || totalLines > 800) {
          const s = Math.max(1, effectiveStart);
          const e = Math.min(totalLines, maxLineSpan);
          contentOut = allLines
            .slice(s - 1, e)
            .map((line, idx) => `${s + idx}: ${line}`)
            .join('\n');
        }
        const MAX_READ_BYTES = 46080;
        if (byteOffset > 0) {
          contentOut = contentOut.slice(byteOffset);
        }
        const truncatedByBytes = contentOut.length > MAX_READ_BYTES;
        const slicedContent = contentOut.slice(0, MAX_READ_BYTES);
        const isTruncatedOrLarge = Boolean(
          res.truncated || truncatedByBytes || (totalLines > 350 && startLine === 0)
        );
        const symbolOutline =
          isTruncatedOrLarge
            ? extractCodeOutline(res.content, 80, filePath).join('\n')
            : undefined;
        return {
          filePath,
          totalLines,
          byteLength: res.byteLength,
          byteOffset,
          nextByteOffset: truncatedByBytes ? byteOffset + MAX_READ_BYTES : undefined,
          truncated: Boolean(res.truncated || truncatedByBytes || maxLineSpan < (endLine || totalLines)),
          content: slicedContent,
          ...(symbolOutline
            ? {
              symbolOutlineHint: `[文件符号大纲导航 (共 ${totalLines} 行；格式 Lstart-Lend: kind name — 用 start_line/end_line 或 byteOffset 精确读取)]:\n${symbolOutline}`,
            }
            : {}),
        };
      },
    }),
    createTool({
      name: 'explore_codebase',
      description:
        'Context-isolated parallel codebase exploration subagent (inspired by Claude Code Explore Agent). Executes multiple keyword/symbol searches and file outline/range inspections in parallel and returns a compact, line-numbered evidence digest without bloating the main conversation context.',
      inputSchema: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            description: 'Up to 4 symbol names or grep search patterns to search in parallel',
            items: { type: 'string' },
          },
          files: {
            type: 'array',
            description: 'Up to 4 files (with optional 1-based start_line and end_line) to inspect in parallel',
            items: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
                start_line: { type: 'number' },
                end_line: { type: 'number' },
              },
              required: ['filePath'],
            },
          },
        },
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const queries = Array.isArray(rawArgs?.queries)
          ? rawArgs.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4)
          : [];
        const files = Array.isArray(rawArgs?.files) ? rawArgs.files.slice(0, 4) : [];

        const [searchDigestParts, fileDigestParts] = await Promise.all([
          Promise.all(
            queries.map(async (q) => {
              if (isSshMirrorWorkspace) {
                const safeQ = q.replace(/'/g, `'\\''`);
                const res = (await runCapabilityTool(
                  'run-build',
                  {
                    command: `grep -rnI -C 2 --exclude-dir=.git --exclude-dir=build -- '${safeQ}' . 2>/dev/null | head -n 45`,
                  },
                  'low'
                )) as { stdout: string };
                return `### Search: \`${q}\`\n${(res.stdout || 'No matches.').trim().slice(0, 1400)}`;
              }
              if (workspaceFileIndex && typeof searchIndexedFiles === 'function') {
                const localHits = await searchIndexedFiles({
                  root: manifest.workspaceRoot,
                  index: workspaceFileIndex,
                  query: q,
                  contextLines: 2,
                  maxMatches: 20,
                });
                return `### Search: \`${q}\`\n${localHits.slice(0, 1400)}`;
              }
              return `### Search: \`${q}\` (use search_codebase for local details)`;
            })
          ),
          Promise.all(
            files.map(async (f: any) => {
              const rawPath = typeof f === 'string' ? f : f?.filePath || f?.path || '';
              const relPath = runtimeCtx.normalizeWorkspaceRelativePath(rawPath, manifest.workspaceRoot);
              if (!relPath) return '';
              try {
                const res = (await runCapabilityTool('read-file', { filePath: relPath }, 'low')) as {
                  content: string;
                };
                const allLines = res.content.split(/\r?\n/);
                const s = Math.max(1, Number(f?.start_line ?? 1));
                const e = Math.min(
                  allLines.length,
                  Number(f?.end_line ?? Math.min(allLines.length, s + 90))
                );
                fileStateCache.recordRead({
                  filePath: relPath,
                  content: res.content,
                  startLine: s,
                  endLine: e,
                });
                const snippet = allLines
                  .slice(s - 1, e)
                  .map((line, idx) => `${s + idx}: ${line}`)
                  .join('\n')
                  .slice(0, 1800);
                const outline = extractCodeOutline(res.content, 30, relPath).join('\n');
                return `### File: \`${relPath}\` (lines ${s}-${e} of ${allLines.length})\n${snippet}${outline ? `\n[Outline]:\n${outline}` : ''
                  }`;
              } catch (err) {
                return `### File: \`${relPath}\` (error: ${err instanceof Error ? err.message : String(err)})`;
              }
            })
          ),
        ]);

        return {
          digest: [...searchDigestParts, ...fileDigestParts].filter(Boolean).join('\n\n').slice(0, 7500),
        };
      },
    }),
    createTool({
      name: 'edit_file',
      description:
        'Directly modify an existing file in the workspace by replacing a target snippet (oldText) with updated code (newText). Supports multi-hunk edits via `hunks: [{oldText,newText}, ...]`. Automatically syncs to Remote SSH if connected and updates the IDE Code Editor.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description:
              'Relative path to the file in the workspace (e.g. "nccl-test/src/sendrecv.cc" or "nccl-test/verifiable/verifiable.cc")',
          },
          oldText: {
            type: 'string',
            description: 'Exact existing lines of code in the file to be replaced (single-hunk mode)',
          },
          newText: {
            type: 'string',
            description: 'New replacement lines of code (single-hunk mode)',
          },
          hunks: {
            type: 'array',
            description:
              'Optional multi-hunk replacements for the same file: [{ oldText, newText }, ...]. Prefer this over multiple edit_file calls when changing several spots in one file.',
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string' },
                newText: { type: 'string' },
              },
              required: ['oldText', 'newText'],
            },
          },
          artifactMetadata: {
            type: 'object',
            description:
              'Optional Antigravity Artifact metadata ({ Summary, UserFacing, RequestFeedback }) when updating an Artifact file.',
            properties: {
              Summary: { type: 'string' },
              UserFacing: { type: 'boolean' },
              RequestFeedback: { type: 'boolean' },
            },
          },
        },
        required: ['filePath'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const filePath = runtimeCtx.normalizeWorkspaceRelativePath(
          String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
          manifest.workspaceRoot
        );
        const hunksRaw = Array.isArray(rawArgs?.hunks) ? rawArgs.hunks : null;
        const hunks: Array<{ oldText: string; newText: string }> = hunksRaw
          ? hunksRaw.map((h: any) => ({
            oldText: String(h?.oldText ?? h?.old_text ?? ''),
            newText: String(h?.newText ?? h?.new_text ?? ''),
          }))
          : [
            {
              oldText: String(rawArgs?.oldText ?? rawArgs?.old_text ?? rawArgs?.old_str ?? ''),
              newText: String(rawArgs?.newText ?? rawArgs?.new_text ?? rawArgs?.new_str ?? ''),
            },
          ];
        if (!filePath || !hunks.some((h) => h.oldText)) {
          return {
            ok: false,
            error: 'filePath and oldText (or hunks[].oldText) are required for edit_file.',
          };
        }
        let current = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
          content: string;
        };
        fileStateCache.makeSnapshot(filePath, current.content);
        let updated: string;
        const replaceOne = (content: string, oldText: string, newText: string) =>
          runtimeCtx.applySmartTextReplacement(content, oldText, newText, filePath);
        const tryApply = (content: string) =>
          typeof FileStateCache.applyMultiHunkReplacements === 'function'
            ? FileStateCache.applyMultiHunkReplacements(content, hunks, replaceOne)
            : hunks.reduce((acc, h) => replaceOne(acc, h.oldText, h.newText), content);
        try {
          updated = tryApply(current.content);
          editMismatchCount = 0;
        } catch {
          // Stage P: one-shot auto recovery — re-read disk and retry once with fresh content
          editMismatchCount += 1;
          try {
            const refreshed = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
              content: string;
            };
            current = refreshed;
            fileStateCache.makeSnapshot(filePath, refreshed.content);
            fileStateCache.recordRead({
              filePath,
              content: refreshed.content,
              isPartialView: false,
            });
            updated = tryApply(refreshed.content);
            editMismatchCount = 0;
          } catch {
            editMismatchCount += 1;
            const diag = fileStateCache.diagnoseEditMismatch(
              filePath,
              current.content,
              hunks[0]?.oldText || ''
            );
            // Attach a numbered window around the best fuzzy match for the model
            const lines = String(current.content || '').split(/\r?\n/);
            const needle = (hunks[0]?.oldText || '').split(/\r?\n/)[0]?.trim() || '';
            let approxLine = 1;
            if (needle) {
              const hit = lines.findIndex((l) => l.includes(needle.slice(0, 48)));
              if (hit >= 0) approxLine = hit + 1;
            }
            const s = Math.max(1, approxLine - 8);
            const e = Math.min(lines.length, approxLine + 16);
            const window = lines
              .slice(s - 1, e)
              .map((l, i) => `${s + i}: ${l}`)
              .join('\n');
            return {
              ok: false,
              filePath,
              error: diag.hintMessage,
              editMismatchCount,
              autoRetryAttempted: true,
              refreshedSnippet: window,
              mandatoryNextStep:
                `EDIT_RECOVERY: oldText still missing after auto re-read. Use this numbered window (L${s}-L${e}) to craft a fresh oldText, then retry edit_file/apply_patch once:\n${window}`,
            };
          }
        }
        const writeRes = await applyFileEdit(filePath, updated);
        fileStateCache.recordRead({ filePath, content: updated, isPartialView: false });
        recordCompiledFileEdit(filePath);
        const rawArtifactMeta = (rawArgs?.artifactMetadata || rawArgs?.ArtifactMetadata) as
          | Record<string, unknown>
          | undefined;
        let artifactRecord: Record<string, unknown> | undefined;
        if (rawArtifactMeta && typeof rawArtifactMeta === 'object') {
          const summaryTitle = String(
            rawArtifactMeta.Summary || rawArtifactMeta.summary || path.basename(filePath)
          ).slice(0, 80);
          const reqFeedback = Boolean(
            rawArtifactMeta.RequestFeedback ?? rawArtifactMeta.requestFeedback
          );
          artifactRecord = await persistSessionArtifact({
            artifactType: reqFeedback ? 'plan' : 'report',
            title: summaryTitle,
            content: updated,
            source: 'edit_file:artifactMetadata',
          });
        }
        const postDiag = await runPostEditDiagnostics(filePath, updated);
        const isCompiledSrc = /\.(?:c|cc|cpp|cu|h|hpp)$/i.test(filePath);
        const needsVerify =
          typeof isVerifiableSourcePath === 'function'
            ? isVerifiableSourcePath(filePath, verifyConfig)
            : isCompiledSrc || /\.(?:ts|tsx|js|jsx)$/i.test(filePath);
        return {
          ok: true,
          filePath,
          diffId: writeRes.diffId,
          bytesWritten: writeRes.bytesWritten,
          operation: writeRes.operation,
          appliedToDisk: writeRes.appliedToDisk,
          hunksApplied: hunks.length,
          ...(artifactRecord ? { artifact: artifactRecord } : {}),
          ...postDiag,
          ...(needsVerify
            ? {
              mandatoryNextStep: postDiag.semanticErrors
                ? `Fix SEMANTIC_DIAGNOSTICS_FAILED first, then run_command: ${preferredVerifyCommand}`
                : `CRITICAL: You just modified a verifiable source file. Your NEXT tool call MUST be run_command with: ${preferredVerifyCommand}`,
            }
            : {}),
        };
      },
    }),
    createTool({
      name: 'write_file',
      description:
        'Create a new file (including parent directories), overwrite an existing file, or append to an existing file (when append=true) in the workspace. Supports optional artifactMetadata to register/update an IDE Artifact simultaneously.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Relative path to the file in the workspace (e.g. "nccl-test/src/sendrecv.cc" or "index.html")',
          },
          content: {
            type: 'string',
            description: 'File content to write or append',
          },
          overwrite: {
            type: 'boolean',
            description: 'Whether to overwrite an existing file (default true unless explicitly set to false)',
          },
          append: {
            type: 'boolean',
            description: 'Whether to append content to the end of the file instead of replacing it',
          },
          artifactMetadata: {
            type: 'object',
            description:
              'Optional Antigravity Artifact metadata ({ Summary, UserFacing, RequestFeedback }) when writing a Markdown artifact or plan.',
            properties: {
              Summary: { type: 'string' },
              UserFacing: { type: 'boolean' },
              RequestFeedback: { type: 'boolean' },
            },
          },
        },
        required: ['filePath', 'content'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const rawInputPath = String(
          rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || rawArgs?.Path || ''
        ).trim();
        const sessionDir = runtimeCtx.getSessionDir(sessionId);
        const scratchDir = path.join(sessionDir, 'scratch');
        const normRaw = rawInputPath.replace(/\\/g, '/').replace(/^\.\//, '');
        const isScratchPath =
          normRaw.startsWith('scratch/') ||
          path.resolve(rawInputPath).startsWith(path.resolve(sessionDir));
        const filePath = isScratchPath
          ? normRaw
          : runtimeCtx.normalizeWorkspaceRelativePath(rawInputPath, manifest.workspaceRoot);
        if (rawArgs?.__truncated) {
          return {
            ok: false,
            error: `OUTPUT_TRUNCATED_AT_MAX_TOKENS: Your tool call JSON arguments for '${filePath || 'target file'}' exceeded the 8192 output token limit in a single turn and were cut off. For large existing files, use 'edit_file' ({ filePath, oldText, newText }) to replace only the changed snippet, or call write_file for 1 file per turn.`,
          };
        }
        const rawContent = String(
          rawArgs?.content ?? rawArgs?.Content ?? rawArgs?.new_text ?? rawArgs?.text ?? ''
        );
        const appendMode = Boolean(rawArgs?.append ?? rawArgs?.Append);
        const overwriteAllowed =
          rawArgs?.overwrite !== false && rawArgs?.Overwrite !== false;
        if (!filePath) {
          return {
            ok: false,
            error:
              'Missing filePath parameter for write_file (tool call JSON may have been truncated). Please use edit_file for targeted changes or call write_file for one file at a time.',
          };
        }
        if (isScratchPath) {
          const absScratchTarget = normRaw.startsWith('scratch/')
            ? path.resolve(scratchDir, normRaw.slice('scratch/'.length))
            : path.resolve(rawInputPath);
          await fs.mkdir(path.dirname(absScratchTarget), { recursive: true });
          let prevScratch: string | null = null;
          try {
            prevScratch = await fs.readFile(absScratchTarget, 'utf-8');
          } catch {
            // new scratch file
          }
          if (prevScratch != null && !appendMode && !overwriteAllowed) {
            return {
              ok: false,
              filePath,
              error: `FILE_EXISTS: '${filePath}' already exists and overwrite=false was specified.`,
            };
          }
          const nextScratch =
            appendMode && prevScratch != null ? `${prevScratch}${rawContent}` : rawContent;
          await fs.writeFile(absScratchTarget, nextScratch, 'utf-8');
          return {
            ok: true,
            filePath,
            scratchPath: absScratchTarget,
            bytesWritten: Buffer.byteLength(nextScratch, 'utf-8'),
            operation: appendMode ? 'append' : prevScratch != null ? 'modify' : 'create',
            appliedToDisk: true,
          };
        }
        let existingContent: string | null = null;
        try {
          const existing = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
          };
          if (existing?.content != null) {
            existingContent = existing.content;
            fileStateCache.makeSnapshot(filePath, existing.content);
          }
        } catch {
          // new file
        }
        if (existingContent != null && !appendMode && !overwriteAllowed) {
          return {
            ok: false,
            filePath,
            error: `FILE_EXISTS: '${filePath}' already exists and overwrite=false was specified. Pass overwrite=true, append=true, or use edit_file.`,
          };
        }
        const content =
          appendMode && existingContent != null
            ? `${existingContent}${rawContent}`
            : rawContent;
        const writeRes = await applyFileEdit(filePath, content);
        fileStateCache.recordRead({ filePath, content, isPartialView: false });
        recordCompiledFileEdit(filePath);
        const rawArtifactMeta = (rawArgs?.artifactMetadata || rawArgs?.ArtifactMetadata) as
          | Record<string, unknown>
          | undefined;
        let artifactRecord: Record<string, unknown> | undefined;
        if (rawArtifactMeta && typeof rawArtifactMeta === 'object') {
          const summaryTitle = String(
            rawArtifactMeta.Summary || rawArtifactMeta.summary || path.basename(filePath)
          ).slice(0, 80);
          const reqFeedback = Boolean(
            rawArtifactMeta.RequestFeedback ?? rawArtifactMeta.requestFeedback
          );
          artifactRecord = await persistSessionArtifact({
            artifactType: reqFeedback ? 'plan' : 'report',
            title: summaryTitle,
            content,
            source: 'write_file:artifactMetadata',
          });
        }
        const postDiag = await runPostEditDiagnostics(filePath, content);
        const needsVerify =
          typeof isVerifiableSourcePath === 'function'
            ? isVerifiableSourcePath(filePath, verifyConfig)
            : /\.(?:c|cc|cpp|cu|h|hpp|ts|tsx|js|jsx|py|go|rs)$/i.test(filePath);
        return {
          ok: true,
          filePath,
          diffId: writeRes.diffId,
          bytesWritten: writeRes.bytesWritten,
          operation: appendMode ? 'append' : writeRes.operation,
          appliedToDisk: writeRes.appliedToDisk,
          ...(artifactRecord ? { artifact: artifactRecord } : {}),
          ...postDiag,
          ...(needsVerify
            ? {
              mandatoryNextStep: postDiag.semanticErrors
                ? `Fix SEMANTIC_DIAGNOSTICS_FAILED first, then run_command: ${preferredVerifyCommand}`
                : `CRITICAL: You just modified a verifiable source file. Your NEXT tool call MUST be run_command with: ${preferredVerifyCommand}`,
            }
            : {}),
        };
      },
    }),
    createTool({
      name: 'apply_patch',
      description:
        'Apply a unified diff / multi-hunk patch to one or more workspace files. Prefer this over many edit_file calls for large or multi-site changes. Supports classic ---/+++ @@ hunks and *** Update File: path blocks.',
      inputSchema: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description: 'Unified diff text (may include multiple files)',
          },
          filePath: {
            type: 'string',
            description:
              'Optional single target file when the patch omits paths or targets one file',
          },
        },
        required: ['patch'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (
          typeof applyPatchToContent !== 'function' &&
          typeof applyMultiFilePatch !== 'function'
        ) {
          return { ok: false, error: 'apply_patch unavailable in this runtime build.' };
        }
        const patch = String(rawArgs?.patch || rawArgs?.diff || '');
        if (!patch.trim()) {
          return { ok: false, error: 'patch text is required.' };
        }
        const preferred = rawArgs?.filePath
          ? runtimeCtx.normalizeWorkspaceRelativePath(
            String(rawArgs.filePath),
            manifest.workspaceRoot
          )
          : '';

        const contentCache = new Map<string, string | null>();
        const readCached = async (rel: string): Promise<string | null> => {
          const filePath = runtimeCtx.normalizeWorkspaceRelativePath(rel, manifest.workspaceRoot);
          if (contentCache.has(filePath)) return contentCache.get(filePath) ?? null;
          try {
            const current = (await runCapabilityTool(
              'read-file',
              { filePath },
              'low'
            )) as { content: string };
            const text = current?.content ?? '';
            contentCache.set(filePath, text);
            fileStateCache.makeSnapshot(filePath, text);
            return text;
          } catch {
            contentCache.set(filePath, null);
            return null;
          }
        };

        let targets =
          typeof listPatchFiles === 'function' ? listPatchFiles(patch) : [];
        if (targets.length === 0 && preferred) targets = [preferred];
        if (targets.length === 0) {
          return {
            ok: false,
            error:
              'PATCH_NO_TARGETS: Include *** Update/Add/Delete File: path or ---/+++ paths, or pass filePath.',
          };
        }

        // Prefetch contents for multi-file in-memory apply
        for (const t of targets.slice(0, 8)) {
          await readCached(t);
        }

        const runPatchPlan = () => {
          const multi =
            typeof applyMultiFilePatch === 'function'
              ? applyMultiFilePatch(patch, (p) => {
                const norm = runtimeCtx.normalizeWorkspaceRelativePath(p, manifest.workspaceRoot);
                return contentCache.has(norm) ? contentCache.get(norm) ?? null : null;
              })
              : null;
          return multi;
        };

        let multi = runPatchPlan();

        // Stage S5: one-shot auto recovery — clear cache, re-read disk, retry patch once
        if (multi && !multi.ok) {
          for (const t of targets.slice(0, 8)) {
            const norm = runtimeCtx.normalizeWorkspaceRelativePath(t, manifest.workspaceRoot);
            contentCache.delete(norm);
            await readCached(norm);
          }
          multi = runPatchPlan();
        }

        if (multi && !multi.ok) {
          editMismatchCount += 1;
          const failedPath =
            (multi.files || []).find((f: any) => f.error)?.filePath || targets[0] || '';
          let recoveryWindow = '';
          if (failedPath) {
            try {
              const fresh = (await readCached(failedPath)) || '';
              const lines = fresh.split(/\r?\n/);
              const needle = (multi.hint || '').match(/L(\d+)/)?.[1];
              const mid = needle ? Number(needle) : Math.min(40, lines.length);
              const s = Math.max(1, mid - 12);
              const e = Math.min(lines.length, mid + 12);
              recoveryWindow = lines
                .slice(s - 1, e)
                .map((ln, i) => `L${s + i}|${ln}`)
                .join('\n');
            } catch {
              // ignore
            }
          }
          return {
            ok: false,
            error: multi.error,
            hint: multi.hint,
            files: multi.files,
            refreshedSnippet: recoveryWindow || undefined,
            mandatoryNextStep: recoveryWindow
              ? `PATCH_RECOVERY: old context still missing after auto re-read. Use this numbered window to craft a fresh patch or fall back to edit_file:\n${recoveryWindow}`
              : 'Fix PATCH failures using the hint windows, or fall back to edit_file for the failing hunks. Re-read the file with line numbers before retrying.',
          };
        }

        let planned =
          multi?.files ||
          (
            await Promise.all(
              targets.slice(0, 8).map(async (target) => {
                const filePath = runtimeCtx.normalizeWorkspaceRelativePath(
                  target,
                  manifest.workspaceRoot
                );
                const currentContent = (await readCached(filePath)) ?? '';
                const applied = applyPatchToContent(filePath, currentContent, patch);
                return {
                  filePath,
                  beforeContent: currentContent,
                  afterContent: applied.ok ? applied.content ?? null : null,
                  deleted: Boolean(applied.deleted),
                  created: Boolean(applied.created),
                  hunksApplied: applied.hunksApplied,
                  error: applied.ok ? undefined : applied.error,
                  hint: applied.hint,
                };
              })
            )
          );

        // Stage S5 (single-file path): retry once on first planned item failure
        if (
          Array.isArray(planned) &&
          planned.some((p: any) => p.error || (p.afterContent == null && !p.deleted))
        ) {
          for (const t of targets.slice(0, 8)) {
            const norm = runtimeCtx.normalizeWorkspaceRelativePath(t, manifest.workspaceRoot);
            contentCache.delete(norm);
            await readCached(norm);
          }
          planned = await Promise.all(
            targets.slice(0, 8).map(async (target) => {
              const filePath = runtimeCtx.normalizeWorkspaceRelativePath(
                target,
                manifest.workspaceRoot
              );
              const currentContent = (await readCached(filePath)) ?? '';
              const applied = applyPatchToContent(filePath, currentContent, patch);
              return {
                filePath,
                beforeContent: currentContent,
                afterContent: applied.ok ? applied.content ?? null : null,
                deleted: Boolean(applied.deleted),
                created: Boolean(applied.created),
                hunksApplied: applied.hunksApplied,
                error: applied.ok ? undefined : applied.error,
                hint: applied.hint,
              };
            })
          );
        }

        const results: Array<Record<string, unknown>> = [];
        const written: Array<{ filePath: string; before: string | null }> = [];

        const unlinkWorkspaceFile = async (relFile: string) => {
          const abs = path.resolve(manifest.workspaceRoot, relFile);
          if (!abs.startsWith(path.resolve(manifest.workspaceRoot))) {
            throw new Error(`PATH_BOUNDARY_VIOLATION: ${relFile}`);
          }
          await fs.unlink(abs);
        };

        const rollbackWritten = async () => {
          for (const w of written.reverse()) {
            try {
              if (w.before == null) {
                await unlinkWorkspaceFile(w.filePath).catch(() => undefined);
              } else {
                await applyFileEdit(w.filePath, w.before);
              }
            } catch {
              // best-effort rollback
            }
          }
        };

        for (const item of planned as Array<any>) {
          const filePath = runtimeCtx.normalizeWorkspaceRelativePath(
            item.filePath,
            manifest.workspaceRoot
          );
          if (item.error || (item.afterContent == null && !item.deleted)) {
            editMismatchCount += 1;
            await rollbackWritten();
            return {
              ok: false,
              error: item.error || `Failed applying patch to ${filePath}`,
              hint: item.hint,
              files: results,
              rolledBack: written.map((w) => w.filePath),
              mandatoryNextStep:
                'Fix PATCH failures using the hint windows, or fall back to edit_file. Re-read the file before retrying.',
            };
          }

          if (item.deleted) {
            try {
              await unlinkWorkspaceFile(filePath);
              written.push({ filePath, before: item.beforeContent ?? null });
              results.push({
                ok: true,
                filePath,
                deleted: true,
                hunksApplied: item.hunksApplied,
              });
            } catch (err) {
              await rollbackWritten();
              return {
                ok: false,
                error: `Failed deleting ${filePath}: ${(err as Error).message}`,
                files: results,
                rolledBack: written.map((w) => w.filePath),
              };
            }
            continue;
          }

          try {
            const writeRes = await applyFileEdit(filePath, String(item.afterContent));
            written.push({ filePath, before: item.beforeContent ?? null });
            fileStateCache.recordRead({
              filePath,
              content: String(item.afterContent),
              isPartialView: false,
            });
            recordCompiledFileEdit(filePath);
            const postDiag = await runPostEditDiagnostics(
              filePath,
              String(item.afterContent)
            );
            editMismatchCount = 0;
            results.push({
              ok: true,
              filePath,
              diffId: writeRes.diffId,
              bytesWritten: writeRes.bytesWritten,
              hunksApplied: item.hunksApplied,
              created: Boolean(item.created),
              ...postDiag,
            });
          } catch (err) {
            await rollbackWritten();
            return {
              ok: false,
              error: `Write failed for ${filePath}: ${(err as Error).message}`,
              files: results,
              rolledBack: written.map((w) => w.filePath),
            };
          }
        }

        const anySemantic = results.some((r) => Boolean(r.semanticErrors));
        return {
          ok: true,
          files: results,
          mandatoryNextStep: anySemantic
            ? `Fix SEMANTIC_DIAGNOSTICS_FAILED first, then run_command: ${preferredVerifyCommand}`
            : `CRITICAL: After apply_patch, run_command with: ${preferredVerifyCommand}`,
        };
      },
    }),
    createTool({
      name: 'run_command',
      description:
        'Execute a shell/build/test command in the workspace root directory. Supports backgrounding long-running processes via waitMsBeforeAsync and isDaemon.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run (e.g. "make -j16", "git diff", "npm test")',
          },
          waitMsBeforeAsync: {
            type: 'number',
            description:
              'Optional milliseconds (500-60000) to wait before backgrounding the command as a managed task. Use 500-2000 for servers/GUI launches.',
          },
          isDaemon: {
            type: 'boolean',
            description:
              'Set true for long-running dev servers, watchers, or GUI apps that should run in the background and be managed via manage_task.',
          },
        },
        required: ['command'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const command = String(rawArgs?.command || '');
        const isDaemon = Boolean(rawArgs?.isDaemon);
        const waitMsBeforeAsync =
          typeof rawArgs?.waitMsBeforeAsync === 'number'
            ? Number(rawArgs.waitMsBeforeAsync)
            : undefined;

        if (
          globalBackgroundTaskManager &&
          (isDaemon || typeof waitMsBeforeAsync === 'number')
        ) {
          const bgRes = await globalBackgroundTaskManager.runOrBackgroundCommand({
            sessionId,
            command,
            cwd: manifest.workspaceRoot,
            waitMsBeforeAsync,
            isDaemon,
            signal,
            onStateChange: (snap) => {
              runtimeCtx.emit({
                type: 'task_state_changed',
                sessionId,
                payload: { task: snap },
              });
            },
          });
          if (!bgRes.backgrounded) {
            recordCommandOutcome(command, {
              exitCode: bgRes.task.exitCode ?? 0,
              stdout: bgRes.task.stdout,
              stderr: bgRes.task.stderr,
            });
          }
          return {
            command,
            backgrounded: bgRes.backgrounded,
            taskId: bgRes.task.taskId,
            status: bgRes.task.status,
            exitCode: bgRes.task.exitCode,
            stdout: bgRes.task.stdout.slice(-8000),
            stderr: bgRes.task.stderr.slice(-4000),
            hint: bgRes.backgrounded
              ? `Command is running in the background as ${bgRes.task.taskId}. Use manage_task({ action: "status" | "send_input" | "kill", taskId: "${bgRes.task.taskId}" }) to inspect or stop it.`
              : undefined,
          };
        }

        const normCmd = command.trim().replace(/\s+/g, ' ');
        const prevCmdCount = executedCommandCounts.get(normCmd) ?? 0;
        if (normCmd && prevCmdCount >= 1) {
          executedCommandCounts.set(normCmd, prevCmdCount + 1);
          return {
            command,
            exitCode: 0,
            alreadyExecutedInTurn: true,
            stdout: `[DUPLICATE_COMMAND_SKIPPED]: You already executed this exact command in this turn and received its output above. Do NOT repeat the same command; proceed immediately to the next step!`,
            stderr: '',
          };
        }
        if (normCmd) {
          executedCommandCounts.set(normCmd, prevCmdCount + 1);
        }
        const res = (await runCapabilityTool('run-build', { command }, 'high')) as {
          exitCode: number;
          stdout: string;
          stderr: string;
          durationMs: number;
        };
        recordCommandOutcome(command, res);
        const expandedStdout = await autoExpandPartialSedRead(command, res.stdout || '');
        const errorContext =
          res.exitCode !== 0 || /error:/i.test(res.stderr || '') || /error:/i.test(res.stdout || '')
            ? await autoExtractCompilerErrorContext(res.stdout || '', res.stderr || '')
            : '';
        return {
          command,
          exitCode: res.exitCode,
          durationMs: res.durationMs,
          stdout: `${expandedStdout.slice(0, 8000)}${errorContext}`,
          stderr: res.stderr.slice(0, 4000),
        };
      },
    }),
    createTool({
      name: 'connect_remote_ssh',
      description:
        'Automatically log in and connect to a Remote Linux SSH server (using either saved SSH profile credentials or host/username/password/remotePath provided by the user) and switch the active workspace to the remote project mirror.',
      inputSchema: {
        type: 'object',
        properties: {
          host: {
            type: 'string',
            description: 'Remote server IP or hostname (leave empty to auto-reconnect the most recently saved SSH profile)',
          },
          port: {
            type: 'number',
            description: 'SSH port (default 22)',
          },
          username: {
            type: 'string',
            description: 'SSH username (e.g. "root")',
          },
          password: {
            type: 'string',
            description: 'Optional SSH password if using password authentication',
          },
          remotePath: {
            type: 'string',
            description: 'Remote project directory path (e.g. "/home/renjc01/Bug/fhccl")',
          },
        },
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const workbenchPort = Number(process.env.DEEPAUTOCODE_PORT || 3840);
        try {
          let profileToConnect: Record<string, unknown> = { ...rawArgs };
          if (!rawArgs?.host) {
            const statusRes = await postJsonOnce({
              url: `http://127.0.0.1:${workbenchPort}/api/ssh/status`,
              headers: {},
              body: {},
            }).catch(() => null);
            if (statusRes?.ok) {
              const parsed = JSON.parse(statusRes.text || '{}');
              if (parsed?.status?.connected && parsed?.status?.activeProfile) {
                return {
                  ok: true,
                  alreadyConnected: true,
                  activeProfile: parsed.status.activeProfile,
                  mirrorWorkspaceRoot: parsed.status.mirrorWorkspaceRoot,
                };
              }
              if (Array.isArray(parsed?.profiles) && parsed.profiles.length > 0) {
                profileToConnect = parsed.profiles[0];
              }
            }
          }
          const connRes = await postJsonOnce({
            url: `http://127.0.0.1:${workbenchPort}/api/ssh/connect`,
            headers: { 'Content-Type': 'application/json' },
            body: profileToConnect,
            timeoutMs: 25000,
          });
          const data = JSON.parse(connRes.text || '{}');
          return data;
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
    createTool({
      name: 'auto_build_and_test',
      description:
        'Automatically detect the project build & test system (CMake/Make/HIP/NCCL-Test/Node/Pytest), execute compilation and verification tests on the active Local or Remote SSH workspace, and automatically extract offending source code lines on any error.',
      inputSchema: {
        type: 'object',
        properties: {
          customBuildCommand: {
            type: 'string',
            description: 'Optional explicit build + test command (if omitted, auto-detects build/Makefile, Makefile, package.json, etc.)',
          },
        },
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        let cmd = String(rawArgs?.customBuildCommand || '').trim();
        if (!cmd) {
          cmd = preferredVerifyCommand;
        }
        const res = (await runCapabilityTool('run-build', { command: cmd }, 'high')) as {
          exitCode: number;
          stdout: string;
          stderr: string;
          durationMs: number;
        };
        recordCommandOutcome(cmd, res);
        const errorContext =
          res.exitCode !== 0 || /error:|FAILED|#wrong=[1-9]/i.test(`${res.stdout}\n${res.stderr}`)
            ? await autoExtractCompilerErrorContext(res.stdout || '', res.stderr || '')
            : '';
        return {
          command: cmd,
          exitCode: res.exitCode,
          durationMs: res.durationMs,
          stdout: `${(res.stdout || '').slice(0, 8000)}${errorContext}`,
          stderr: (res.stderr || '').slice(0, 4000),
        };
      },
    }),
    createTool({
      name: 'open_file',
      description: 'Open a file in the IDE editor.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Relative path to the file in the workspace',
          },
        },
        required: ['filePath'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const filePath = runtimeCtx.normalizeWorkspaceRelativePath(
          String(rawArgs?.filePath || rawArgs?.path || ''),
          manifest.workspaceRoot
        );
        return await runCapabilityTool('open-file', { filePath }, 'low');
      },
    }),
    createTool({
      name: 'write_artifact',
      description:
        'Create or update an Antigravity structured Markdown Artifact (Implementation Plan, Task Checklist, Walkthrough, or Architecture Report). Permitted in both Plan and Auto modes so plans can be reviewed and executed from the IDE Artifacts Pane.',
      inputSchema: {
        type: 'object',
        properties: {
          artifactType: {
            type: 'string',
            enum: ['plan', 'task_list', 'walkthrough', 'report'],
            description: 'Category of artifact',
          },
          title: {
            type: 'string',
            description: 'Human-readable artifact title (e.g. "Implementation Plan")',
          },
          content: {
            type: 'string',
            description: 'Markdown content of the artifact',
          },
        },
        required: ['title', 'content'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const artifactType = String(rawArgs?.artifactType || 'plan') as
          | 'plan'
          | 'task_list'
          | 'walkthrough'
          | 'report';
        const title = String(rawArgs?.title || 'Implementation Plan').trim();
        const content = String(rawArgs?.content || '').trim();
        const saved = await persistSessionArtifact({
          artifactType,
          title,
          content,
          source: 'write_artifact',
        });
        return {
          ok: true,
          ...saved,
          notice: `Artifact "${title}" (${artifactType}) saved to IDE Artifacts Pane.`,
        };
      },
    }),
    createTool({
      name: 'invoke_subagent',
      description:
        'Invoke a specialized or custom Antigravity subagent (role/typeName: "research" | "planner" | "verifier" | "editor" | "self" | custom name) with optional Git worktree isolation (workspace: "inherit" | "branch" | "share") and optional async background execution (runInBackground: true).',
      inputSchema: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            description:
              'Subagent role or custom typeName (e.g. "research", "planner", "verifier", "editor", "self", or custom name from define_subagent)',
          },
          typeName: {
            type: 'string',
            description: 'Optional alias for role / custom subagent type name',
          },
          task: {
            type: 'string',
            description: 'Specific task description / prompt for the subagent',
          },
          prompt: {
            type: 'string',
            description: 'Optional alias for task',
          },
          workspace: {
            type: 'string',
            enum: ['inherit', 'branch', 'share'],
            description:
              'Workspace isolation mode: "inherit" (default), "branch" or "share" (creates an isolated Git worktree branch)',
          },
          runInBackground: {
            type: 'boolean',
            description:
              'Set true to launch asynchronously in the background and return conversationId immediately',
          },
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional keyword/symbol queries to search in parallel',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional workspace files to inspect in parallel',
          },
        },
        required: ['role', 'task'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const role = String(rawArgs?.typeName || rawArgs?.role || 'research');
        const task = String(rawArgs?.prompt || rawArgs?.task || '');
        const workspaceMode = (rawArgs?.workspace as 'inherit' | 'branch' | 'share') || 'inherit';
        const runInBackground = Boolean(rawArgs?.runInBackground);
        const queries = Array.isArray(rawArgs?.queries)
          ? rawArgs.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4)
          : [];
        const files = Array.isArray(rawArgs?.files)
          ? rawArgs.files.map((f) => String(f).trim()).filter(Boolean).slice(0, 4)
          : sessionWrittenFiles.slice(-6);

        if (
          globalSubagentOrchestrator &&
          (workspaceMode === 'branch' ||
            workspaceMode === 'share' ||
            runInBackground ||
            !['research', 'planner', 'verifier', 'editor'].includes(role.toLowerCase()))
        ) {
          const spawned = await globalSubagentOrchestrator.spawnSubagent({
            parentSessionId: sessionId,
            typeName: role,
            role,
            prompt: task,
            workspaceMode,
            workspaceRoot: manifest.workspaceRoot,
            runInBackground,
            executor: async ({ definition, workspacePath, signal: subSignal, getInboxMessages }) => {
              // Kernel Upgrade 1: Multi-Turn Tool-Calling Subagent Loop scoped to workspacePath (Git worktree)
              const subTools = [
                createTool({
                  name: 'read_file',
                  description: 'Read a file inside the subagent workspace.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      filePath: { type: 'string' },
                      startLine: { type: 'number' },
                      endLine: { type: 'number' },
                    },
                    required: ['filePath'],
                  },
                  execute: async (a: Record<string, unknown>) => {
                    const rel = runtimeCtx.normalizeWorkspaceRelativePath(String(a.filePath || ''), workspacePath);
                    const abs = path.resolve(workspacePath, rel);
                    if (!abs.startsWith(path.resolve(workspacePath))) {
                      return { error: 'PATH_OUTSIDE_WORKTREE' };
                    }
                    const raw = await fs.readFile(abs, 'utf-8');
                    const lines = raw.split(/\r?\n/);
                    const s = Math.max(1, Number(a.startLine ?? 1));
                    const e = Math.min(lines.length, Number(a.endLine ?? Math.min(lines.length, s + 160)));
                    return {
                      filePath: rel,
                      totalLines: lines.length,
                      content: lines.slice(s - 1, e).map((l, idx) => `${s + idx}: ${l}`).join('\n'),
                    };
                  },
                }),
                ...(definition.enableWriteTools
                  ? [
                    createTool({
                      name: 'edit_file',
                      description: 'Replace oldText with newText in a file inside the subagent workspace.',
                      inputSchema: {
                        type: 'object',
                        properties: {
                          filePath: { type: 'string' },
                          oldText: { type: 'string' },
                          newText: { type: 'string' },
                        },
                        required: ['filePath', 'oldText', 'newText'],
                      },
                      execute: async (a: Record<string, unknown>) => {
                        const rel = runtimeCtx.normalizeWorkspaceRelativePath(String(a.filePath || ''), workspacePath);
                        const abs = path.resolve(workspacePath, rel);
                        if (!abs.startsWith(path.resolve(workspacePath))) {
                          return { ok: false, error: 'PATH_OUTSIDE_WORKTREE' };
                        }
                        const raw = await fs.readFile(abs, 'utf-8');
                        const oldStr = String(a.oldText || '');
                        const newStr = String(a.newText ?? '');
                        if (!oldStr || !raw.includes(oldStr)) {
                          return { ok: false, error: 'oldText not found in file' };
                        }
                        const updated = raw.replace(oldStr, newStr);
                        await fs.writeFile(abs, updated, 'utf-8');
                        return { ok: true, filePath: rel };
                      },
                    }),
                    createTool({
                      name: 'write_file',
                      description: 'Write a file inside the subagent workspace.',
                      inputSchema: {
                        type: 'object',
                        properties: {
                          filePath: { type: 'string' },
                          content: { type: 'string' },
                        },
                        required: ['filePath', 'content'],
                      },
                      execute: async (a: Record<string, unknown>) => {
                        const rel = runtimeCtx.normalizeWorkspaceRelativePath(String(a.filePath || ''), workspacePath);
                        const abs = path.resolve(workspacePath, rel);
                        if (!abs.startsWith(path.resolve(workspacePath))) {
                          return { ok: false, error: 'PATH_OUTSIDE_WORKTREE' };
                        }
                        await fs.mkdir(path.dirname(abs), { recursive: true });
                        await fs.writeFile(abs, String(a.content ?? ''), 'utf-8');
                        return { ok: true, filePath: rel };
                      },
                    }),
                    createTool({
                      name: 'run_command',
                      description: 'Run a shell command inside the subagent workspace.',
                      inputSchema: {
                        type: 'object',
                        properties: { command: { type: 'string' } },
                        required: ['command'],
                      },
                      execute: async (a: Record<string, unknown>) => {
                        if (!globalBackgroundTaskManager) return { ok: false };
                        const bg = await globalBackgroundTaskManager.runOrBackgroundCommand({
                          sessionId,
                          command: String(a.command || ''),
                          cwd: workspacePath,
                          waitMsBeforeAsync: 15_000,
                          signal: subSignal,
                        });
                        return {
                          exitCode: bg.task.exitCode,
                          stdout: bg.task.stdout.slice(-4000),
                          stderr: bg.task.stderr.slice(-2000),
                        };
                      },
                    }),
                  ]
                  : []),
              ];

              const subToolMap = new Map(subTools.map((t: any) => [t.name, t]));
              const openAiTools = subTools.map((t: any) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                },
              }));

              const subMessages: Array<Record<string, any>> = [
                {
                  role: 'system',
                  content: `${definition.systemPrompt}\nSubagent Workspace Root: ${workspacePath}`,
                },
                {
                  role: 'user',
                  content: `Task: ${task}`,
                },
              ];

              let finalSummary = '';
              for (let turn = 0; turn < 5; turn++) {
                if (subSignal.aborted) break;
                const inbox = getInboxMessages();
                if (inbox.length > 0 && turn > 0) {
                  subMessages.push({
                    role: 'user',
                    content: `[Follow-up message from parent agent]: ${inbox.map((m) => m.content).join('\n')}`,
                  });
                }
                const resp = await postJsonResilient({
                  url: endpoint,
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                  },
                  body: {
                    model: /deepseek/i.test(manifest.modelId || provider.defaultModelId)
                      ? DEEPSEEK_FLASH
                      : manifest.modelId || provider.defaultModelId,
                    messages: subMessages,
                    tools: openAiTools,
                    max_tokens: 1500,
                    temperature: 0.15,
                  },
                  signal: subSignal,
                  timeoutMs: 25_000,
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = JSON.parse(resp.text || '{}');
                const choiceMsg = data?.choices?.[0]?.message;
                if (!choiceMsg) break;
                if (typeof choiceMsg.content === 'string' && choiceMsg.content.trim()) {
                  finalSummary = choiceMsg.content.trim();
                }
                const tCalls = Array.isArray(choiceMsg.tool_calls) ? choiceMsg.tool_calls : [];
                if (tCalls.length === 0) {
                  break;
                }
                subMessages.push({
                  role: 'assistant',
                  content: choiceMsg.content || '',
                  tool_calls: tCalls,
                });
                for (const tc of tCalls) {
                  const fnName = String(tc?.function?.name || '');
                  let fnArgs: Record<string, unknown> = {};
                  try {
                    fnArgs = JSON.parse(tc?.function?.arguments || '{}');
                  } catch {
                    fnArgs = {};
                  }
                  const targetTool = subToolMap.get(fnName);
                  let toolOut: unknown = { error: `Tool not found: ${fnName}` };
                  if (targetTool) {
                    try {
                      toolOut = await targetTool.execute(fnArgs);
                    } catch (err) {
                      toolOut = { error: (err as Error).message };
                    }
                  }
                  subMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify(toolOut).slice(0, 6000),
                  });
                }
              }
              return finalSummary || 'Subagent completed multi-turn execution.';
            },
          });
          return {
            ok: true,
            conversationId: spawned.conversationId,
            asyncLaunched: spawned.asyncLaunched,
            workspaceMode,
            workspacePath: spawned.snapshot.workspacePath,
            worktreeBranch: spawned.snapshot.worktreeBranch,
            state: spawned.snapshot.state,
            report:
              spawned.result ||
              `Subagent launched in background (${spawned.conversationId}). You will receive a <SYSTEM_MESSAGE> when it finishes, or use manage_subagents / send_message.`,
          };
        }

        const digestLines: string[] = [
          `[Subagent (${role.toUpperCase()}) Completed Task: ${task}]`,
        ];

        if (role === 'editor' && typeof runEditSubagent === 'function') {
          const sandbox =
            typeof createSubagentSandbox === 'function'
              ? createSubagentSandbox('editor')
              : null;
          const targetFiles =
            files.length > 0
              ? files
                .map((f) => runtimeCtx.normalizeWorkspaceRelativePath(f, manifest.workspaceRoot))
                .slice(0, 3)
              : Array.from(new Set(sessionWrittenFiles.slice(-4)));
          const result = await runEditSubagent({
            task,
            files: targetFiles,
            maxFiles: 3,
            maxEdits: 6,
            readFile: async (relPath: string) => {
              const run = async () => {
                const res = (await runCapabilityTool(
                  'read-file',
                  { filePath: relPath },
                  'low'
                )) as { content: string };
                return res?.content || '';
              };
              return sandbox ? sandbox.wrap('read_file', relPath, run) : run();
            },
            // Stage S1: always go through applyFileEdit so Diff / Manual approval apply
            writeFile: async (relPath: string, content: string) => {
              const run = async () => {
                const writeRes = await applyFileEdit(relPath, content);
                recordCompiledFileEdit(relPath);
                fileStateCache.recordRead({
                  filePath: relPath,
                  content,
                  isPartialView: false,
                });
                void writeRes;
              };
              return sandbox ? sandbox.wrap('write_file', relPath, run) : run();
            },
            applyEdit: async (relPath: string, oldText: string, newText: string) => {
              const run = async () => {
                try {
                  const current = (await runCapabilityTool(
                    'read-file',
                    { filePath: relPath },
                    'low'
                  )) as { content: string };
                  const next = runtimeCtx.applySmartTextReplacement(
                    current.content || '',
                    oldText,
                    newText,
                    relPath
                  );
                  const writeRes = await applyFileEdit(relPath, next);
                  recordCompiledFileEdit(relPath);
                  fileStateCache.recordRead({
                    filePath: relPath,
                    content: next,
                    isPartialView: false,
                  });
                  return { ok: true, content: next, diffId: writeRes.diffId };
                } catch (err) {
                  return { ok: false, error: (err as Error).message };
                }
              };
              return sandbox ? sandbox.wrap('edit_file', relPath, run) : run();
            },
            diagnose: async (relPath: string, content: string) => {
              const run = async () => {
                try {
                  const post = await runPostEditDiagnostics(relPath, content);
                  return post.semanticErrors || null;
                } catch {
                  return null;
                }
              };
              return sandbox ? sandbox.wrap('diagnose', relPath, run) : run();
            },
            // Stage T4: shared diagnose→verify contract with verifier
            verify: async () => {
              const run = async () => {
                if (!preferredVerifyCommand) {
                  return { skipped: true, reason: 'no verify command configured' };
                }
                try {
                  const res = (await runCapabilityTool(
                    'run-build',
                    { command: preferredVerifyCommand },
                    'high'
                  )) as { exitCode: number; stdout: string; stderr: string };
                  recordCommandOutcome(preferredVerifyCommand, res);
                  return {
                    exitCode: res.exitCode,
                    stdout: (res.stdout || '').slice(0, 2000),
                    stderr: (res.stderr || '').slice(0, 1200),
                  };
                } catch (err) {
                  return { exitCode: 1, stderr: (err as Error).message };
                }
              };
              return sandbox ? sandbox.wrap('verify', preferredVerifyCommand, run) : run();
            },
            llmPropose: async ({ task: editTask, snippets }) => {
              const run = async () => {
                try {
                  const resp = await postJsonResilient({
                    url: endpoint,
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: {
                      model: /deepseek/i.test(manifest.modelId || provider.defaultModelId)
                        ? DEEPSEEK_FLASH
                        : manifest.modelId || provider.defaultModelId,
                      messages: [
                        {
                          role: 'system',
                          content:
                            'You are a budgeted edit subagent. Reply with JSON only: [{"filePath":"...","oldText":"...","newText":"..."}]. Max 6 edits across at most 3 files. oldText must be an exact contiguous snippet from the provided files. No markdown except optional ```json fence.',
                        },
                        {
                          role: 'user',
                          content: [
                            `Task: ${editTask.slice(0, 1500)}`,
                            '',
                            ...snippets.map(
                              (s) => `### FILE ${s.filePath}\n\`\`\`\n${s.content}\n\`\`\``
                            ),
                          ].join('\n'),
                        },
                      ],
                      max_tokens: 2500,
                      temperature: 0.1,
                    },
                    signal,
                    timeoutMs: 20_000,
                  });
                  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                  const data = JSON.parse(resp.text || '{}');
                  return String(data?.choices?.[0]?.message?.content || '');
                } catch {
                  return '[]';
                }
              };
              return sandbox ? sandbox.wrap('llm_propose', undefined, run) : run();
            },
          });
          const report = sandbox
            ? sandbox.capReport(
              `${result.report}\n\n## Sandbox transcript\n${sandbox.formatTranscript()}`
            )
            : result.report;
          try {
            await persistSessionArtifact({
              artifactType: 'report',
              title: `Editor: ${task.slice(0, 80)}`,
              content: report || '',
              source: 'invoke_subagent:editor',
            });
          } catch {
            // best-effort
          }
          return {
            ok: result.ok,
            role: 'editor',
            task,
            filesInspected: result.filesInspected,
            filesEdited: result.filesEdited,
            editsApplied: result.editsApplied,
            rolledBack: result.rolledBack,
            verified: result.verified,
            report,
            errors: result.errors,
            sandbox: sandbox?.summary(),
          };
        }

        if (role === 'verifier') {
          const sandbox =
            typeof createSubagentSandbox === 'function'
              ? createSubagentSandbox('verifier')
              : null;
          const targetFiles =
            files.length > 0
              ? files.map((f) =>
                runtimeCtx.normalizeWorkspaceRelativePath(f, manifest.workspaceRoot)
              )
              : Array.from(new Set(sessionWrittenFiles.slice(-8)));

          const gate =
            typeof runDiagnoseAndVerify === 'function'
              ? await runDiagnoseAndVerify({
                files: targetFiles.slice(0, 6),
                alwaysVerify: true,
                readFile: async (relPath: string) => {
                  const run = async () => {
                    const res = (await runCapabilityTool(
                      'read-file',
                      { filePath: relPath },
                      'low'
                    )) as { content: string };
                    return res?.content || '';
                  };
                  return sandbox ? sandbox.wrap('read_file', relPath, run) : run();
                },
                diagnose: async (relPath: string, content: string) => {
                  const run = async () => {
                    try {
                      const post = await runPostEditDiagnostics(relPath, content);
                      return post.semanticErrors || null;
                    } catch {
                      return null;
                    }
                  };
                  return sandbox ? sandbox.wrap('diagnose', relPath, run) : run();
                },
                verify: async () => {
                  const run = async () => {
                    if (!preferredVerifyCommand) {
                      return { skipped: true, reason: 'no verify command configured' };
                    }
                    try {
                      const res = (await runCapabilityTool(
                        'run-build',
                        { command: preferredVerifyCommand },
                        'high'
                      )) as { exitCode: number; stdout: string; stderr: string };
                      recordCommandOutcome(preferredVerifyCommand, res);
                      return {
                        exitCode: res.exitCode,
                        stdout: (res.stdout || '').slice(0, 2500),
                        stderr: (res.stderr || '').slice(0, 1500),
                      };
                    } catch (err) {
                      return { exitCode: 1, stderr: (err as Error).message };
                    }
                  };
                  return sandbox
                    ? sandbox.wrap('verify', preferredVerifyCommand, run)
                    : run();
                },
              })
              : null;

          const passed = gate ? gate.passed : false;
          lastVerifierPass = passed;
          if (!passed) {
            if (gate?.semanticFailed) lastSemanticFailed = true;
            if (gate?.verifyFailed) lastBuildOrTestFailed = true;
          }

          const reportBody = [
            `[Subagent (VERIFIER) Completed Task: ${task}]`,
            `## Verdict: ${passed ? 'PASS' : 'FAIL'}`,
            `## Language diagnostics\n${gate?.diagLines.join('\n\n') || '(no files)'}`,
            `## Verify command\n\`${preferredVerifyCommand}\`\nexit=${gate?.verifyResult.exitCode ?? 'n/a'}\n${gate?.verifyResult.stdout || ''
            }\n${gate?.verifyResult.stderr || ''}${gate?.verifyResult.skipped ? `\n(skipped: ${gate.verifyResult.reason})` : ''
            }`,
            sandbox ? `## Sandbox transcript\n${sandbox.formatTranscript()}` : '',
          ]
            .filter(Boolean)
            .join('\n\n');

          return {
            ok: true,
            role,
            task,
            passed,
            filesInspected: targetFiles,
            report: sandbox ? sandbox.capReport(reportBody, 7000) : reportBody.slice(0, 7000),
            sandbox: sandbox?.summary(),
          };
        }

        // research / planner: multi-round read-only exploration (no nested LLM)
        if (
          (role === 'research' || role === 'planner') &&
          typeof runResearchSubagent === 'function'
        ) {
          const sandbox =
            typeof createSubagentSandbox === 'function'
              ? createSubagentSandbox(role === 'planner' ? 'planner' : 'research')
              : null;
          const runner =
            role === 'planner' && typeof runPlannerSubagent === 'function'
              ? runPlannerSubagent
              : runResearchSubagent;
          const result = await runner({
            workspaceRoot: manifest.workspaceRoot,
            task,
            queries,
            files: files.map((f) =>
              runtimeCtx.normalizeWorkspaceRelativePath(f, manifest.workspaceRoot)
            ),
            index: workspaceFileIndex || undefined,
            maxRounds: role === 'planner' ? 2 : 4,
            maxReportChars: 5500,
            llmDecompose: async (researchTask: string) => {
              const run = async () => {
                try {
                  const resp = await postJsonResilient({
                    url: endpoint,
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: {
                      model: /deepseek/i.test(manifest.modelId || provider.defaultModelId)
                        ? DEEPSEEK_FLASH
                        : manifest.modelId || provider.defaultModelId,
                      messages: [
                        {
                          role: 'system',
                          content:
                            'You decompose coding research tasks into sharp questions and search queries. Reply with JSON only: {"questions":["..."],"searchQueries":["ident","path.ts"]}. Max 6 questions and 8 searchQueries. No markdown.',
                        },
                        { role: 'user', content: researchTask.slice(0, 1200) },
                      ],
                      max_tokens: 400,
                      temperature: 0.1,
                    },
                    signal,
                    timeoutMs: 8000,
                  });
                  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                  const data = JSON.parse(resp.text || '{}');
                  return String(data?.choices?.[0]?.message?.content || '');
                } catch {
                  return '';
                }
              };
              return sandbox ? sandbox.wrap('llm_decompose', undefined, run) : run();
            },
            llmSynthesize: async ({ task: researchTask, evidence }) => {
              const run = async () => {
                try {
                  const resp = await postJsonResilient({
                    url: endpoint,
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: {
                      model: /deepseek/i.test(manifest.modelId || provider.defaultModelId)
                        ? DEEPSEEK_FLASH
                        : manifest.modelId || provider.defaultModelId,
                      messages: [
                        {
                          role: 'system',
                          content:
                            'You are a budgeted research subagent. From the evidence, output 5-12 lines: root cause hypothesis with file:line cites, key files, and next edit/verify steps. No tools. Be concrete.',
                        },
                        {
                          role: 'user',
                          content: `Task: ${researchTask.slice(0, 800)}\n\nEvidence:\n${evidence.slice(0, 4500)}`,
                        },
                      ],
                      max_tokens: 500,
                      temperature: 0.15,
                    },
                    signal,
                    timeoutMs: 12_000,
                  });
                  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                  const data = JSON.parse(resp.text || '{}');
                  return String(data?.choices?.[0]?.message?.content || '');
                } catch {
                  return '';
                }
              };
              return sandbox ? sandbox.wrap('llm_synthesize', undefined, run) : run();
            },
            search: async (query: string) => {
              const run = async () => {
                if (workspaceFileIndex && typeof searchIndexedFiles === 'function') {
                  return searchIndexedFiles({
                    root: manifest.workspaceRoot,
                    index: workspaceFileIndex,
                    query,
                    mode: 'auto',
                    maxMatches: 30,
                    contextLines: 2,
                  });
                }
                return 'No matches found.';
              };
              return sandbox ? sandbox.wrap('search', query, run) : run();
            },
            readFile: async (relPath: string) => {
              const run = async () => {
                const res = (await runCapabilityTool(
                  'read-file',
                  { filePath: relPath },
                  'low'
                )) as { content: string };
                return res?.content || '';
              };
              return sandbox ? sandbox.wrap('read_file', relPath, run) : run();
            },
          });
          if (sessionTodos && Array.isArray(result.suggestedTodos) && sessionTodos.list().length === 0) {
            sessionTodos.manage({
              action: 'set',
              items: result.suggestedTodos.map((content: string) => ({
                content,
                status: 'pending' as const,
              })),
            });
          }
          const cappedReport = sandbox
            ? sandbox.capReport(
              `${result.report}\n\n## Sandbox transcript\n${sandbox.formatTranscript()}`
            )
            : result.report;
          let artifactId: string | undefined;
          try {
            const artType = role === 'planner' ? 'plan' : 'report';
            const saved = await persistSessionArtifact({
              artifactType: artType,
              title:
                role === 'planner'
                  ? `Plan: ${task.slice(0, 80)}`
                  : `Research: ${task.slice(0, 80)}`,
              content: cappedReport || '',
              source: `invoke_subagent:${role}`,
            });
            artifactId = saved.artifactId;
            if (sessionTodos && sessionTodos.list().length > 0) {
              await persistSessionArtifact({
                artifactType: 'task_list',
                title: `Todos: ${task.slice(0, 60)}`,
                content: `# Session Todos\n\n${sessionTodos.formatForPrompt()}\n`,
                source: 'invoke_subagent:todos',
              });
            }
          } catch {
            // artifact persistence is best-effort
          }
          return {
            ok: true,
            role: result.role,
            task,
            rounds: result.rounds,
            queries: result.queries,
            filesInspected: result.filesInspected,
            suggestedTodos: result.suggestedTodos,
            sessionTodos: sessionTodos?.list() || [],
            report: cappedReport,
            artifactId,
            sandbox: sandbox?.summary(),
          };
        }

        for (const f of files) {
          const relPath = runtimeCtx.normalizeWorkspaceRelativePath(f, manifest.workspaceRoot);
          try {
            const res = (await runCapabilityTool('read-file', { filePath: relPath }, 'low')) as {
              content: string;
            };
            const outline = extractCodeOutline(res.content, 40, relPath).join('\n');
            digestLines.push(
              `### Inspected \`${relPath}\` (${res.content.split(/\r?\n/).length} lines)\n${outline || res.content.slice(0, 1200)
              }`
            );
          } catch {
            // ignore
          }
        }
        return {
          ok: true,
          role,
          task,
          queries,
          filesInspected: files,
          report: digestLines.join('\n\n').slice(0, 6000),
        };
      },
    }),
    createTool({
      name: 'manage_todo',
      description:
        'Session task checklist for long-horizon goals. Use action=set/add/update/complete/list to track what is done vs remaining. Incomplete todos are auto-injected on self-heal continuations.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'set', 'add', 'update', 'complete', 'cancel', 'clear'],
            description: 'Todo mutation',
          },
          items: {
            type: 'array',
            description: 'Full list for action=set: [{ content, status? }]',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                content: { type: 'string' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                },
              },
              required: ['content'],
            },
          },
          id: { type: 'string', description: 'Todo id for update/complete/cancel' },
          content: { type: 'string', description: 'Todo text for add/update' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
          },
        },
        required: ['action'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!sessionTodos) {
          return { ok: false, error: 'Session todos unavailable.' };
        }
        const result = sessionTodos.manage({
          action: String(rawArgs?.action || 'list') as any,
          items: Array.isArray(rawArgs?.items) ? (rawArgs.items as any) : undefined,
          id: rawArgs?.id ? String(rawArgs.id) : undefined,
          content: rawArgs?.content ? String(rawArgs.content) : undefined,
          status: rawArgs?.status as any,
        });
        const action = String(rawArgs?.action || 'list');
        if (
          result.ok &&
          ['set', 'add', 'update', 'complete', 'cancel'].includes(action) &&
          sessionTodos.list().length > 0
        ) {
          try {
            await persistSessionArtifact({
              artifactType: 'task_list',
              title: 'Session Todos',
              content: `# Session Todos\n\n${sessionTodos.formatForPrompt()}\n`,
              source: 'manage_todo',
            });
          } catch {
            // ignore
          }
        }
        return result;
      },
    }),
    createTool({
      name: 'browser_action',
      description:
        'Inspect and (with Chrome CDP) interact with running web apps. Actions: navigate, get_html, snapshot, inspect_elements, get_console_logs, click, type, screenshot. Prefers CDP at DEEPAUTOCODE_CDP_URL / localhost:9222; falls back to structured HTTP snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'navigate',
              'get_html',
              'snapshot',
              'inspect_elements',
              'get_console_logs',
              'click',
              'type',
              'screenshot',
            ],
            description: 'Browser action to execute',
          },
          url: {
            type: 'string',
            description: 'Target web URL (defaults to http://localhost:3000/)',
          },
          selector: {
            type: 'string',
            description: 'CSS selector for click/type/inspect',
          },
          text: {
            type: 'string',
            description: 'Text to type into selector (action=type)',
          },
        },
        required: ['action'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        const { runBrowserAction } = await import('../../core/AgentBrowser.js');
        return runBrowserAction({
          action: String(rawArgs?.action || 'navigate'),
          url: rawArgs?.url ? String(rawArgs.url) : undefined,
          selector: rawArgs?.selector ? String(rawArgs.selector) : undefined,
          text: rawArgs?.text ? String(rawArgs.text) : undefined,
        });
      },
    }),
    createTool({
      name: 'manage_task',
      description:
        'Manage background tasks started in this session: "list" all tasks, check "status" and recent stdout/stderr of a taskId, "send_input" to stdin, or "kill" a running task.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'status', 'send_input', 'kill'],
            description: 'Action to perform on background tasks',
          },
          taskId: {
            type: 'string',
            description: 'Task ID returned by run_command or list (required for status/send_input/kill)',
          },
          input: {
            type: 'string',
            description: 'Text input to send to stdin (required for send_input)',
          },
        },
        required: ['action'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!globalBackgroundTaskManager) {
          return { ok: false, error: 'BackgroundTaskManager unavailable' };
        }
        const action = String(rawArgs?.action || 'list');
        const targetTaskId = rawArgs?.taskId ? String(rawArgs.taskId) : '';
        if (action === 'list') {
          return {
            ok: true,
            tasks: globalBackgroundTaskManager.listTasks(sessionId),
          };
        }
        if (action === 'status') {
          const snap = globalBackgroundTaskManager.getTaskStatus(targetTaskId);
          if (!snap) return { ok: false, error: `Task not found: ${targetTaskId}` };
          return { ok: true, task: snap };
        }
        if (action === 'send_input') {
          const res = globalBackgroundTaskManager.sendTaskInput(
            targetTaskId,
            String(rawArgs?.input ?? '')
          );
          const snap = globalBackgroundTaskManager.getTaskStatus(targetTaskId);
          if (snap) {
            runtimeCtx.emit({ type: 'task_state_changed', sessionId, payload: { task: snap } });
          }
          return { ...res, task: snap };
        }
        if (action === 'kill') {
          const res = globalBackgroundTaskManager.killTask(targetTaskId);
          const snap = globalBackgroundTaskManager.getTaskStatus(targetTaskId);
          if (snap) {
            runtimeCtx.emit({ type: 'task_state_changed', sessionId, payload: { task: snap } });
          }
          return { ...res, task: snap };
        }
        return { ok: false, error: `Unsupported manage_task action: ${action}` };
      },
    }),
    createTool({
      name: 'ask_question',
      description:
        'Ask the user one or more structured multiple-choice questions in the Composer UI to clarify ambiguous requirements or architectural choices, and wait for their selection.',
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'List of questions to present to the user',
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The question text',
                },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Choices to present. Put the recommended choice first, prefixed with "(Recommended)".',
                },
                isMultiSelect: {
                  type: 'boolean',
                  description: 'Whether the user can select multiple choices',
                },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!globalQuestionBridge) {
          return { ok: false, error: 'QuestionBridge unavailable' };
        }
        const rawQuestions = Array.isArray(rawArgs?.questions) ? rawArgs.questions : [];
        const normalizedQuestions = rawQuestions
          .map((q: any, idx: number) => ({
            id: String(q?.id || `q_${idx + 1}`),
            question: String(q?.question || '').trim(),
            options: Array.isArray(q?.options)
              ? q.options.map((o: any) => String(o)).filter(Boolean)
              : [],
            isMultiSelect: Boolean(q?.isMultiSelect ?? q?.is_multi_select),
          }))
          .filter((q: any) => q.question.length > 0 && q.options.length > 0);
        if (normalizedQuestions.length === 0) {
          return { ok: false, error: 'At least one valid question with options is required.' };
        }
        const res = await globalQuestionBridge.ask({
          sessionId,
          questions: normalizedQuestions,
          signal,
          onPromptCreated: (req) => {
            runtimeCtx.emit({
              type: 'question_requested',
              sessionId,
              payload: req as unknown as Record<string, unknown>,
            });
          },
        });
        runtimeCtx.emit({
          type: 'question_resolved',
          sessionId,
          payload: res as unknown as Record<string, unknown>,
        });
        return res;
      },
    }),
    createTool({
      name: 'search_web',
      description:
        'Perform a web search for documentation, APIs, error messages, or technical references. Returns a summary and URL citations.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query keywords',
          },
          domain: {
            type: 'string',
            description: 'Optional domain filter to prioritize (e.g. "docs.python.org", "github.com")',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum results to return (default 6)',
          },
        },
        required: ['query'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (typeof performWebSearch !== 'function') {
          return { ok: false, error: 'WebSearch module unavailable' };
        }
        return performWebSearch({
          query: String(rawArgs?.query || ''),
          domain: rawArgs?.domain ? String(rawArgs.domain) : undefined,
          maxResults:
            typeof rawArgs?.maxResults === 'number' ? Number(rawArgs.maxResults) : 6,
        });
      },
    }),
    createTool({
      name: 'define_subagent',
      description:
        'Define a new custom subagent type for this conversation (and workspace) that can be invoked via invoke_subagent.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Unique subagent type name (e.g. "db-debugger", "security-auditor")',
          },
          description: {
            type: 'string',
            description: 'When and why this subagent should be used',
          },
          systemPrompt: {
            type: 'string',
            description: 'System prompt instructions for this subagent',
          },
          enableWriteTools: {
            type: 'boolean',
            description: 'Grant file editing and command execution tools',
          },
          enableMcpTools: {
            type: 'boolean',
            description: 'Grant MCP tool access',
          },
        },
        required: ['name', 'description', 'systemPrompt'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!globalSubagentOrchestrator) {
          return { ok: false, error: 'SubagentOrchestrator unavailable' };
        }
        const def = globalSubagentOrchestrator.defineSubagent({
          name: String(rawArgs?.name || ''),
          description: String(rawArgs?.description || ''),
          systemPrompt: String(rawArgs?.systemPrompt || ''),
          enableWriteTools: Boolean(rawArgs?.enableWriteTools),
          enableMcpTools: Boolean(rawArgs?.enableMcpTools),
          source: 'dynamic',
        });
        return { ok: true, subagent: def };
      },
    }),
    createTool({
      name: 'manage_subagents',
      description:
        'Manage active subagents of this session: "list" active subagents and their conversationIds/states, "kill" specific conversationIds, or "kill_all".',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'kill', 'kill_all'],
            description: 'Action to perform',
          },
          conversationIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Subagent conversationIds to kill (required for action="kill")',
          },
        },
        required: ['action'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!globalSubagentOrchestrator) {
          return { ok: false, error: 'SubagentOrchestrator unavailable' };
        }
        const action = String(rawArgs?.action || 'list');
        if (action === 'list') {
          return {
            ok: true,
            definitions: globalSubagentOrchestrator.listDefinitions().map((d) => ({
              name: d.name,
              description: d.description,
              source: d.source,
            })),
            activeSubagents: globalSubagentOrchestrator.listSubagents(sessionId),
          };
        }
        const ids = Array.isArray(rawArgs?.conversationIds)
          ? rawArgs.conversationIds.map((x) => String(x))
          : [];
        const res = await globalSubagentOrchestrator.killSubagents({
          parentSessionId: sessionId,
          conversationIds: ids,
          killAll: action === 'kill_all',
        });
        return { ok: true, ...res };
      },
    }),
    createTool({
      name: 'send_message',
      description:
        'Send a follow-up instruction or message to another subagent by its conversationId.',
      inputSchema: {
        type: 'object',
        properties: {
          recipient: {
            type: 'string',
            description: 'Target subagent conversationId returned by invoke_subagent',
          },
          message: {
            type: 'string',
            description: 'Message content to deliver',
          },
        },
        required: ['recipient', 'message'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!globalSubagentOrchestrator) {
          return { ok: false, error: 'SubagentOrchestrator unavailable' };
        }
        return globalSubagentOrchestrator.sendMessage({
          fromSessionId: sessionId,
          recipient: String(rawArgs?.recipient || ''),
          message: String(rawArgs?.message || ''),
        });
      },
    }),
    createTool({
      name: 'schedule',
      description:
        'Schedule a one-shot timer (durationSeconds) or a recurring 5-field cron job (cronExpression) that notifies the session via <SYSTEM_MESSAGE>.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'High-priority notification prompt delivered when the timer or cron fires',
          },
          durationSeconds: {
            type: 'number',
            description: 'Seconds to wait for a one-shot timer (mutually exclusive with cronExpression)',
          },
          cronExpression: {
            type: 'string',
            description: 'Standard 5-field cron expression (e.g. "*/5 * * * *")',
          },
          timerCondition: {
            type: 'string',
            description: 'Early cancellation condition for timer: "never" (default), "any", or a sender ID',
          },
          isDaemon: {
            type: 'boolean',
            description: 'Set true for standing cron jobs that keep firing across turns',
          },
          exactTiming: {
            type: 'boolean',
            description: 'Disable cron jitter when exact wall-clock timing is required',
          },
          maxIterations: {
            type: 'number',
            description: 'Maximum cron triggers before stopping',
          },
        },
        required: ['prompt'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!globalScheduleManager) {
          return { ok: false, error: 'ScheduleManager unavailable' };
        }
        const snap = globalScheduleManager.schedule({
          sessionId,
          prompt: String(rawArgs?.prompt || ''),
          durationSeconds:
            typeof rawArgs?.durationSeconds === 'number'
              ? Number(rawArgs.durationSeconds)
              : undefined,
          cronExpression: rawArgs?.cronExpression ? String(rawArgs.cronExpression) : undefined,
          timerCondition: rawArgs?.timerCondition ? String(rawArgs.timerCondition) : undefined,
          isDaemon: Boolean(rawArgs?.isDaemon),
          exactTiming: Boolean(rawArgs?.exactTiming),
          maxIterations:
            typeof rawArgs?.maxIterations === 'number'
              ? Number(rawArgs.maxIterations)
              : undefined,
        });
        return { ok: true, schedule: snap };
      },
    }),
    createTool({
      name: 'read_transcript',
      description:
        'Read the session conversation transcript (compact transcript.jsonl or untruncated transcript_full.jsonl) by line range or keyword grep.',
      inputSchema: {
        type: 'object',
        properties: {
          full: {
            type: 'boolean',
            description: 'Set true to read transcript_full.jsonl when truncated_fields is present',
          },
          startLine: {
            type: 'number',
            description: '1-based start line',
          },
          endLine: {
            type: 'number',
            description: '1-based end line (inclusive)',
          },
          grep: {
            type: 'string',
            description: 'Optional substring filter (e.g. "invoke_subagent")',
          },
        },
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!globalTranscriptLogger) {
          return { ok: false, error: 'TranscriptLogger unavailable' };
        }
        return globalTranscriptLogger.readTranscript(runtimeCtx.getSessionDir(sessionId), {
          full: Boolean(rawArgs?.full),
          startLine: typeof rawArgs?.startLine === 'number' ? Number(rawArgs.startLine) : 1,
          endLine: typeof rawArgs?.endLine === 'number' ? Number(rawArgs.endLine) : 50,
          grep: rawArgs?.grep ? String(rawArgs.grep) : undefined,
        });
      },
    }),
    createTool({
      name: 'migrate_agent_settings',
      description:
        'Migrate rules, slash commands, and subagents from Claude Code (.claude/, CLAUDE.md), Cursor (.cursor/rules, .cursorrules), and Gemini CLI (GEMINI.md) into an Antigravity plugin under .agents/plugins/migrated-agent-setup/, and optionally migrate legacy .agents/workflows/*.md into modern skills.',
      inputSchema: {
        type: 'object',
        properties: {
          migrateWorkflows: {
            type: 'boolean',
            description:
              'When true, also migrate legacy .agents/workflows/*.md files into .agents/skills/<name>/SKILL.md and archive originals.',
          },
        },
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (typeof migrateExternalAgentSettings !== 'function') {
          return { ok: false, error: 'PluginManager unavailable' };
        }
        const extRes = await migrateExternalAgentSettings(manifest.workspaceRoot);
        if (rawArgs?.migrateWorkflows && typeof migrateLegacyWorkflowsToSkills === 'function') {
          const wfRes = await migrateLegacyWorkflowsToSkills(manifest.workspaceRoot);
          return { ...extRes, workflowMigration: wfRes };
        }
        return extRes;
      },
    }),
    createTool({
      name: 'search_marketplace',
      description:
        'Search the Agent Marketplace catalog for plugins and skills by keyword, returning matches in relevance order with their id, name, kind, description, and install status. Suggest uninstalled plugins using <plugin-card catalog-id="<id>"></plugin-card> on its own line.',
      inputSchema: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            description:
              'One to three short keyword variants (e.g. ["google docs", "gdocs", "docs"])',
          },
          kind: {
            type: 'string',
            enum: ['plugin', 'skill', 'all'],
            description: 'Which kind of entry to return (defaults to plugin)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (defaults to 5, at most 15)',
          },
          installCatalogId: {
            type: 'string',
            description: 'Optional catalogId to install directly into .agents/plugins/<slug>/',
          },
        },
        required: ['queries'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (rawArgs?.installCatalogId && typeof installCatalogPlugin === 'function') {
          return installCatalogPlugin(
            manifest.workspaceRoot,
            String(rawArgs.installCatalogId)
          );
        }
        if (typeof searchMarketplace !== 'function') {
          return { ok: false, error: 'searchMarketplace unavailable' };
        }
        const queries = Array.isArray(rawArgs?.queries)
          ? rawArgs.queries.map((q) => String(q))
          : [];
        return searchMarketplace({
          queries,
          kind: (rawArgs?.kind as 'plugin' | 'skill' | 'all') || 'plugin',
          limit: typeof rawArgs?.limit === 'number' ? Number(rawArgs.limit) : 5,
          workspaceRoot: manifest.workspaceRoot,
        });
      },
    }),
    createTool({
      name: 'list_plugin_accounts',
      description:
        'List connected accounts for installed plugins: each plugin auth provider, sign-in status, identity, and the CLIs they power (supports AGY_ACCOUNT=<account> prefixing).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      execute: async () => {
        if (typeof listPluginAccounts !== 'function') {
          return { ok: false, error: 'listPluginAccounts unavailable' };
        }
        return listPluginAccounts(manifest.workspaceRoot);
      },
    }),
    createTool({
      name: 'call_mcp_tool',
      description:
        'Call a Model Context Protocol (MCP) tool exposed by workspace .deepautocode/mcp.json servers. Prefer qualified names like mcp__serverId__toolName from the MCP tools list.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: 'Qualified MCP tool name (mcp__server__tool) or unique bare tool name',
          },
          arguments: {
            type: 'object',
            description: 'JSON arguments for the MCP tool',
          },
        },
        required: ['tool'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!mcpHost) {
          return { ok: false, error: 'MCP host unavailable in this runtime build.' };
        }
        const toolName = String(rawArgs?.tool || rawArgs?.name || '');
        const args =
          rawArgs?.arguments && typeof rawArgs.arguments === 'object'
            ? (rawArgs.arguments as Record<string, unknown>)
            : rawArgs?.args && typeof rawArgs.args === 'object'
              ? (rawArgs.args as Record<string, unknown>)
              : {};
        if (!toolName) return { ok: false, error: 'tool name is required' };
        if (
          typeof mcpHost.isToolDisabled === 'function' &&
          mcpHost.isToolDisabled(toolName, mcpConfigsCached)
        ) {
          return { ok: false, error: `MCP tool disabled in Settings: ${toolName}` };
        }
        const result = await mcpHost.call(toolName, args);
        return result;
      },
    }),
    createTool({
      name: 'list_mcp_resources',
      description:
        'List MCP resources discovered from connected servers (Stage W). Use read_mcp_resource to fetch content.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        if (!mcpHost) return { resources: [], error: 'MCP host unavailable' };
        return { resources: mcpHost.listResources() };
      },
    }),
    createTool({
      name: 'read_mcp_resource',
      description: 'Read an MCP resource by URI (from list_mcp_resources).',
      inputSchema: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'Resource URI' },
        },
        required: ['uri'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!mcpHost) return { ok: false, error: 'MCP host unavailable' };
        return mcpHost.readResource(String(rawArgs?.uri || ''));
      },
    }),
    createTool({
      name: 'list_mcp_prompts',
      description: 'List MCP prompt templates from connected servers.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        if (!mcpHost) return { prompts: [], error: 'MCP host unavailable' };
        return { prompts: mcpHost.listPrompts() };
      },
    }),
    createTool({
      name: 'get_mcp_prompt',
      description: 'Fetch an MCP prompt template by name (optional serverId + arguments).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          serverId: { type: 'string' },
          arguments: { type: 'object' },
        },
        required: ['name'],
      },
      execute: async (rawArgs: Record<string, unknown>) => {
        if (!mcpHost) return { ok: false, error: 'MCP host unavailable' };
        const args =
          rawArgs?.arguments && typeof rawArgs.arguments === 'object'
            ? (rawArgs.arguments as Record<string, string>)
            : undefined;
        return mcpHost.getPrompt(
          String(rawArgs?.name || ''),
          args,
          rawArgs?.serverId ? String(rawArgs.serverId) : undefined
        );
      },
    }),
    ...(mcpHost
      ? mcpHost.listTools().slice(0, 32).map((td: any) =>
        createTool({
          name: td.qualifiedName,
          description:
            `[MCP:${td.serverName}] ${td.description || td.name}. Equivalent to call_mcp_tool({ tool: "${td.qualifiedName}", arguments })`,
          inputSchema: td.inputSchema || { type: 'object', properties: {} },
          execute: async (rawArgs: Record<string, unknown>) => {
            if (
              typeof mcpHost.isToolDisabled === 'function' &&
              mcpHost.isToolDisabled(td.qualifiedName, mcpConfigsCached)
            ) {
              return { ok: false, error: `MCP tool disabled in Settings: ${td.qualifiedName}` };
            }
            return mcpHost.call(td.qualifiedName, rawArgs || {});
          },
        })
      )
      : []),
  ];

  // Convert prior session history into AgentMessage format, ensuring no assistant/user message ever has empty content
  const history: any[] = await runtimeCtx.readMessages(sessionId);
  const priorToolAuditLines: string[] = [];
  const initialMessages = history
    .slice(-5, -1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m, idx) => {
      let text = typeof m.content === 'string' ? m.content.trim() : '';
      if (m.role === 'assistant') {
        if (text.includes('PATH_BOUNDARY_VIOLATION')) {
          text = text.replace(/##\s*关于["“]?直接在文件中改好["”]?[\s\S]*$/m, '').trim();
        }
        text = text
          .replace(/\[系统审计记录[\s\S]*$/m, '')
          .replace(/#{2,4}\s*[一二三四五六七八九十\d、.]*(?:我的错误与承诺|需要你确认的点|需要您确认的点|待确认事项|验证步骤（请在远程服务器执行）)[\s\S]*$/m, '')
          .replace(/\*\*请确认(?:是否|上述)[\s\S]*$/m, '')
          .trim();
      }
      if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        const uniqueSummaries = Array.from(
          new Set(
            m.toolCalls.map((tc: any) => {
              const argHint =
                tc.args?.filePath || tc.args?.path || tc.args?.command || JSON.stringify(tc.args ?? {}).slice(0, 80);
              return `${tc.toolName}(${argHint}) [${tc.status}]`;
            })
          )
        ).slice(0, 12);
        priorToolAuditLines.push(`Turn #${m.sequence}: ${uniqueSummaries.join(', ')}`);
        if (!text || text.length > 900) {
          text = `已完成上一轮工作区操作：${uniqueSummaries.slice(0, 6).join(', ')}。请以当前工作区最新源码（git status / git diff / read_file）为准继续处理。`;
        }
      }
      return {
        id: m.id || `hist_${idx}`,
        role: m.role as 'user' | 'assistant',
        content: [{ type: 'text' as const, text }],
        createdAt: Date.parse(m.timestamp) || Date.now(),
      };
    })
    .filter((m) => m.content[0].text.length > 0);

  // Prefix-Cache Boundary Optimization (ported from Claude Code src/context.ts):
  // Keep systemPrompt 100% static across session turns and place dynamic prior-turn audit context in the user turn tail.
  if (priorToolAuditLines.length > 0) {
    effectivePrompt = `${effectivePrompt}\n\n[Prior Session Executed Tools Audit (do NOT repeat this tag in output): ${priorToolAuditLines.join(' | ')}]`;
  }
  if (isReadOnlyTurn) {
    effectivePrompt = `${effectivePrompt.replace(/^\[(?:READ_ONLY_ANALYSIS|FORCE_AUTO_ACTION)\]\s*/i, '')}\n\n[Smart Intent Router: READ-ONLY QUERY & ANALYSIS MODE — Use read_file / outline_file / search_codebase / explore_codebase, and investigation shells (ls/cat/git status/npm test). Mutating shells (rm/mv/git commit/npm install/redirects) are blocked by CommandGuard. Do NOT edit files in this turn.]`;
  } else {
    effectivePrompt = effectivePrompt.replace(/^\[(?:READ_ONLY_ANALYSIS|FORCE_AUTO_ACTION)\]\s*/i, '');
  }

  // 3. Convert AgentModelRequest into OpenAI-Compatible / DeepSeek HTTP stream
  let modelTurnIndex = 0;
  const maxToolCallingTurns = 90;
  let lastOpenAiMessages: Array<Record<string, any>> = [];
  let llmTurnStartedAt = Date.now();
  let sessionCostCny = 0;
  const emitRuntimeEvent = (event: ClineRuntimeEvent) => runtimeCtx.emit(event);

  const clineModelAdapter = {
    stream: async function* (request: any) {
      if (signal.aborted || request.signal?.aborted) {
        yield { type: 'finish' as const, reason: 'aborted' as const };
        return;
      }

      modelTurnIndex += 1;
      llmTurnStartedAt = Date.now();
      const allowToolsThisTurn = modelTurnIndex <= maxToolCallingTurns;

      const configuredModelId = manifest.modelId || provider.defaultModelId;
      const routingMode = /force-reasoner|deepseek-reasoner|deepseek-v4-pro/i.test(
        configuredModelId
      )
        ? ('force-reasoner' as const)
        : /force-fast|^deepseek-chat$|^deepseek-flash$/i.test(configuredModelId)
          ? ('force-fast' as const)
          : ('auto' as const);
      const uniqueEdited = new Set(sessionWrittenFiles);
      const tierDecision = resolveTieredModelForTurn({
        configuredModelId,
        providerId: manifest.providerId,
        userPrompt: prompt,
        turnIndex: modelTurnIndex,
        selfHealCount,
        hasReadFiles: fileStateCache.size > 0,
        hasEditedFiles: sessionWrittenFiles.length > 0,
        hasBuildOrTestFailure: lastBuildOrTestFailed,
        hasSemanticFailure: lastSemanticFailed,
        editMismatchCount,
        multiFilePending: uniqueEdited.size >= 2,
        routingMode: configuredModelId === 'deepseek-auto' ? 'auto' : routingMode,
      });
      const activeModelId =
        request.phase === 'plan' && isDeepSeekModelId(tierDecision.effectiveModelId)
          ? DEEPSEEK_FLASH
          : tierDecision.effectiveModelId;
      const thinkingEnabled = Boolean(
        (tierDecision as { thinkingEnabled?: boolean }).thinkingEnabled ??
        /reasoner|r1|pro/i.test(activeModelId)
      );
      const reasoningEffort =
        request.reasoningEffort ??
        (tierDecision as { reasoningEffort?: 'low' | 'high' | 'max' | null })
          .reasoningEffort ??
        (thinkingEnabled ? 'high' : null);
      const dsControls = isDeepSeekModelId(activeModelId)
        ? buildDeepSeekRequestControls({
          apiModelId: activeModelId,
          thinkingEnabled,
          reasoningEffort,
        })
        : null;
      const isReasonerModel = Boolean(dsControls?.isThinking);
      const peakHour = isDeepSeekPeakHour();
      emitRuntimeEvent({
        type: 'model_tier',
        sessionId,
        payload: {
          configuredModelId,
          effectiveModelId: activeModelId,
          thinkingEnabled,
          reasoningEffort,
          peakHour,
          tokensUsed: activeGoal.tokensUsed,
          tokenBudget: Number(activeGoal.tokenBudget ?? 180000),
          tier: tierDecision.tier,
          reason: tierDecision.reason,
          turnIndex: modelTurnIndex,
        },
      });
      activeGoal.turnsExecuted = modelTurnIndex;

      const openAiMessages: Array<Record<string, any>> = [];
      if (request.systemPrompt) {
        openAiMessages.push({
          role: 'system',
          content: request.systemPrompt,
        });
      }

      const emittedToolCallIds = new Set<string>();

      const reqMessages = request.messages ?? [];
      for (let msgIdx = 0; msgIdx < reqMessages.length; msgIdx += 1) {
        const msg = reqMessages[msgIdx];
        if (msg.role === 'user') {
          const textContent = (msg.content ?? [])
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text)
            .join('\n')
            .trim();
          const isLastUserMsg =
            msgIdx === reqMessages.length - 1 ||
            !reqMessages.slice(msgIdx + 1).some((m: any) => m.role === 'user');
          if (
            isLastUserMsg &&
            Array.isArray(images) &&
            images.length > 0 &&
            /gpt-4o|claude|gemini|vl|vision|qwen.*vl/i.test(activeModelId)
          ) {
            openAiMessages.push({
              role: 'user',
              content: [
                { type: 'text', text: textContent || 'Continue.' },
                ...images.map((img) => ({
                  type: 'image_url',
                  image_url: { url: img.dataUrl },
                })),
              ],
            });
          } else {
            openAiMessages.push({
              role: 'user',
              content: textContent || 'Continue.',
            });
          }
        } else if (msg.role === 'assistant') {
          const textParts = (msg.content ?? [])
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text)
            .join('')
            .trim();
          const toolCallParts = (msg.content ?? []).filter(
            (p: any) =>
              p.type === 'tool-call' &&
              typeof p.toolName === 'string' &&
              p.toolName.trim().length > 0 &&
              typeof p.toolCallId === 'string' &&
              p.toolCallId.trim().length > 0
          );
          if (toolCallParts.length > 0) {
            const assistantObj: Record<string, any> = {
              role: 'assistant',
              content: textParts || '',
              // DeepSeek tool-calling requires prior reasoning_content to be echoed back.
              ...(typeof (msg as any).reasoningContent === 'string' || isReasonerModel
                ? { reasoning_content: (msg as any).reasoningContent ?? '' }
                : {}),
              tool_calls: toolCallParts.map((tc: any) => {
                emittedToolCallIds.add(tc.toolCallId);
                return {
                  id: tc.toolCallId,
                  type: 'function',
                  function: {
                    name: tc.toolName,
                    arguments:
                      typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
                  },
                };
              }),
            };
            openAiMessages.push(assistantObj);
          } else {
            // DeepSeek / OpenAI invariant: assistant message without tool_calls MUST have non-empty content
            openAiMessages.push({
              role: 'assistant',
              content: textParts || '已完成上一步工作区操作，继续执行。',
            });
          }
        } else if (msg.role === 'tool') {
          for (const part of msg.content ?? []) {
            if (part.type === 'tool-result') {
              const outputText =
                typeof part.output === 'string'
                  ? part.output
                  : JSON.stringify(part.output ?? {});
              if (part.toolCallId && emittedToolCallIds.has(part.toolCallId)) {
                openAiMessages.push({
                  role: 'tool',
                  tool_call_id: part.toolCallId,
                  content: outputText || '{}',
                });
              } else {
                openAiMessages.push({
                  role: 'user',
                  content: `[Tool Result]: ${outputText || '{}'}`,
                });
              }
            }
          }
        }
      }

      const isFinishingStage =
        manifest.executionMode === 'auto' &&
        modelTurnIndex > maxToolCallingTurns - 8 &&
        modelTurnIndex <= maxToolCallingTurns;

      if (isFinishingStage) {
        openAiMessages.push({
          role: 'system',
          content:
            'You have completed sufficient workspace exploration. Do NOT ask the user for confirmation. In your remaining turns, immediately call edit_file / write_file to apply your code fixes and call run_command to compile and run verification tests!',
        });
      } else if (!allowToolsThisTurn) {
        openAiMessages.push({
          role: 'system',
          content:
            'You have completed enough workspace file/tool inspections. Do NOT call any more tools. Immediately synthesize all information gathered above into a comprehensive, well-structured Markdown response in Chinese.',
        });
      }

      lastOpenAiMessages = openAiMessages;

      const filteredTools = isFinishingStage
        ? (request.tools ?? []).filter((t: any) =>
          ['edit_file', 'write_file', 'apply_patch', 'editor', 'run_command', 'run_commands', 'read_file'].includes(
            t.name
          )
        )
        : (request.tools ?? []);

      const openAiTools = allowToolsThisTurn
        ? filteredTools.map((t: any) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema ?? { type: 'object', properties: {} },
          },
        }))
        : [];

      const isGlmModel =
        provider.providerId === 'glm' || /^glm/i.test(activeModelId);
      const isLocalInference = isLocalOrPrivateEndpoint(provider.apiEndpoint);
      const glmEnableThinking =
        isGlmModel && (request.phase === 'plan' || reasoningEffort === 'max');

      const response = await postJsonResilient({
        url: endpoint,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: activeModelId,
          messages: openAiMessages,
          tools: openAiTools.length > 0 ? openAiTools : undefined,
          tool_choice: openAiTools.length > 0 ? 'auto' : undefined,
          max_tokens: 8192,
          ...(isReasonerModel ? {} : { temperature: 0.2 }),
          ...(dsControls ? deepSeekChatBodyExtras(dsControls) : {}),
          ...(isGlmModel
            ? { chat_template_kwargs: { enable_thinking: glmEnableThinking } }
            : {}),
        },
        signal: request.signal ?? signal,
        timeoutMs: isReasonerModel || isGlmModel || isLocalInference ? 180000 : 90000,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 240)}`);
      }

      const data = JSON.parse(response.text || '{}') as any;
      const choice = data?.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        throw new Error('Empty response from LLM provider');
      }
      const reasoningContent =
        typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0
          ? msg.reasoning_content
          : typeof msg.reasoning === 'string' && msg.reasoning.length > 0
            ? msg.reasoning
            : undefined;

      const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const validToolCalls: Array<{
        id: string;
        fnName: string;
        inputText: string;
        parsedArgs: Record<string, unknown>;
      }> = [];

      for (let i = 0; i < rawToolCalls.length; i++) {
        const tc = rawToolCalls[i];
        const fnName = typeof tc?.function?.name === 'string' ? tc.function.name.trim() : '';
        if (!fnName) {
          continue;
        }
        const rawArgs = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '{}';
        let parsedArgs: Record<string, unknown> = {};
        let inputText = rawArgs;
        try {
          parsedArgs = JSON.parse(rawArgs);
          if (fnName === 'write_file' && parsedArgs?.filePath) {
            sessionWrittenFiles.push(String(parsedArgs.filePath));
          }
        } catch {
          // Tool call JSON arguments were truncated at max_tokens
          if (validToolCalls.length > 0) {
            // Execute the already-complete tool calls in this turn; the model will do the truncated one next turn
            continue;
          }
          const partialPathMatch = rawArgs.match(/"(?:filePath|path|file_path)"\s*:\s*"([^"]+)"/);
          parsedArgs = {
            __truncated: true,
            filePath: partialPathMatch?.[1] || '',
          };
          inputText = JSON.stringify(parsedArgs);
        }
        validToolCalls.push({
          id: tc.id || `call_${Date.now()}_${i}`,
          fnName,
          inputText,
          parsedArgs,
        });
      }

      // Only stream final assistant answer text; suppress intermediate file-reading/tool chatter
      if (validToolCalls.length === 0) {
        const rawTextContent =
          typeof msg.content === 'string' && msg.content.trim().length > 0
            ? msg.content
            : typeof msg.reasoning === 'string' && msg.reasoning.trim().length > 0
              ? msg.reasoning
              : '';
        const cleanedMsgContent = rawTextContent
          .replace(/\[系统审计记录[\s\S]*$/m, '')
          .replace(/^[A-Za-z0-9\s.,:\\/()'"_-]{10,400}?(?=(?:✅|#{1,3}\s+[^\n]*[\u4e00-\u9fa5]))/, '')
          .trim();
        const finalContent =
          cleanedMsgContent.length > 0
            ? cleanedMsgContent
            : sessionWrittenFiles.length > 0
              ? `## 项目构建与文件生成完成\n- **已生成/更新文件 (${sessionWrittenFiles.length})**: ${Array.from(new Set(sessionWrittenFiles)).map((f) => `\`${f}\``).join('、')}\n- **状态**: 所有文件已写入工作区并生成 Diff 预览。`
              : '已完成当前请求分析与处理。';
        yield {
          type: 'text-delta' as const,
          text: finalContent,
        };
      }

      for (let i = 0; i < validToolCalls.length; i++) {
        const vtc = validToolCalls[i];
        yield {
          type: 'tool-call-delta' as const,
          index: i,
          toolCallId: vtc.id,
          toolName: vtc.fnName,
          inputText: vtc.inputText,
          input: vtc.parsedArgs,
        };
      }

      if (data?.usage) {
        const normalizedUsage = extractDeepSeekCacheUsage(data.usage);
        const inTok = normalizedUsage.inputTokens;
        const outTok = normalizedUsage.outputTokens;
        const cacheHitTok = normalizedUsage.promptCacheHitTokens;
        const cacheMissTok = normalizedUsage.promptCacheMissTokens;
        activeGoal.tokensUsed += inTok + outTok;
        const budget = Number(activeGoal.tokenBudget ?? 180000);
        const latencyMs = Date.now() - llmTurnStartedAt;
        const llmEvt = globalTaskTraceStore.recordLlmTurn({
          workspaceRoot: manifest.workspaceRoot,
          sessionId,
          taskId,
          turnIndex: modelTurnIndex,
          modelId: activeModelId,
          latencyMs,
          inputTokens: inTok,
          outputTokens: outTok,
          cacheReadTokens: cacheHitTok,
          cacheWriteTokens: cacheMissTok,
          tokensUsed: activeGoal.tokensUsed,
          tokenBudget: budget,
        });
        const snap = taskId
          ? globalTaskTraceStore.get(taskId)
          : globalTaskTraceStore.getBySession(sessionId);
        const turnCost = isDeepSeekModelId(activeModelId)
          ? estimateDeepSeekTurnCostCny({
            apiModelId: activeModelId,
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadTokens: cacheHitTok,
            peak: isDeepSeekPeakHour(),
          })
          : 0;
        sessionCostCny += turnCost;
        emitRuntimeEvent({
          type: 'goal_usage',
          sessionId,
          payload: {
            tokensUsed: activeGoal.tokensUsed,
            tokenBudget: budget,
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadTokens: cacheHitTok,
            cacheWriteTokens: cacheMissTok,
            cacheReadTokensTotal: snap?.cacheReadTokens ?? cacheHitTok,
            cacheWriteTokensTotal: snap?.cacheWriteTokens ?? cacheMissTok,
            estimatedCostCny: turnCost,
            estimatedCostCnyTotal: sessionCostCny,
            peakHour: isDeepSeekPeakHour(),
            modelId: activeModelId,
            thinkingEnabled,
            turnIndex: modelTurnIndex,
            remaining: Math.max(0, budget - activeGoal.tokensUsed),
            latencyMs,
            taskId,
          },
        });
        if (llmEvt) emitTraceUpdated?.(llmEvt);
        yield {
          type: 'usage' as const,
          usage: {
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadTokens: cacheHitTok,
            cacheWriteTokens: cacheMissTok,
          },
        };
      }

      yield {
        type: 'finish' as const,
        reason: validToolCalls.length > 0 ? ('tool-calls' as const) : ('stop' as const),
        ...(reasoningContent ? { reasoningContent } : {}),
      };
    },
  };

  // 4. Build in-tree system prompt + tool policies and instantiate in-tree AgentLoop
  let memorySection = '';
  if (typeof loadAgentMemory === 'function' && typeof formatAgentMemoryForPrompt === 'function') {
    try {
      const mem = await loadAgentMemory(manifest.workspaceRoot);
      memorySection = formatAgentMemoryForPrompt(mem, 5);
    } catch {
      memorySection = '';
    }
  }

  const officialClinePrompt =
    typeof getClineDefaultSystemPrompt === 'function'
      ? getClineDefaultSystemPrompt(
        {
          ...workspaceInfo,
          workspaceRoot: manifest.workspaceRoot,
          planModeSwitchTool: false,
        },
        {
          // Path-conditional .cursor/rules globs — prefer recently touched + open files
          activePaths: Array.from(
            new Set([
              ...sessionWrittenFiles.slice(-12),
              ...(Array.isArray((manifest as any).openFiles)
                ? ((manifest as any).openFiles as string[])
                : []),
            ])
          ),
          prompt: basePromptForTurn,
        }
      )
      : '';
  const officialClinePromptWithMemory = memorySection
    ? `${officialClinePrompt}\n\n${memorySection}`
    : officialClinePrompt;

  const baseToolPolicies =
    typeof createToolPoliciesWithPreset === 'function'
      ? createToolPoliciesWithPreset(
        isReadOnlyTurn ? 'plan' : manifest.executionMode === 'auto' ? 'yolo' : 'default'
      )
      : undefined;
  const toolPolicies =
    baseToolPolicies &&
      typeof overlayToolPoliciesWithHardRules === 'function' &&
      policyGate?.permissionRuleset?.length
      ? overlayToolPoliciesWithHardRules(baseToolPolicies, policyGate.permissionRuleset)
      : baseToolPolicies;

  const mergedTools =
    typeof applyStandardToolAliases === 'function'
      ? applyStandardToolAliases([...deepAutoCodeTools, ...builtinTools])
      : [...deepAutoCodeTools, ...builtinTools];
  // Plan/read-only: keep investigation shells (CommandGuard blocks mutators); drop editors.
  const activeTurnTools = mergedTools.filter((t) =>
    isReadOnlyTurn || manifest.executionMode === 'plan'
      ? ![
        'edit_file',
        'str_replace',
        'write_file',
        'apply_patch',
        'editor',
        'auto_build_and_test',
        'connect_remote_ssh',
      ].includes(t.name)
      : true
  );

  const asksUserOrDefersExecutionPattern =
    /(?:请确认|需要你确认|需要您确认|需确认|我未读到|需要我直接|要我直接|是否现在执行|确认后我会|请问是否|直接授权我|我会立即修改|是否继续执行|请告诉我是否|需要我现在执行吗|请执行[:：]?|请先执行|请在远程服务器执行)/;
  const proposesCodeChangesInTextPattern =
    /(?:###?\s*(?:改动|修改|步骤)\s*\d|####\s*(?:改动|修改|步骤)\s*\d|##\s*✅?\s*Kernel\s*侧修复方案|##\s*修复方案)/;

  let sharedReadCache = sessionReadCaches.get(sessionId);
  if (!sharedReadCache) {
    sharedReadCache = new SessionReadCache(manifest.workspaceRoot);
    sessionReadCaches.set(sessionId, sharedReadCache);
  }

  const clineAgent = new Agent({
    sessionId,
    conversationId: sessionId,
    clientName: 'deepautocode-desktop-ide',
    clientVersion: '1.1.0',
    workspaceRoot: manifest.workspaceRoot,
    sessionReadCache: sharedReadCache,
    model: clineModelAdapter,
    toolPolicies,
    mistakeTracker: mistakeTracker ?? undefined,
    loopDetection: loopDetection ?? undefined,
    getContextBudget: () => ({
      tokensUsed: activeGoal.tokensUsed,
      tokenBudget: activeGoal.tokenBudget,
    }),
    requestToolApproval: async ({ toolName, args, summary }) => {
      const filePath =
        typeof args.filePath === 'string'
          ? args.filePath
          : typeof args.path === 'string'
            ? args.path
            : undefined;
      const command = typeof args.command === 'string' ? args.command : undefined;
      const decision = await runtimeCtx.capabilityRegistry.requestUserApproval({
        sessionId,
        toolName,
        summary: summary || `Approve tool '${toolName}'`,
        risk: 'high',
        targetPath: filePath,
        command,
        arguments: args,
      });
      return { approved: decision.approved, reason: decision.reason };
    },
    systemPrompt:
      `${officialClinePromptWithMemory}\n\n` +
      `# DeepAutoCode Desktop IDE Environment & Guidelines\n` +
      `- Current Workspace Root: ${manifest.workspaceRoot}\n` +
      `- Top-level Workspace Entries: ${workspaceFilesHint || '(empty or unknown)'}\n` +
      `- Execution Mode: ${manifest.executionMode}\n` +
      `- Workspace Verification Gate (source=${verifyConfig.source}):\n${verifyPromptBlock.split('\n').map((l) => `  ${l}`).join('\n')}\n` +
      (mcpBootstrapNote
        ? `- MCP: ${mcpBootstrapNote}\n  Use call_mcp_tool({ tool: "mcp__server__tool", arguments }) or the injected mcp__* tools when external systems are needed.\n`
        : `- MCP: configure servers in Settings or workspace .deepautocode/mcp.json (stdio). Built-in placeholders are ignored.\n`) +
      (isSshMirrorWorkspace
        ? `- REMOTE SSH LINUX WORKSPACE: This workspace is connected to a Remote Linux SSH server with bidirectional file sync. All shell commands in 'run_command' and 'run_commands' execute directly on the Remote Linux server via /bin/bash (NEVER use Windows PowerShell cmdlets like Get-ChildItem or Select-Object). All file tools ('read_file', 'edit_file', 'editor', 'write_file') automatically pull and push files between the IDE and the Remote SSH server.\n`
        : `- Prefer 'run_command' (PowerShell) over 'run_commands' when running shell commands on Windows.\n`) +
      `- AUTONOMOUS END-TO-END PROBLEM RESOLUTION (自动处理所有问题 — 最高优先级准则):\n` +
      `  1. In 'auto' mode, you are an autonomous problem-solving engineer, NOT a passive report generator.\n` +
      `  2. Whenever you analyze a project, diagnose a bug/error log, or are asked to fix issues, once you discover concrete code bugs:\n` +
      `     - DO NOT stop after merely listing problems or writing a Markdown modification plan!\n` +
      `     - NEVER ask the user to run build/test commands manually — execute them yourself via tools!\n` +
      `     - IMMEDIATELY call 'edit_file' or 'write_file' to fix bugs, then run_command with the workspace verify gate: \`${preferredVerifyCommand}\`\n` +
      `     - NEVER fabricate command outputs or test results.\n` +
      `- ULTRA-CONCISE RESPONSE FORMAT:\n` +
      `  1. Keep final response short and scannable (about 8–20 lines).\n` +
      `  2. Use at most 3 blocks: root cause (file:line), changes (file:line), verification result from real commands.\n` +
      `- HIGH-SPEED PARALLEL EXECUTION RULES:\n` +
      `  1. BATCH MULTIPLE READS IN ONE TURN via parallel read_file / search_codebase calls.\n` +
      `  2. Prefer 'read_file' over remote sed/cat when possible.\n` +
      `  3. After edits, prefer ONE combined verify command: \`${preferredVerifyCommand}\`\n` +
      `- DIRECT FILE MODIFICATION RULES:\n` +
      `  1. Always pass workspace-relative paths (e.g. "src/enqueue.cc", "src/device/common_kernel.h", "nccl-test/src/sendrecv.cc") to 'read_file', 'edit_file', 'editor', and 'write_file'.\n` +
      `  2. For large files (>50KB, such as "src/enqueue.cc"), pass 'start_line' and 'end_line' to 'read_file' (e.g. { "filePath": "src/enqueue.cc", "start_line": 740, "end_line": 830 }) instead of running repeated grep/sed shell commands.\n` +
      `  3. When modifying an existing source file (especially large C/C++/Python/TS files), prefer 'edit_file' ({ filePath, oldText, newText }) or multi-hunk 'edit_file.hunks' / 'apply_patch' (unified diff) for multi-site edits; use 'write_file' only for new files or full rewrites.\n` +
      `  3b. search_codebase supports regex=true, glob="*.ts", mode="symbol"|"content"|"auto".\n` +
      `  4. NEVER claim you cannot modify files, NEVER blame PATH_BOUNDARY_VIOLATION (all deep subdirectory files are 100% accessible), and NEVER ask the user to run manual python/sed scripts instead of modifying the files yourself.\n` +
      `- When writing large new files (> 250 lines), write 1 file per tool-calling turn so your JSON output never hits the 8192 max_tokens limit.\n` +
      `- CRITICAL SAFETY RULE: NEVER run 'taskkill /F /IM node.exe', 'Stop-Process -Name node', or kill all node/electron processes globally, because the DeepAutoCode IDE backend itself runs on Node.js (port 3840). When asked to compile & run ("编译运行" / "启动服务"), run syntax checks (e.g. 'node --check server/server.js') and start the server via 'run_command' (e.g. 'node server/server.js'). If the target port is already in use, the server is already running in the background — simply verify it with 'curl.exe -s -I http://localhost:3000'.\n` +
      `- Do NOT output raw file contents or narrate your file-reading process in text; the IDE automatically displays a real-time progress indicator for all file/tool operations.\n` +
      `- In 'plan' mode, only use read-only tools.\n` +
      `- Respond clearly and concisely in the user's language (Chinese by default).`,
    tools: activeTurnTools,
    initialMessages,
    maxIterations: 105,
    hooks: {
      onEvent: async (event: any) => {
        if (event.type === 'assistant-text-delta' && event.text) {
          await streamText(event.text);
        }
        if (event.type === 'context.pressure') {
          emitRuntimeEvent({
            type: 'goal_usage',
            sessionId,
            payload: {
              tokensUsed: activeGoal.tokensUsed,
              tokenBudget: Number(activeGoal.tokenBudget ?? 180000),
              remaining: Math.max(
                0,
                Number(activeGoal.tokenBudget ?? 180000) - activeGoal.tokensUsed
              ),
              contextPressure: true,
              fillRatio: event.fillRatio,
              compactionStage: event.stage,
              compactionTrigger: event.trigger,
              warnBudget: Boolean(event.warnBudget),
            },
          });
          const compactEvt = globalTaskTraceStore.recordSignal?.({
            workspaceRoot: manifest.workspaceRoot,
            sessionId,
            taskId,
            signal: 'compaction',
            summary: `${event.stage || 'pressure'} · ${event.reason || ''} · trigger=${event.trigger || 'n/a'}`,
            detail: {
              fillRatio: event.fillRatio,
              stage: event.stage,
              trigger: event.trigger,
              warnBudget: event.warnBudget,
            },
          });
          if (compactEvt) emitTraceUpdated?.(compactEvt);
        }
        if (event.type === 'agent.mistake' || event.type === 'agent.loop') {
          const signalEvt = globalTaskTraceStore.recordSignal?.({
            workspaceRoot: manifest.workspaceRoot,
            sessionId,
            taskId,
            signal: event.type === 'agent.loop' ? 'loop' : 'mistake',
            summary:
              event.reason ||
              `${event.kind || event.type} · consecutive=${event.consecutiveMistakes ?? '?'}`,
            detail: {
              kind: event.kind,
              toolName: event.toolName,
              count: event.count,
              consecutiveMistakes: event.consecutiveMistakes,
            },
          });
          if (signalEvt) emitTraceUpdated?.(signalEvt);
        }
      },
      onBeforeFinish: async ({ assistantText, iterations, consecutiveMistakes }) => {
        if (isReadOnlyTurn || manifest.executionMode !== 'auto' || iterations >= maxToolCallingTurns - 2) {
          return { shouldContinue: false };
        }

        // MistakeTracker / LoopDetection: treat high consecutive mistakes like verify fail
        if (
          typeof consecutiveMistakes === 'number' &&
          consecutiveMistakes >= 4 &&
          selfHealCount < selfHealBudget
        ) {
          selfHealCount += 1;
          autoContinuationCount += 1;
          mistakeTracker?.recordSuccess();
          return {
            shouldContinue: true,
            prompt: buildGoalContinuationPrompt(
              activeGoal,
              `检测到连续失误/循环（MistakeTracker consecutive=${consecutiveMistakes}）。请停止重复同一工具调用：换参数、换工具，或先 summarize 失败原因再 edit_file。自愈进度 ${selfHealCount}/${selfHealBudget}。`
            ),
          };
        }

        // Token budget exceeded → ask model to summarize and stop expanding exploration
        if (
          typeof isGoalTokenBudgetExceeded === 'function' &&
          isGoalTokenBudgetExceeded(activeGoal) &&
          !budgetLimitNotified
        ) {
          budgetLimitNotified = true;
          autoContinuationCount += 1;
          return {
            shouldContinue: true,
            prompt:
              typeof buildGoalBudgetLimitPrompt === 'function'
                ? buildGoalBudgetLimitPrompt(activeGoal)
                : `Token budget reached (${activeGoal.tokensUsed}/${activeGoal.tokenBudget}). Summarize progress and stop new exploration.`,
          };
        }

        const needsHeal = lastBuildOrTestFailed || lastSemanticFailed;
        const todoBlock =
          sessionTodos && sessionTodos.hasIncomplete
            ? `\nSession todos (incomplete first):\n${sessionTodos.formatForPrompt()}\n`
            : '';

        // Case 0: Semantic diagnostics failed after edit — heal before claiming done
        // (shares self-heal budget; does not consume verify-nudge budget)
        if (lastSemanticFailed && !lastBuildOrTestFailed && selfHealCount < selfHealBudget) {
          selfHealCount += 1;
          autoContinuationCount += 1;
          const problemsExtra =
            typeof loadWorkspaceProblemsText === 'function'
              ? await loadWorkspaceProblemsText(manifest.workspaceRoot, 30)
              : '';
          lastSemanticFailed = false;
          return {
            shouldContinue: true,
            prompt: buildGoalContinuationPrompt(
              activeGoal,
              `编辑后语言服务诊断失败（无需用户 @problems）：\n\`\`\`\n${lastSemanticDiagSnippet || '(semantic diagnostics)'
              }\n\`\`\`\n${problemsExtra ? `Persisted Problems:\n${problemsExtra}\n` : ''
              }${todoBlock}请立即 edit_file/apply_patch 修复上述诊断，必要时再 run_command：\`${preferredVerifyCommand}\`。自愈进度 ${selfHealCount}/${selfHealBudget}。`
            ),
          };
        }

        // Case 1: Source was edited but build/verify not run yet (verify-nudge budget)
        if (hasUnverifiedCompiledEdit && verifyNudgeCount < verifyNudgeBudget) {
          verifyNudgeCount += 1;
          autoContinuationCount += 1;
          hasUnverifiedCompiledEdit = false;
          return {
            shouldContinue: true,
            prompt: buildGoalContinuationPrompt(
              activeGoal,
              `你刚刚修改了需要验证的源码，但尚未执行工作区验证门禁！请立即调用 run_command 执行：\n${verifyPromptBlock}\n推荐一条命令：\`${preferredVerifyCommand}\`\n确认构建与测试通过后再输出最终报告。`
            ),
          };
        }

        // Case 2: Build done-ish but dedicated test command still pending
        if (
          hasUnverifiedTestAfterEdit &&
          !lastBuildOrTestFailed &&
          verifyNudgeCount < verifyNudgeBudget
        ) {
          verifyNudgeCount += 1;
          autoContinuationCount += 1;
          hasUnverifiedTestAfterEdit = false;
          return {
            shouldContinue: true,
            prompt: buildGoalContinuationPrompt(
              activeGoal,
              `代码可能已构建，但仍需运行测试验证！请立即调用 run_command 执行：\`${verifyConfig.testCommand}\`（或组合命令 \`${preferredVerifyCommand}\`），确认测试真实通过后再总结。`
            ),
          };
        }

        // Case 2b: Verifier subagent reported FAIL
        if (lastVerifierPass === false && selfHealCount < selfHealBudget) {
          selfHealCount += 1;
          autoContinuationCount += 1;
          lastVerifierPass = null;
          return {
            shouldContinue: true,
            prompt: buildGoalContinuationPrompt(
              activeGoal,
              `invoke_subagent(verifier) 判定未通过。请根据其报告修复代码，再重新验证（可再次 invoke_subagent role=verifier 或 run_command \`${preferredVerifyCommand}\`）。自愈进度 ${selfHealCount}/${selfHealBudget}。`
            ),
          };
        }

        // Case 3: Build/test failed — independent self-heal budget
        if (needsHeal && selfHealCount < selfHealBudget) {
          selfHealCount += 1;
          autoContinuationCount += 1;
          const problemsExtra =
            typeof loadWorkspaceProblemsText === 'function'
              ? await loadWorkspaceProblemsText(manifest.workspaceRoot, 30)
              : '';
          const failedTests =
            lastFailedTestHints.length > 0
              ? `\n失败用例提示: ${lastFailedTestHints.join(' | ')}\n优先修复这些用例，然后优先重跑：\`${verifyConfig.testCommand}\`。`
              : '';
          lastBuildOrTestFailed = false;
          lastSemanticFailed = false;
          return {
            shouldContinue: true,
            prompt: buildGoalContinuationPrompt(
              activeGoal,
              `上一步编译/测试或语义检查未通过（自愈 ${selfHealCount}/${selfHealBudget}，与 verify 催促计数独立）：\n\`\`\`\n${lastFailureOutputSnippet ||
              lastSemanticDiagSnippet ||
              '命令返回非零退出码或测试输出包含 FAILED'
              }\n\`\`\`${failedTests}${problemsExtra ? `\nProblems:\n${problemsExtra}\n` : ''
              }\n${todoBlock}请立即 edit_file/apply_patch 修复，再 run_command 聚焦重测/验证直到通过。可用 manage_todo 更新任务状态。`
            ),
          };
        }

        // Case 3c: Incomplete session todos after verify passed — nudge to finish checklist
        if (
          !needsHeal &&
          !hasUnverifiedCompiledEdit &&
          !hasUnverifiedTestAfterEdit &&
          sessionTodos?.hasIncomplete &&
          verifyNudgeCount < verifyNudgeBudget &&
          activeGoal.verifiedByCommand
        ) {
          verifyNudgeCount += 1;
          autoContinuationCount += 1;
          return {
            shouldContinue: true,
            prompt: buildGoalContinuationPrompt(
              activeGoal,
              `验证已通过，但仍有未完成 session todos：\n${sessionTodos.formatForPrompt()}\n请继续完成剩余项，或用 manage_todo 将已完成的标记 complete 后再总结。`
            ),
          };
        }

        // Case 3b: Circuit breaker — self-heal budget exhausted → roll back
        if (needsHeal && selfHealCount >= selfHealBudget && !circuitBreakerNotified) {
          circuitBreakerNotified = true;
          circuitBroken = true;
          autoContinuationCount += 1;
          lastBuildOrTestFailed = false;
          lastSemanticFailed = false;
          let rollbackMsg = 'Circuit breaker engaged.';
          if (typeof rollbackSessionMutations === 'function') {
            const rb = await rollbackSessionMutations({
              workspaceRoot: manifest.workspaceRoot,
              originals: sessionOriginalContents,
              createdFiles: Array.from(sessionCreatedFiles),
            });
            rollbackMsg = `${rb.message} Restored: ${rb.rolledBackFiles.join(', ') || '(none)'}.`;
            sessionWrittenFiles.length = 0;
            hasUnverifiedCompiledEdit = false;
            hasUnverifiedTestAfterEdit = false;
            runtimeCtx.emit({
              type: 'circuit_breaker_triggered',
              sessionId,
              payload: {
                message: rollbackMsg,
                rolledBackFiles: rb.rolledBackFiles,
                failedFiles: rb.failedFiles,
                selfHealCount,
              },
            });
          }
          onCircuitTriggered?.();
          return {
            shouldContinue: true,
            prompt:
              `[CIRCUIT_BREAKER] ${rollbackMsg}\n` +
              `Do NOT call edit_file / write_file / editor again. Concise failure report only:\n` +
              `1) Root cause hypothesis\n2) Why verification still failed after ${selfHealCount} self-heal attempts\n` +
              `3) Suggested next manual step for the user\n` +
              `Last failure snippet:\n\`\`\`\n${lastFailureOutputSnippet || lastSemanticDiagSnippet || '(empty)'
              }\n\`\`\``,
          };
        }

        // Case 4: Plan/defer without edits — uses verify-nudge style single push
        if (
          sessionWrittenFiles.length === 0 &&
          !activeGoal.verifiedByCommand &&
          verifyNudgeCount === 0 &&
          (asksUserOrDefersExecutionPattern.test(assistantText) ||
            proposesCodeChangesInTextPattern.test(assistantText))
        ) {
          verifyNudgeCount += 1;
          autoContinuationCount += 1;
          return {
            shouldContinue: true,
            prompt: buildGoalContinuationPrompt(
              activeGoal,
              '已全部授权你直接落地执行！当前处于 auto 全自动执行模式：若目标文件尚未修改，请立即调用 edit_file / write_file 直接修改源码文件并调用 run_command 编译与测试验证；若通过检查发现目标文件在之前轮次已经修改到位，请直接调用 run_command 验证编译/测试并给出最终总结，切勿重复调用 read_file 读取同一文件！'
            ),
          };
        }

        return { shouldContinue: false };
      },
    },
  });

  const onAbort = () => {
    clineAgent.abort('Task cancelled by user');
  };
  signal.addEventListener('abort', onAbort, { once: true });

  let runResult: any;
  try {
    runResult = await clineAgent.run(effectivePrompt);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await mcpHost?.dispose?.().catch(() => undefined);
  }

  if (runResult.status === 'failed' && runResult.error) {
    const errMsg = runResult.error?.message || String(runResult.error);
    if (errMsg.includes('maxIterations') && lastOpenAiMessages.length > 0) {
      // Synthesize final answer directly from all collected tool results
      const synthResponse = await postJsonResilient({
        url: endpoint,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: manifest.modelId || provider.defaultModelId,
          messages: [
            ...lastOpenAiMessages,
            {
              role: 'user',
              content:
                '请基于以上已读取的工作区文件与目录信息，立即直接输出完整、结构化的 Markdown 总结分析回答（不要再调用任何工具）。',
            },
          ],
          temperature: 0.2,
        },
        signal,
        timeoutMs: 60000,
      });
      if (synthResponse.ok) {
        const synthData = JSON.parse(synthResponse.text || '{}') as any;
        const synthText = synthData?.choices?.[0]?.message?.content;
        if (typeof synthText === 'string' && synthText.trim().length > 0) {
          await streamText(synthText);
          return { content: chunks.join('') };
        }
      }
    }
    throw runResult.error;
  }

  if (chunks.length === 0 && runResult.outputText) {
    await streamText(runResult.outputText);
  }

  return { content: chunks.join('') };
}
