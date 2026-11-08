/**
 * Stage T: lightweight subagent sandbox — tool allowlist + isolated transcript + capped report.
 */

export type SubagentRole = 'research' | 'planner' | 'verifier' | 'editor';

export const SUBAGENT_TOOL_ALLOWLIST: Record<SubagentRole, readonly string[]> = {
  research: ['search', 'read_file', 'outline', 'llm_decompose', 'llm_synthesize'],
  planner: ['search', 'read_file', 'outline', 'llm_decompose', 'llm_synthesize'],
  verifier: ['read_file', 'diagnose', 'verify'],
  editor: ['read_file', 'edit_file', 'write_file', 'diagnose', 'verify', 'llm_propose'],
};

export interface SandboxTranscriptEntry {
  tool: string;
  ok: boolean;
  detail?: string;
  at: string;
}

export interface SubagentSandbox {
  role: SubagentRole;
  allowedTools: readonly string[];
  transcript: SandboxTranscriptEntry[];
  assertAllowed(tool: string): void;
  record(tool: string, ok: boolean, detail?: string): void;
  wrap<T>(tool: string, detail: string | undefined, fn: () => Promise<T>): Promise<T>;
  formatTranscript(limit?: number): string;
  capReport(report: string, maxChars?: number): string;
  summary(): {
    role: SubagentRole;
    allowedTools: string[];
    calls: number;
    denied: number;
    transcript: SandboxTranscriptEntry[];
  };
}

export function createSubagentSandbox(role: SubagentRole): SubagentSandbox {
  const allowedTools = SUBAGENT_TOOL_ALLOWLIST[role] || [];
  const allowed = new Set(allowedTools.map((t) => t.toLowerCase()));
  const transcript: SandboxTranscriptEntry[] = [];
  let denied = 0;

  const assertAllowed = (tool: string) => {
    if (!allowed.has(String(tool || '').toLowerCase())) {
      denied += 1;
      transcript.push({
        tool,
        ok: false,
        detail: `DENIED (not in ${role} allowlist)`,
        at: new Date().toISOString(),
      });
      throw new Error(
        `SUBAGENT_SANDBOX: tool "${tool}" is not allowed for role=${role}. Allowed: ${allowedTools.join(', ')}`
      );
    }
  };

  const record = (tool: string, ok: boolean, detail?: string) => {
    transcript.push({
      tool,
      ok,
      detail: detail ? String(detail).slice(0, 200) : undefined,
      at: new Date().toISOString(),
    });
  };

  return {
    role,
    allowedTools,
    transcript,
    assertAllowed,
    record,
    async wrap<T>(tool: string, detail: string | undefined, fn: () => Promise<T>): Promise<T> {
      assertAllowed(tool);
      try {
        const result = await fn();
        record(tool, true, detail);
        return result;
      } catch (err) {
        record(tool, false, (err as Error).message || detail);
        throw err;
      }
    },
    formatTranscript(limit = 40) {
      return transcript
        .slice(-limit)
        .map((e) => `- [${e.ok ? 'ok' : 'fail'}] ${e.tool}${e.detail ? `: ${e.detail}` : ''}`)
        .join('\n');
    },
    capReport(report: string, maxChars = 6000) {
      const text = String(report || '');
      if (text.length <= maxChars) return text;
      return `${text.slice(0, maxChars)}\n...[subagent report truncated @${maxChars} chars]...`;
    },
    summary() {
      return {
        role,
        allowedTools: [...allowedTools],
        calls: transcript.length,
        denied,
        transcript: transcript.slice(-40),
      };
    },
  };
}

/**
 * Shared diagnose → verify contract for editor + verifier subagents.
 */
export async function runDiagnoseAndVerify(params: {
  files: string[];
  readFile: (relPath: string) => Promise<string>;
  diagnose: (relPath: string, content: string) => Promise<string | null>;
  verify?: () => Promise<{
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    skipped?: boolean;
    reason?: string;
  }>;
  /** When true, run verify even if diagnostics are clean (verifier default). */
  alwaysVerify?: boolean;
}): Promise<{
  semanticFailed: boolean;
  verifyFailed: boolean;
  passed: boolean;
  diagLines: string[];
  verifyResult: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    skipped?: boolean;
    reason?: string;
  };
}> {
  const diagLines: string[] = [];
  let semanticFailed = false;
  for (const f of params.files.slice(0, 8)) {
    try {
      const content = await params.readFile(f);
      const errText = await params.diagnose(f, content);
      if (errText) {
        semanticFailed = true;
        diagLines.push(`### ${f}\n${errText}`);
      } else {
        diagLines.push(`### ${f}\n(no semantic errors)`);
      }
    } catch (err) {
      semanticFailed = true;
      diagLines.push(`### ${f}\n(diagnose failed: ${(err as Error).message})`);
    }
  }

  let verifyResult: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    skipped?: boolean;
    reason?: string;
  } = { skipped: true, reason: 'verify not requested' };

  const shouldVerify =
    typeof params.verify === 'function' &&
    (params.alwaysVerify || (!semanticFailed && params.files.length > 0));

  if (shouldVerify && params.verify) {
    try {
      verifyResult = await params.verify();
    } catch (err) {
      verifyResult = { exitCode: 1, stderr: (err as Error).message };
    }
  }

  const verifyFailed =
    typeof verifyResult.exitCode === 'number' && verifyResult.exitCode !== 0;
  const passed = !semanticFailed && !verifyFailed;

  return { semanticFailed, verifyFailed, passed, diagLines, verifyResult };
}
