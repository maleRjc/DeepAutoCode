export {
  Agent,
  AgentRuntime,
  ClineCore,
  type AgentMessage,
  type AgentMessagePart,
  type AgentModelAdapter,
  type AgentModelStreamChunk,
  type AgentOptions,
  type AgentRunResult,
} from './AgentLoop.js';

export {
  discoverWorkspaceCustomizations,
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
} from './ToolResultSummarizer.js';

export {
  resolveCompactionPlan,
  estimateTokensFromChars,
  type CompactionPlan,
  type ResolveCompactionPlanParams,
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

