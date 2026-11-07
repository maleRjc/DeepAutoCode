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

export function createGoalState(objective: string, tokenBudget: number | null = null): GoalState {
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
 * Automatic Phase-Based Multi-Tier Model Router (GUI & Agent-Lifecycle Driven — Zero CLI Commands Required).
 *
 * Inspired by Claude Code's automatic Haiku (fast tool/search) vs. Sonnet/Opus (deep reasoning/coding) routing:
 * 1. **Fast Tool Execution Tier (`deepseek-chat`)**:
 *    - Turn 1 initial file-discovery call (when no files have been read/prefetched yet): avoids wasting 20s of R1 CoT just to emit `read_file`.
 *    - Post-edit build/test verification turns (`hasEditedFiles && !hasBuildOrTestFailure`): after code is already written, running `make -j16` and summarizing test output is fast and deterministic.
 * 2. **Deep Reasoner Tier (`deepseek-reasoner`)**:
 *    - Automatically activated during the **Root-Cause Diagnosis & Fix Synthesis Phase** (once source files are in context, `hasReadFiles === true` and `hasEditedFiles === false`) when diagnosing complex bugs/failures, OR
 *    - Automatically activated on any **Self-Heal Turn** (`selfHealCount > 0` or `hasBuildOrTestFailure === true`) when a build or test (`#wrong != 0` / `FAILED`) fails and deep root-cause rethinking is required.
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
}): {
  effectiveModelId: string;
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
  } = params;

  const isDeepSeek =
    /deepseek/i.test(providerId) || /deepseek/i.test(configuredModelId);

  if (!isDeepSeek) {
    return {
      effectiveModelId: configuredModelId,
      tier: 'default',
      reason: 'non-deepseek-provider',
    };
  }

  const isComplexDiagnosisPrompt =
    /(?:还是不对|不对|为什么|原因|根因|#wrong|FAILED|Out of bounds|报错|失败|异常|死锁|崩溃|段错误|Segmentation fault|bug|kernel|自环|未初始化)/i.test(
      userPrompt
    );

  // 1. Self-Heal Turn: previous compile or test verification failed -> ALWAYS promote to deep-reasoner
  if (selfHealCount > 0 || hasBuildOrTestFailure) {
    return {
      effectiveModelId: 'deepseek-reasoner',
      tier: 'deep-reasoner',
      reason: 'auto-promoted: build/test failure self-healing requires deep reasoning',
    };
  }

  // 2. Post-Edit Verification Turn: code was already modified, now just running make/test or summarizing -> use fast model
  if (hasEditedFiles && !hasBuildOrTestFailure) {
    return {
      effectiveModelId: 'deepseek-chat',
      tier: 'fast-tool',
      reason: 'auto-fast: post-edit build/test verification turn',
    };
  }

  // 3. Turn 1 Initial File Discovery (before any files are read/prefetched into context):
  //    Use fast model to emit parallel read_file / explore_codebase calls in ~1s instead of waiting 20s for R1 CoT
  if (turnIndex === 1 && !hasReadFiles && configuredModelId !== 'deepseek-reasoner') {
    return {
      effectiveModelId: 'deepseek-chat',
      tier: 'fast-tool',
      reason: 'auto-fast: initial file discovery turn',
    };
  }

  // 4. Root-Cause Diagnosis & Fix Synthesis Turn: files ARE in context (prefetched or read in Turn 1),
  //    no edits made yet, and task is a bug diagnosis / root-cause fix -> promote to deep-reasoner
  if (
    hasReadFiles &&
    !hasEditedFiles &&
    (isComplexDiagnosisPrompt ||
      configuredModelId === 'deepseek-auto' ||
      configuredModelId === 'deepseek-reasoner')
  ) {
    return {
      effectiveModelId: 'deepseek-reasoner',
      tier: 'deep-reasoner',
      reason: 'auto-promoted: root-cause diagnosis with source files loaded in context',
    };
  }

  // 5. If user selected `deepseek-reasoner`, even on Turn 1 without prefetched files,
  //    keep `deepseek-reasoner` if files were already in prompt or user explicitly chose reasoner;
  //    if user selected `deepseek-auto`, default to fast `deepseek-chat` for routine turns.
  if (configuredModelId === 'deepseek-auto') {
    return {
      effectiveModelId: isComplexDiagnosisPrompt && turnIndex >= 2 ? 'deepseek-reasoner' : 'deepseek-chat',
      tier: isComplexDiagnosisPrompt && turnIndex >= 2 ? 'deep-reasoner' : 'fast-tool',
      reason: 'deepseek-auto phase routing',
    };
  }

  return {
    effectiveModelId: configuredModelId,
    tier: /reasoner|r1/i.test(configuredModelId) ? 'deep-reasoner' : 'default',
    reason: 'configured-model',
  };
}

export interface PromptIntentClassification {
  intent: 'query-only' | 'auto-action';
  allowFileMutations: boolean;
  label: string;
  reason: string;
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

  // 1. Explicit read-only guard phrases from user or UI button
  if (
    /(?:^\[READ_ONLY_ANALYSIS\]|只分析|仅分析|不要改|先别改|别修改|不修改|不要修改|只查询|只看|只解释|先分析一下.*不要)/i.test(
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

  // 1b. Explicit force-auto-action from UI button
  if (/^\[FORCE_AUTO_ACTION\]/i.test(cleaned)) {
    return {
      intent: 'auto-action',
      allowFileMutations: true,
      label: '🛠️ 智能识别：自动修改 + 编译验证',
      reason: 'explicit-force-auto-action',
    };
  }

  // 2. Explicit code modification / bug fix / feature implementation / build-test verbs
  const hasExplicitActionVerb =
    /(?:修复|修改|改一下|帮我改|直接改|改好|解决|处理|实现|新增|添加|创建|编写|写一个|重构|优化|升级|替换|删除|编译|构建|运行测试|跑一下|按你的建议|按你说的|按此方案|落地|继续改|还是不对|仍然不对|依然不对|一键自动)/i.test(
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

  // Question mark at the end without action verbs -> treat as read-only query
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



