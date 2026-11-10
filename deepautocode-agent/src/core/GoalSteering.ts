/**
 * GoalSteering & Completion Audit Engine
 * Ported & adapted from Claude Code (`src/services/goal/prompts.ts`, `src/services/goal/goalState.ts`,
 * and `src/utils/model/providers.ts`).
 *
 * Provides:
 * 1. Continuous autonomous `/goal` state machine (`GoalState`) with token budget tracking.
 * 2. Strict 6-point Completion Audit & 3-turn Blocked Audit meta-prompts (`<goal-steering>`).
 * 3. Multi-tier model routing (`resolveTieredModelForTurn`) separating fast tool execution
 *    from deep root-cause reasoning.
 */

export interface GoalState {
  id: string;
  objective: string;
  status: 'active' | 'paused' | 'completed' | 'blocked';
  startedAt: number;
  turnsExecuted: number;
  tokensUsed: number;
  tokenBudget: number | null;
  consecutiveBlockedTurns: number;
  verifiedByCommand: boolean;
}

/** Default per-run token budget for context compaction + budget-limit steering. */
export const DEFAULT_GOAL_TOKEN_BUDGET = 180_000;

export function createGoalState(
  objective: string,
  tokenBudget: number | null = DEFAULT_GOAL_TOKEN_BUDGET
): GoalState {
  const cleanObjective = objective.replace(/^\/goal\s+/i, '').trim();
  return {
    id: `goal_${Date.now()}`,
    objective: cleanObjective || objective.trim(),
    status: 'active',
    startedAt: Date.now(),
    turnsExecuted: 0,
    tokensUsed: 0,
    tokenBudget,
    consecutiveBlockedTurns: 0,
    verifiedByCommand: false,
  };
}

export function isGoalTokenBudgetExceeded(goal: GoalState, ratio = 0.92): boolean {
  if (goal.tokenBudget == null || goal.tokenBudget <= 0) return false;
  return goal.tokensUsed >= goal.tokenBudget * ratio;
}

export function formatGoalElapsed(goal: GoalState): string {
  const sec = Math.max(1, Math.round((Date.now() - goal.startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

/**
 * Builds the `<goal-steering type="continuation">` prompt with Claude Code's
 * 6-point Completion Audit and 3-turn Blocked Audit.
 */
export function buildGoalContinuationPrompt(
  goal: GoalState,
  reasonHint?: string
): string {
  const elapsed = formatGoalElapsed(goal);
  const tokenInfo =
    goal.tokenBudget !== null
      ? `Tokens used: ${goal.tokensUsed} / ${goal.tokenBudget} (${Math.max(0, goal.tokenBudget - goal.tokensUsed)} remaining)`
      : `Tokens used: ${goal.tokensUsed}`;

  return `<goal-steering type="continuation">
You have an active goal to complete. Continue making concrete progress via tools.

## Active Goal
${goal.objective}

## Status
- Elapsed active time: ${elapsed}
- ${tokenInfo}
- Continuation turns executed: ${goal.turnsExecuted}
${reasonHint ? `- Immediate Audit Trigger: ${reasonHint}\n` : ''}
## Strict Completion Audit (必须通过以下 6 项完成度审计才允许结束)
1. Derive concrete requirements from the objective and any referenced files.
2. Preserve the original scope — do NOT redefine success around what is already done.
3. For every explicit requirement or bug fix, produce authoritative evidence (actual compile output, test execution result with #wrong=0 / 0 errors, and verified file diff).
4. Treat tests and builds as evidence ONLY after actually running them via \`run_command\` and confirming they pass.
5. Treat uncertain, uncompiled, or indirect assumptions as "not achieved".
6. Never ask the user to run build/test commands manually when you can execute \`run_command\` yourself.

## Blocked Audit
- Do NOT stop or mark blocked on the first failure (${goal.consecutiveBlockedTurns}/3 consecutive obstacle turns).
- If a build or test fails, immediately inspect the error, refine the code via \`edit_file\`, and re-verify via \`run_command\`.
</goal-steering>`;
}

export function buildGoalBudgetLimitPrompt(goal: GoalState): string {
  return `<goal-steering type="budget_limit">
## Token Budget Reached
- Goal: ${goal.objective}
- Tokens used: ${goal.tokensUsed}${goal.tokenBudget !== null ? ` / ${goal.tokenBudget}` : ''}
- Active time: ${formatGoalElapsed(goal)}

Stop starting new exploratory tool calls and concisely summarize:
1. Root cause located (\`file:line\`).
2. Code changes applied (\`file:line\`).
3. Current build/test verification status.
</goal-steering>`;
}

/**
 * Automatic Phase-Based Multi-Tier Model Router (GUI & Agent-Lifecycle Driven).
 *
 * DeepSeek V4 routing (Flash / V4-Pro × thinking on/off):
 * 1. **Fast tool tier (`deepseek-flash`, thinking off)**: discovery + verify turns.
 * 2. **Daily Auto tier (`deepseek-flash`, thinking low)**: routine coding after context is warm.
 * 3. **Deep tier (`deepseek-v4-pro`, thinking high)**: Plan/complex debug, self-heal, multi-file synthesis.
 *
 * Legacy UI ids `deepseek-chat` / `deepseek-reasoner` remain accepted as aliases.
 */
export function resolveTieredModelForTurn(params: {
  configuredModelId: string;
  providerId: string;
  userPrompt: string;
  turnIndex: number;
  selfHealCount: number;
  hasReadFiles?: boolean;
  hasEditedFiles?: boolean;
  hasBuildOrTestFailure?: boolean;
  /** Post-edit TypeScript/semantic diagnostics failed */
  hasSemanticFailure?: boolean;
  /** Consecutive edit_file oldText mismatches in this session */
  editMismatchCount?: number;
  /** Multiple files mutated this session */
  multiFilePending?: boolean;
  /** UI lock: auto | force-fast | force-reasoner */
  routingMode?: 'auto' | 'force-fast' | 'force-reasoner';
}): {
  effectiveModelId: string;
  thinkingEnabled: boolean;
  reasoningEffort: 'low' | 'high' | 'max' | null;
  tier: 'fast-tool' | 'deep-reasoner' | 'default';
  reason: string;
} {
  const {
    configuredModelId,
    providerId,
    userPrompt,
    turnIndex,
    selfHealCount,
    hasReadFiles = false,
    hasEditedFiles = false,
    hasBuildOrTestFailure = false,
    hasSemanticFailure = false,
    editMismatchCount = 0,
    multiFilePending = false,
    routingMode = 'auto',
  } = params;

  const isDeepSeek =
    /deepseek/i.test(providerId) || /deepseek/i.test(configuredModelId);

  if (!isDeepSeek) {
    return {
      effectiveModelId: configuredModelId,
      thinkingEnabled: false,
      reasoningEffort: null,
      tier: 'default',
      reason: 'non-deepseek-provider',
    };
  }

  const flashFast = (reason: string) => ({
    effectiveModelId: 'deepseek-flash',
    thinkingEnabled: false,
    reasoningEffort: null as null,
    tier: 'fast-tool' as const,
    reason,
  });
  const flashThinkLow = (reason: string) => ({
    effectiveModelId: 'deepseek-flash',
    thinkingEnabled: true,
    reasoningEffort: 'low' as const,
    tier: 'fast-tool' as const,
    reason,
  });
  const proThinkHigh = (reason: string) => ({
    effectiveModelId: 'deepseek-v4-pro',
    thinkingEnabled: true,
    reasoningEffort: 'high' as const,
    tier: 'deep-reasoner' as const,
    reason,
  });

  if (routingMode === 'force-fast') {
    return flashFast('ui-force-fast');
  }
  if (routingMode === 'force-reasoner') {
    return proThinkHigh('ui-force-reasoner');
  }

  const isComplexDiagnosisPrompt =
    /(?:还是不对|不对|为什么|原因|根因|#wrong|FAILED|Out of bounds|报错|失败|异常|死锁|崩溃|段错误|Segmentation fault|bug|kernel|自环|未初始化)/i.test(
      userPrompt
    );
  const wantsLegacyReasoner =
    configuredModelId === 'deepseek-reasoner' ||
    configuredModelId === 'deepseek-v4-pro' ||
    /force-reasoner/i.test(configuredModelId);
  const isAuto =
    configuredModelId === 'deepseek-auto' ||
    configuredModelId === 'deepseek-chat' ||
    configuredModelId === 'deepseek-flash' ||
    !configuredModelId;

  // 1. Self-heal / semantic / mismatch / multi-file → Pro + thinking
  if (
    selfHealCount > 0 ||
    hasBuildOrTestFailure ||
    hasSemanticFailure ||
    editMismatchCount >= 2 ||
    multiFilePending
  ) {
    let reason = 'auto-promoted: build/test failure self-healing requires deep reasoning';
    if (hasSemanticFailure) {
      reason = 'auto-promoted: post-edit semantic diagnostics require deep reasoning';
    } else if (editMismatchCount >= 2) {
      reason = 'auto-promoted: repeated edit_file mismatch requires deep reasoning';
    } else if (multiFilePending && !hasBuildOrTestFailure && selfHealCount === 0) {
      reason = 'auto-promoted: multi-file change synthesis';
    }
    return proThinkHigh(reason);
  }

  // 2. Post-edit verification → Flash, no thinking
  if (hasEditedFiles && !hasBuildOrTestFailure && !hasSemanticFailure) {
    return flashFast('auto-fast: post-edit build/test verification turn');
  }

  // 3. Turn 1 discovery → Flash, no thinking
  if (turnIndex === 1 && !hasReadFiles && !wantsLegacyReasoner) {
    return flashFast('auto-fast: initial file discovery turn');
  }

  // 4. Root-cause diagnosis with files loaded → Pro + thinking
  if (
    hasReadFiles &&
    !hasEditedFiles &&
    (isComplexDiagnosisPrompt || isAuto || wantsLegacyReasoner)
  ) {
    return proThinkHigh(
      'auto-promoted: root-cause diagnosis with source files loaded in context'
    );
  }

  // 5. deepseek-auto routine turns
  if (configuredModelId === 'deepseek-auto') {
    if (isComplexDiagnosisPrompt && turnIndex >= 2) {
      return proThinkHigh('deepseek-auto phase routing');
    }
    return flashThinkLow('deepseek-auto phase routing');
  }

  if (wantsLegacyReasoner) {
    return proThinkHigh('configured-model: pro/reasoner');
  }

  if (
    configuredModelId === 'deepseek-flash' ||
    configuredModelId === 'deepseek-chat' ||
    /flash|chat/i.test(configuredModelId)
  ) {
    return flashThinkLow('configured-model: flash');
  }

  return {
    effectiveModelId: configuredModelId.includes('pro')
      ? 'deepseek-v4-pro'
      : 'deepseek-flash',
    thinkingEnabled: /pro|reasoner|r1/i.test(configuredModelId),
    reasoningEffort: /pro|reasoner|r1/i.test(configuredModelId) ? 'high' : 'low',
    tier: /pro|reasoner|r1/i.test(configuredModelId) ? 'deep-reasoner' : 'default',
    reason: 'configured-model',
  };
}

export interface PromptIntentClassification {
  intent: 'query-only' | 'auto-action';
  allowFileMutations: boolean;
  label: string;
  reason: string;
}

/** User wants a file artifact in the workspace (md/pdf/report), not chat-only analysis. */
/** Compile / test failure remediation: user expects edits or an actionable fix plan, not analysis-only. */
export function promptRequestsCompileRemediation(rawPrompt: string): boolean {
  const cleaned = String(rawPrompt || '')
    .replace(/^\[(?:READ_ONLY_ANALYSIS|FORCE_AUTO_ACTION|INLINE_QUERY|INLINE_EDIT)\]\s*/i, '')
    .trim();
  if (!cleaned || promptRequestsWorkspaceArtifact(rawPrompt)) return false;
  const intent = classifyPromptIntent(rawPrompt);
  if (!intent.allowFileMutations) return false;
  const hasCompileOrErrorContext =
    /\b(?:编译|构建|build|make|cmake|ninja|hipcc|hipify|nvcc|clang|gcc|g\+\+)\b/i.test(cleaned) ||
    /\b(?:error:|fatal error:|undefined reference|undeclared identifier|should return a value)\b/i.test(
      cleaned
    );
  return intent.reason === 'action-verb-or-error-log' || (intent.intent === 'auto-action' && hasCompileOrErrorContext);
}

export function assistantLacksRemediationPlan(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return true;
  const hasStructuredFix =
    /(?:^|\n)#+\s*修复步骤|(?:^|\n)#+\s*根因\b|(?:^|\n)#+\s*验证(?:命令)?\b|###\s*(?:改动|修改|步骤)\s*\d|##\s*Fix\s*Steps|##\s*Root\s*Cause|##\s*Verification/i.test(
      t
    );
  if (hasStructuredFix) return false;
  const hasFileLinePatch =
    /(?:`[^`]+\.(?:c|cpp|h|hpp|cu|cc|cxx):\d+`|\.(?:c|cpp|h|hpp)\s*:\d+\s*[:：])/i.test(t) &&
    /(?:edit_file|apply_patch|删除|改为|替换|添加|remove|replace|patch)/i.test(t);
  if (hasFileLinePatch) return false;
  return true;
}

export function promptRequestsWorkspaceArtifact(rawPrompt: string): boolean {
  const cleaned = String(rawPrompt || '')
    .replace(/^\[(?:READ_ONLY_ANALYSIS|FORCE_AUTO_ACTION|INLINE_QUERY|INLINE_EDIT)\]\s*/i, '')
    .trim();
  if (!cleaned) return false;
  return (
    /(?:生成|导出|输出|制作|撰写|写一份|写个|写成|保存为|落地为|生成一份|做成).{0,32}(?:pdf|文档|教程|手册|报告|markdown|\.md|docx|html|slides?)/i.test(
      cleaned
    ) ||
    /(?:完整的|详细的).{0,20}(?:pdf|教程|文档|手册|报告)/i.test(cleaned) ||
    /(?:pdf|\.md)\s*文档/i.test(cleaned) ||
    /\bwrite_file\b/i.test(cleaned)
  );
}

/**
 * Smart User Intent Classifier (`classifyPromptIntent`).
 * Automatically distinguishes between:
 * - `query-only`: User wants code explanation, symbol lookup, architecture analysis, or root-cause query WITHOUT modifying files.
 * - `auto-action`: User wants bug fixing, code modification, feature implementation, or build/test execution.
 */
export function classifyPromptIntent(rawPrompt: string): PromptIntentClassification {
  const cleaned = String(rawPrompt || '')
    .replace(/^\[Context Active File:[^\]]+\]\s*/i, '')
    .replace(/\[Auto-Prefetched Workspace Files[\s\S]*$/i, '')
    .replace(/\[Prior Session Executed Tools[\s\S]*$/i, '')
    .trim();

  if (!cleaned) {
    return {
      intent: 'query-only',
      allowFileMutations: false,
      label: '🔍 仅分析查询（不改代码）',
      reason: 'empty-prompt',
    };
  }

  // 1. Explicit read-only guard phrases from user or UI button (incl. Ctrl+I INLINE_QUERY)
  if (
    /(?:^\[(?:READ_ONLY_ANALYSIS|INLINE_QUERY)\]|只分析|仅分析|不要改|先别改|别修改|不修改|不要修改|只查询|只看|只解释|先分析一下.*不要)/i.test(
      cleaned
    )
  ) {
    return {
      intent: 'query-only',
      allowFileMutations: false,
      label: '🔍 智能识别：仅分析查询（不改代码）',
      reason: 'explicit-read-only-phrase',
    };
  }

  // 1b. Explicit force-auto-action from UI / Ctrl+I INLINE_EDIT
  if (/^\[(?:FORCE_AUTO_ACTION|INLINE_EDIT)\]/i.test(cleaned)) {
    return {
      intent: 'auto-action',
      allowFileMutations: true,
      label: '🛠️ 智能识别：自动修改 + 编译验证',
      reason: 'explicit-force-auto-action',
    };
  }

  // 2. Deliverables (docs/pdf/tutorials) always require write_file / run-build — never Plan-only.
  if (promptRequestsWorkspaceArtifact(cleaned)) {
    return {
      intent: 'auto-action',
      allowFileMutations: true,
      label: '📄 智能识别：生成文档/产物（写入工作区）',
      reason: 'workspace-artifact-deliverable',
    };
  }

  // 3. Explicit code modification / bug fix / feature implementation / build-test verbs
  const hasExplicitActionVerb =
    /(?:修复|修改|改一下|帮我改|直接改|改好|解决|处理|实现|新增|添加|创建|编写|写一个|写一份|生成|导出|制作|重构|优化|升级|替换|删除|编译|构建|运行测试|跑一下|按你的建议|按你说的|按此方案|落地|继续改|还是不对|仍然不对|依然不对|一键自动)/i.test(
      cleaned
    );

  // Raw error / test failure log pasted directly
  const hasPastedErrorLog =
    /(?:#wrong\s*=\s*[1-9]|Out of bounds values\s*:\s*[1-9]|\bfatal error:|\berror:\s+[^\n]+|\bSegmentation fault\b|\bFAILED\b|ENOENT|EADDRINUSE)/i.test(
      cleaned
    );

  // Pure query / explanation patterns
  const hasPureQueryPattern =
    /(?:是什么|是干嘛的|干什么用|在哪里|在哪儿|怎么理解|为什么|为何|如何理解|帮我看看|帮我查|查一下|查询|分析一下|解释一下|介绍一下|讲讲|有哪些|区别是|流程是|调用链|逻辑是)/i.test(
      cleaned
    );

  if (hasPureQueryPattern && !hasExplicitActionVerb && !hasPastedErrorLog) {
    return {
      intent: 'query-only',
      allowFileMutations: false,
      label: '🔍 智能识别：仅分析查询（不改代码）',
      reason: 'query-or-analysis-without-edit-verb',
    };
  }

  if (hasExplicitActionVerb || hasPastedErrorLog) {
    return {
      intent: 'auto-action',
      allowFileMutations: true,
      label: '🛠️ 智能识别：自动修改 + 编译验证',
      reason: 'action-verb-or-error-log',
    };
  }

  // Polite questions ("...吗？") without action verbs -> read-only; deliverables handled above.
  if (/[?？]\s*$/.test(cleaned)) {
    return {
      intent: 'query-only',
      allowFileMutations: false,
      label: '🔍 智能识别：仅分析查询（不改代码）',
      reason: 'interrogative-question',
    };
  }

  return {
    intent: 'auto-action',
    allowFileMutations: true,
    label: '🛠️ 智能识别：自动修改 + 编译验证',
    reason: 'default-auto-action',
  };
}



