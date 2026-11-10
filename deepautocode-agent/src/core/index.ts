export {
  Agent,
  AgentRuntime,
  ClineCore,
  SessionReadCache,
  buildStablePrefix,
  computeDynamicMaxIterations,
  isPreflightableEditTool,
  type AgentMessage,
  type AgentMessagePart,
  type AgentModelAdapter,
  type AgentModelStreamChunk,
  type AgentModelStreamRequest,
  type AgentOptions,
  type AgentRunResult,
  type StablePrefixBundle,
  type SessionReadCacheEntry,
} from './AgentLoop.js';

export {
  discoverWorkspaceCustomizations,
  discoverHierarchicalRulesForPaths,
  enrichPromptWithMentions,
  expandSlashCommandPrompt,
  filterRulesForPaths,
  generateWorkspaceInfo,
  getClineDefaultSystemPrompt,
  globToRegExp,
  loadWorkspaceProblemsText,
  parseRuleFrontmatter,
  pathMatchesGlobs,
  selectSkillsForPrompt,
  type WorkspaceCustomizations,
  type WorkspaceInfo,
  type WorkspaceRule,
} from './PromptBuilder.js';

export {
  runEditSubagent,
  type EditProposal,
  type EditSubagentParams,
  type EditSubagentResult,
} from './EditSubagent.js';

export {
  createSubagentSandbox,
  runDiagnoseAndVerify,
  SUBAGENT_TOOL_ALLOWLIST,
  type SandboxTranscriptEntry,
  type SubagentRole,
  type SubagentSandbox,
} from './SubagentSandbox.js';

export {
  appendAgentMemory,
  digestTextToMemorySummary,
  formatAgentMemoryForPrompt,
  loadAgentMemory,
  type AgentMemoryEntry,
  type AgentMemoryStore,
} from './SessionMemory.js';

export {
  createBuiltinTools,
  createTool,
  createToolPoliciesWithPreset,
  overlayToolPoliciesWithHardRules,
  extractCodeOutline,
  extractCodeOutlineForPath,
  extractCodeOutlineSymbols,
  formatOutlineSymbols,
  type AgentTool,
  type BuiltinToolExecutors,
  type CreateBuiltinToolsOptions,
  type ExtractOutlineOptions,
  type OutlineSymbol,
  type OutlineSymbolKind,
  type ToolPolicyDecision,
  type ToolPolicyMap,
} from './ToolSuite.js';

export {
  compileRulesFromDocuments,
  parsePermissionFrontmatter,
  parsePermissionBodyLines,
  evaluatePermissionRules,
  toolNameToAction,
  resolveToolResource,
  type PermissionEffect,
  type PermissionRule,
  type PermissionRuleset,
  type PermissionDecision,
} from './RulePermission.js';

export {
  FileStateCache,
  normalizeCacheFilePath,
  type FileHistorySnapshot,
  type FileStateEntry,
} from './FileStateCache.js';

export {
  buildGoalBudgetLimitPrompt,
  buildGoalContinuationPrompt,
  classifyPromptIntent,
  createGoalState,
  formatGoalElapsed,
  resolveTieredModelForTurn,
  isGoalTokenBudgetExceeded,
  DEFAULT_GOAL_TOKEN_BUDGET,
  type GoalState,
  type PromptIntentClassification,
} from './GoalSteering.js';

export {
  ensureAgentSandboxBranch,
  ensureAgentWorktree,
  rollbackSessionMutations,
  type AgentWorktreeResult,
  type CircuitBreakerRollbackResult,
  type SandboxBranchResult,
} from './WorkspaceSafety.js';

export {
  IgnoreMatcher,
  createIgnoreMatcher,
  loadIgnoreRules,
  patternToMatcher,
  type IgnoreRuleSet,
} from './IgnoreRules.js';

export {
  SemanticIndex,
  tokenizeSemantic,
  type SemanticHit,
} from './SemanticIndex.js';

export { runBrowserAction, type BrowserAction, type BrowserActionResult } from './AgentBrowser.js';

export {
  DEFAULT_VERIFY_CONFIG,
  formatVerifyCommandsForPrompt,
  inferVerifyConfigFromWorkspace,
  isVerifiableSourcePath,
  loadVerifyConfig,
  type VerifyConfig,
  type VerifyConfigFileShape,
} from './VerifyConfig.js';

export {
  WorkspaceFileIndex,
  searchIndexedFiles,
  type IndexedWorkspaceFile,
  type WorkspaceFileIndexOptions,
} from './WorkspaceFileIndex.js';

export {
  parseBuildDiagnostics,
  formatDiagnosticsForPrompt,
  extractFailedTestHints,
  rankDefinitionCandidates,
  type BuildDiagnostic,
  type DiagnosticSeverity,
  type ParseBuildDiagnosticsOptions,
} from './BuildDiagnostics.js';

export {
  diagnoseTypeScriptFile,
  diagnoseEditedFile,
  diagnoseCppFile,
  diagnosePythonFile,
  attachDiagnosticSnippets,
  type DiagnoseFileParams,
} from './LanguageDiagnostics.js';

export {
  parseUnifiedPatch,
  applyPatchToContent,
  applyMultiFilePatch,
  listPatchFiles,
  type ApplyPatchResult,
  type ParsedPatchFile,
  type MultiFilePatchResult,
  type MultiFilePatchApplyItem,
} from './ApplyPatch.js';

export {
  McpHost,
  loadMcpConfigsFromWorkspace,
  type McpServerConfig,
  type McpToolDescriptor,
  type McpResourceDescriptor,
  type McpPromptDescriptor,
  type McpCallResult,
} from './McpClient.js';

export {
  applyStandardToolAliases,
  withToolAlias,
  listRegisteredToolNames,
  TOOL_NAME_ALIASES,
} from './ToolRegistry.js';

export {
  SessionTodoList,
  type SessionTodoItem,
  type TodoStatus,
  type ManageTodoInput,
} from './SessionTodo.js';

export {
  runResearchSubagent,
  runPlannerSubagent,
  buildGuidedFollowUpQueries,
  type ResearchSubagentParams,
  type ResearchSubagentResult,
} from './ResearchSubagent.js';

export {
  summarizeToolOutput,
  shouldCompactToolOutput,
  extractToolResultTuple,
  type ToolResultTuple,
} from './ToolResultSummarizer.js';

export {
  resolveCompactionPlan,
  decideBudgetCompaction,
  estimateTokensFromChars,
  type CompactionPlan,
  type ResolveCompactionPlanParams,
  type BudgetCompactionMessageItem,
  type BudgetCompactionDecision,
} from './ContextCompaction.js';

export {
  decomposeResearchHeuristic,
  decomposeResearchTask,
  parseLlmDecomposeResponse,
  type DecomposedResearch,
  type LlmDecomposeFn,
} from './ResearchDecompose.js';

/** Independent self-heal budget (verify nudges use a separate counter). */
export const MAX_SELF_HEAL_ATTEMPTS = 5;
export const MAX_VERIFY_NUDGES = 4;

export {
  captureWorkspaceFiles,
  listSessionCheckpoints,
  readSessionCheckpoint,
  restoreWorkspaceFiles,
  saveSessionCheckpoint,
  type CheckpointFileSnapshot,
  type SessionCheckpoint,
} from './SessionCheckpoint.js';

export {
  TaskTraceStore,
  globalTaskTraceStore,
  digestArgs,
  summarizePrompt,
  estimateResultBytes,
  type TraceEvent,
  type TraceEventKind,
  type TraceTerminalStatus,
  type TaskTraceSnapshot,
  type TraceTaskStart,
  type TraceLlmTurn,
  type TraceToolCall,
  type TraceVerifyResult,
  type TraceAgentSignal,
  type TraceTaskEnd,
} from './trace/TaskTrace.js';

export {
  findFileEditingCommand,
  formatPlanModeBlockedCommandError,
  assertCommandAllowedInPlanMode,
  planModeShellBudgetExceeded,
  PLAN_MODE_MAX_SHELL_CALLS_PER_TURN,
} from './CommandGuard.js';

export {
  MistakeTracker,
  type MistakeKind,
  type MistakeEvent,
  type MistakeTrackerSnapshot,
} from './MistakeTracker.js';

export {
  LoopDetection,
  type LoopSignal,
  type LoopDetectionOptions,
} from './LoopDetection.js';

export {
  ShadowGitCheckpoint,
  getShadowGitCheckpoint,
  type ShadowCheckpointResult,
  type ShadowGitCheckpointOptions,
} from './ShadowGitCheckpoint.js';

export {
  DEEPSEEK_FLASH,
  DEEPSEEK_V4_PRO,
  DEEPSEEK_AUTO,
  DEEPSEEK_PRICE_CNY_PER_M,
  normalizeDeepSeekApiModelId,
  isDeepSeekModelId,
  isLegacyReasonerAlias,
  buildDeepSeekRequestControls,
  deepSeekChatBodyExtras,
  isDeepSeekPeakHour,
  estimateDeepSeekTurnCostCny,
  formatCostCny,
  resolvePhaseReasoningEffort,
  extractDeepSeekCacheUsage,
  isGlmModelId,
  resolveGlmRequestControls,
  resolveModelContextBudget,
  parseToolArgumentsResilient,
  type DeepSeekApiModelId,
  type DeepSeekReasoningEffort,
  type DeepSeekRequestControls,
  type AgentLoopPhase,
  type NormalizedDeepSeekCacheUsage,
  type GlmRequestControls,
} from './DeepSeekModels.js';

export {
  completeDeepSeekFim,
  type DeepSeekFimParams,
  type DeepSeekFimResult,
} from './DeepSeekFim.js';

export {
  BackgroundTaskManager,
  globalBackgroundTaskManager,
  type BackgroundTaskSnapshot,
  type BackgroundTaskStatus,
} from './BackgroundTaskManager.js';

export {
  QuestionBridge,
  globalQuestionBridge,
  type AskQuestionOptionItem,
  type PendingQuestionPrompt,
  type QuestionResponsePayload,
} from './QuestionBridge.js';

export {
  loadLifecycleHooks,
  runLifecycleHooks,
  type LifecycleHookEvent,
  type LifecycleHookRule,
  type LifecycleHooksConfig,
  type HookExecutionItemResult,
  type RunLifecycleHooksResult,
} from './LifecycleHooks.js';

export {
  performWebSearch,
  type WebSearchResultItem,
  type WebSearchResponse,
} from './WebSearch.js';

export {
  SubagentOrchestrator,
  globalSubagentOrchestrator,
  type SubagentDefinition,
  type SubagentWorkspaceMode,
  type SubagentModelTier,
  type SubagentRunState,
  type SubagentMessage,
  type SubagentInstanceSnapshot,
  type SystemWakeupNotification,
} from './SubagentOrchestrator.js';

export {
  ScheduleManager,
  globalScheduleManager,
  type ScheduleTaskSnapshot,
} from './ScheduleManager.js';

export {
  discoverWorkspacePlugins,
  migrateExternalAgentSettings,
  migrateLegacyWorkflowsToSkills,
  searchMarketplace,
  installCatalogPlugin,
  listPluginAccounts,
  BUILTIN_MARKETPLACE_CATALOG,
  type AgentPluginManifest,
  type MarketplaceCatalogEntry,
  type PluginAccountStatus,
} from './PluginManager.js';

export {
  TranscriptLogger,
  globalTranscriptLogger,
  type TranscriptStepInput,
  type TranscriptStepRecord,
} from './TranscriptLogger.js';



