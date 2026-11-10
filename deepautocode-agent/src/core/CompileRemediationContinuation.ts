import { assistantLacksRemediationPlan } from './GoalSteering.js';

export const COMPILE_REMEDIATION_CONTINUATION_MAX = 4;
export const AUTO_CONTINUATION_COMPILE_CAP = 14;

export type CompileRemediationContinuationCase =
  | 'compile_build_fail_no_edit'
  | 'compile_lacks_plan';

export interface CompileRemediationContinuationInput {
  compileRemediationTurn: boolean;
  isReadOnlyTurn: boolean;
  executionMode: string;
  sessionWriteCount: number;
  lastBuildOrTestFailed: boolean;
  assistantText: string;
  compileRemediationContinuationCount: number;
  autoContinuationCount: number;
}

function compileRemediationGatesOpen(input: CompileRemediationContinuationInput): boolean {
  if (!input.compileRemediationTurn || input.isReadOnlyTurn) return false;
  if (input.executionMode !== 'auto') return false;
  if (input.sessionWriteCount !== 0) return false;
  if (input.compileRemediationContinuationCount >= COMPILE_REMEDIATION_CONTINUATION_MAX) {
    return false;
  }
  if (input.autoContinuationCount >= AUTO_CONTINUATION_COMPILE_CAP) return false;
  return true;
}

/** First gate: build/test failed but workspace still untouched (priority before generic early-exit). */
export function resolveCompileBuildFailContinuation(
  input: CompileRemediationContinuationInput
): CompileRemediationContinuationCase | null {
  if (!compileRemediationGatesOpen(input)) return null;
  if (!input.lastBuildOrTestFailed) return null;
  return 'compile_build_fail_no_edit';
}

/** Second gate: analysis-only reply without structured fix plan. */
export function resolveCompileLacksPlanContinuation(
  input: CompileRemediationContinuationInput
): CompileRemediationContinuationCase | null {
  if (!compileRemediationGatesOpen(input)) return null;
  if (input.lastBuildOrTestFailed) return null;
  if (!assistantLacksRemediationPlan(input.assistantText)) return null;
  return 'compile_lacks_plan';
}

export const COMPILE_REMEDIATION_EXHAUSTED_USER_HINTS = [
  '在 Composer 中追加：[FORCE_AUTO_ACTION] + 明确要求 edit_file 修改日志里的 file:line，再 run_command 重编。',
  '若只想拿方案：要求输出 ## 根因 / ## 修复步骤 / ## 验证命令（含具体删改）。',
  '打开 Trace → 查看「自愈/续跑」时间线，确认是否卡在 compile_lacks_plan。',
] as const;

/** Agent exhausted compile-specific continuation budget but problem remains. */
export function shouldEmitCompileRemediationExhausted(
  input: CompileRemediationContinuationInput & { stillNeedsRemediation: boolean }
): boolean {
  if (!input.compileRemediationTurn || input.isReadOnlyTurn) return false;
  if (input.executionMode !== 'auto') return false;
  if (input.sessionWriteCount !== 0) return false;
  if (!input.stillNeedsRemediation) return false;
  return input.compileRemediationContinuationCount >= COMPILE_REMEDIATION_CONTINUATION_MAX;
}

/** One-click follow-up prompt after compile remediation budget is exhausted. */
export function buildCompileRemediationFollowUpPrompt(options?: {
  failureSnippet?: string;
  verifyCommand?: string;
}): string {
  const snippet = String(options?.failureSnippet || '').trim().slice(0, 800);
  const verify = String(options?.verifyCommand || '').trim();
  const verifyLine = verify ? `（推荐：\`${verify}\`）` : '';
  return `[FORCE_AUTO_ACTION]
上一轮自动续跑已达上限，请不要再只分析或重复 run_command 复述错误。必须：
1) 用 edit_file / apply_patch 按日志 file:line 修改源码；
2) run_command 重编验证${verifyLine}；
3) 收尾输出 ## 根因 / ## 修复步骤 / ## 验证命令（含具体删改）。
${snippet ? `\n最近失败摘要：\n\`\`\`\n${snippet}\n\`\`\`` : ''}`.trim();
}
