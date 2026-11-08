import { describe, expect, it } from 'vitest';
import {
  createSubagentSandbox,
  runDiagnoseAndVerify,
  SUBAGENT_TOOL_ALLOWLIST,
} from '../src/core/SubagentSandbox.js';

describe('SubagentSandbox', () => {
  it('exposes role allowlists', () => {
    expect(SUBAGENT_TOOL_ALLOWLIST.research).toContain('search');
    expect(SUBAGENT_TOOL_ALLOWLIST.editor).toContain('edit_file');
    expect(SUBAGENT_TOOL_ALLOWLIST.verifier).toContain('verify');
  });

  it('records transcript and denies disallowed tools', async () => {
    const sb = createSubagentSandbox('research');
    await sb.wrap('search', 'foo', async () => 'ok');
    await expect(sb.wrap('edit_file', 'x', async () => 'nope')).rejects.toThrow(
      /SUBAGENT_SANDBOX/
    );
    const summary = sb.summary();
    expect(summary.calls).toBeGreaterThanOrEqual(2);
    expect(summary.denied).toBe(1);
    expect(sb.formatTranscript()).toMatch(/search/);
    expect(sb.capReport('x'.repeat(100), 20)).toContain('truncated');
  });

  it('runDiagnoseAndVerify shares diagnose→verify contract', async () => {
    const files: Record<string, string> = { 'a.ts': 'export const x = 1;' };
    const ok = await runDiagnoseAndVerify({
      files: ['a.ts'],
      alwaysVerify: true,
      readFile: async (p) => files[p],
      diagnose: async () => null,
      verify: async () => ({ exitCode: 0, stdout: 'ok' }),
    });
    expect(ok.passed).toBe(true);
    expect(ok.semanticFailed).toBe(false);

    const fail = await runDiagnoseAndVerify({
      files: ['a.ts'],
      alwaysVerify: true,
      readFile: async (p) => files[p],
      diagnose: async () => 'error TS',
      verify: async () => ({ exitCode: 0 }),
    });
    expect(fail.passed).toBe(false);
    expect(fail.semanticFailed).toBe(true);
  });
});
