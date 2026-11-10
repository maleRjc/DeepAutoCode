import { describe, expect, it } from 'vitest';
import {
  resolveCompileBuildFailContinuation,
  resolveCompileLacksPlanContinuation,
  shouldEmitCompileRemediationExhausted,
  buildCompileRemediationFollowUpPrompt,
  COMPILE_REMEDIATION_CONTINUATION_MAX,
} from '../src/core/CompileRemediationContinuation.js';

const base = {
  compileRemediationTurn: true,
  isReadOnlyTurn: false,
  executionMode: 'auto',
  sessionWriteCount: 0,
  lastBuildOrTestFailed: false,
  assistantText: 'Now I see the issue...',
  compileRemediationContinuationCount: 0,
  autoContinuationCount: 0,
};

describe('CompileRemediationContinuation', () => {
  it('nudges edit when build failed and no writes', () => {
    expect(
      resolveCompileBuildFailContinuation({
        ...base,
        lastBuildOrTestFailed: true,
      })
    ).toBe('compile_build_fail_no_edit');
  });

  it('skips build-fail nudge in plan mode', () => {
    expect(
      resolveCompileBuildFailContinuation({
        ...base,
        lastBuildOrTestFailed: true,
        executionMode: 'plan',
      })
    ).toBeNull();
  });

  it('nudges plan when reply lacks remediation headers', () => {
    expect(resolveCompileLacksPlanContinuation(base)).toBe('compile_lacks_plan');
    expect(
      resolveCompileLacksPlanContinuation({
        ...base,
        assistantText: '## 根因\nx\n## 修复步骤\n1. y',
      })
    ).toBeNull();
  });

  it('builds follow-up prompt with snippet and verify command', () => {
    const p = buildCompileRemediationFollowUpPrompt({
      failureSnippet: 'error: prims_ll.h:181',
      verifyCommand: 'ninja -C build',
    });
    expect(p).toContain('[FORCE_AUTO_ACTION]');
    expect(p).toContain('prims_ll.h:181');
    expect(p).toContain('ninja -C build');
    expect(p).toContain('## 修复步骤');
  });

  it('emits exhausted when budget spent and still needs remediation', () => {
    expect(
      shouldEmitCompileRemediationExhausted({
        ...base,
        compileRemediationContinuationCount: COMPILE_REMEDIATION_CONTINUATION_MAX,
        stillNeedsRemediation: true,
      })
    ).toBe(true);
    expect(
      shouldEmitCompileRemediationExhausted({
        ...base,
        compileRemediationContinuationCount: COMPILE_REMEDIATION_CONTINUATION_MAX,
        stillNeedsRemediation: false,
      })
    ).toBe(false);
  });

  it('prefers build-fail branch when both build fail and lacks plan', () => {
    expect(
      resolveCompileBuildFailContinuation({
        ...base,
        lastBuildOrTestFailed: true,
      })
    ).toBe('compile_build_fail_no_edit');
    expect(
      resolveCompileLacksPlanContinuation({
        ...base,
        lastBuildOrTestFailed: true,
      })
    ).toBeNull();
  });
});
