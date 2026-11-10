import { describe, expect, it } from 'vitest';
import {
  findFileEditingCommand,
  formatPlanModeBlockedCommandError,
  planModeShellBudgetExceeded,
  PLAN_MODE_MAX_SHELL_CALLS_PER_TURN,
} from '../src/core/CommandGuard.js';
import { MistakeTracker } from '../src/core/MistakeTracker.js';
import { LoopDetection } from '../src/core/LoopDetection.js';
import { evaluateToolPolicy } from '../src/security.js';
import { createToolPoliciesWithPreset } from '../src/core/ToolSuite.js';
import { resolveCompactionPlan } from '../src/core/ContextCompaction.js';

describe('CommandGuard', () => {
  it('allows investigation shells', () => {
    expect(findFileEditingCommand('ls -la src')).toBeUndefined();
    expect(findFileEditingCommand('git status')).toBeUndefined();
    expect(findFileEditingCommand('git stash list')).toBeUndefined();
    expect(findFileEditingCommand('npm test')).toBeUndefined();
    expect(findFileEditingCommand('cat README.md')).toBeUndefined();
    expect(
      findFileEditingCommand(
        "(command -v rg >/dev/null 2>&1 && rg -n -F 'ncclProtoGraphProperties' src 2>/dev/null || grep -rn 'ncclProtoGraphProperties' src)"
      )
    ).toBeUndefined();
    expect(findFileEditingCommand('rg -n pattern src 2>/dev/null')).toBeUndefined();
  });

  it('blocks mutating shells', () => {
    expect(findFileEditingCommand('rm -rf dist')).toMatch(/blocked/i);
    expect(findFileEditingCommand('git commit -am x')).toMatch(/blocked/i);
    expect(findFileEditingCommand('npm install lodash')).toMatch(/blocked/i);
    expect(findFileEditingCommand('echo hi > src/a.ts')).toMatch(/redirect/i);
    expect(findFileEditingCommand('sed -i s/a/b/ file.ts')).toMatch(/in-place/i);
  });

  it('plan policy allows read shells and blocks mutators', () => {
    const allowed = evaluateToolPolicy({
      toolName: 'run-build',
      executionMode: 'plan',
      isReadOnlyTool: false,
      command: 'git status',
      workspaceRoot: process.cwd(),
    });
    expect(allowed.allowedToProceed).toBe(true);

    const blocked = evaluateToolPolicy({
      toolName: 'run-build',
      executionMode: 'plan',
      isReadOnlyTool: false,
      command: 'rm -rf .',
      workspaceRoot: process.cwd(),
    });
    expect(blocked.allowedToProceed).toBe(false);
    expect(blocked.reason).toContain('PLAN_MODE_COMMAND_BLOCKED');
    expect(formatPlanModeBlockedCommandError('x')).toMatch(/PLAN_MODE/);
  });

  it('caps plan-mode shell spam per turn', () => {
    expect(planModeShellBudgetExceeded(true, PLAN_MODE_MAX_SHELL_CALLS_PER_TURN)).toBeUndefined();
    expect(planModeShellBudgetExceeded(true, PLAN_MODE_MAX_SHELL_CALLS_PER_TURN + 1)).toMatch(
      /PLAN_SHELL_BUDGET_EXCEEDED/
    );
    expect(planModeShellBudgetExceeded(false, 100)).toBeUndefined();
  });

  it('plan preset keeps shell tools available for investigation', () => {
    const plan = createToolPoliciesWithPreset('plan');
    expect(plan.run_command).toBe('allow');
    expect(plan.run_commands).toBe('allow');
    expect(plan.edit_file).toBe('deny');
  });
});

describe('MistakeTracker + LoopDetection', () => {
  it('tracks consecutive mistakes and resets on success', () => {
    const t = new MistakeTracker();
    expect(t.recordMistake('tool_error')).toBe(1);
    expect(t.recordMistake('verify_fail')).toBe(2);
    expect(t.getConsecutiveMistakes()).toBe(2);
    t.recordSuccess();
    expect(t.getConsecutiveMistakes()).toBe(0);
    expect(t.getTotalMistakes()).toBe(2);
  });

  it('detects repeated identical tool calls', () => {
    const loop = new LoopDetection({ toolRepeatThreshold: 3 });
    expect(loop.observeToolCall('read_file', { path: 'a.ts' })).toBeUndefined();
    expect(loop.observeToolCall('read_file', { path: 'a.ts' })).toBeUndefined();
    const hit = loop.observeToolCall('read_file', { path: 'a.ts' });
    expect(hit?.kind).toBe('tool_repeat');
    expect(hit?.count).toBe(3);
  });

  it('detects repeated assistant content', () => {
    const loop = new LoopDetection({ contentRepeatThreshold: 2 });
    expect(loop.observeAssistantContent('same answer')).toBeUndefined();
    const hit = loop.observeAssistantContent('same answer');
    expect(hit?.kind).toBe('content_repeat');
  });
});

describe('Provider-token compaction trigger', () => {
  it('compacts from provider usage alone', () => {
    const plan = resolveCompactionPlan({
      toolResultChars: 2_000,
      tokenBudget: 100_000,
      tokensUsed: 70_000,
    });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.trigger).toBe('provider_tokens');
    expect(plan.stage).not.toBe('none');
  });
});
