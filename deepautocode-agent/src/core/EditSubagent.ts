/**
 * Budgeted edit subagent — isolated surgical edits with hard file/edit caps and rollback.
 */
export interface EditProposal {
  filePath: string;
  oldText: string;
  newText: string;
}

export interface EditSubagentParams {
  task: string;
  files: string[];
  /** Hard cap on distinct files that may be mutated (default 3). */
  maxFiles?: number;
  /** Hard cap on edit hunks applied (default 6). */
  maxEdits?: number;
  readFile: (relPath: string) => Promise<string>;
  writeFile: (relPath: string, content: string) => Promise<void>;
  applyEdit: (relPath: string, oldText: string, newText: string) => Promise<{ ok: boolean; error?: string; content?: string }>;
  diagnose?: (relPath: string, content: string) => Promise<string | null>;
  /**
   * Optional verify gate after diagnostics pass (shared contract with verifier).
   * Failure triggers rollback of all edits in this subagent turn.
   */
  verify?: () => Promise<{
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    skipped?: boolean;
    reason?: string;
  }>;
  /**
   * Nested LLM: given task + file snippets, return JSON array of
   * [{ "filePath", "oldText", "newText" }] (or markdown-fenced JSON).
   */
  llmPropose: (input: {
    task: string;
    snippets: Array<{ filePath: string; content: string }>;
  }) => Promise<string>;
}

export interface EditSubagentResult {
  ok: boolean;
  role: 'editor';
  task: string;
  filesInspected: string[];
  filesEdited: string[];
  editsApplied: number;
  rolledBack: boolean;
  verified?: boolean;
  report: string;
  errors: string[];
}

function parseProposals(raw: string, allowedFiles: Set<string>): EditProposal[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  let jsonText = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
  if (arrayMatch) jsonText = arrayMatch[0];
  try {
    const parsed = JSON.parse(jsonText);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.edits)
        ? parsed.edits
        : [];
    return list
      .map((item: any) => ({
        filePath: String(item?.filePath || item?.path || '')
          .replace(/\\/g, '/')
          .replace(/^\.?\//, ''),
        oldText: String(item?.oldText ?? item?.old_text ?? ''),
        newText: String(item?.newText ?? item?.new_text ?? ''),
      }))
      .filter(
        (p: EditProposal) =>
          p.filePath &&
          p.oldText &&
          p.oldText !== p.newText &&
          (allowedFiles.size === 0 || allowedFiles.has(p.filePath))
      );
  } catch {
    return [];
  }
}

/**
 * Run a single-shot budgeted edit subagent:
 * snapshot → propose → apply (capped) → diagnose → rollback on failure.
 */
export async function runEditSubagent(
  params: EditSubagentParams
): Promise<EditSubagentResult> {
  const maxFiles = Math.max(1, Math.min(params.maxFiles ?? 3, 5));
  const maxEdits = Math.max(1, Math.min(params.maxEdits ?? 6, 12));
  const targetFiles = [...new Set(params.files.map((f) => f.replace(/\\/g, '/').replace(/^\.?\//, '')))]
    .filter(Boolean)
    .slice(0, maxFiles);

  const errors: string[] = [];
  const snapshots = new Map<string, string>();
  const snippets: Array<{ filePath: string; content: string }> = [];

  for (const f of targetFiles) {
    try {
      const content = await params.readFile(f);
      snapshots.set(f, content);
      // Cap snippet size for the nested LLM (~4k chars / file)
      snippets.push({
        filePath: f,
        content: content.length > 4000 ? `${content.slice(0, 4000)}\n…[truncated]` : content,
      });
    } catch (err) {
      errors.push(`read ${f}: ${(err as Error).message}`);
    }
  }

  if (snippets.length === 0) {
    return {
      ok: false,
      role: 'editor',
      task: params.task,
      filesInspected: targetFiles,
      filesEdited: [],
      editsApplied: 0,
      rolledBack: false,
      report: `Editor subagent: no readable target files.\n${errors.join('\n')}`,
      errors,
    };
  }

  let rawProposal = '';
  try {
    rawProposal = await params.llmPropose({ task: params.task, snippets });
  } catch (err) {
    errors.push(`llmPropose: ${(err as Error).message}`);
  }

  const allowed = new Set(targetFiles);
  const proposals = parseProposals(rawProposal, allowed).slice(0, maxEdits);

  if (proposals.length === 0) {
    return {
      ok: false,
      role: 'editor',
      task: params.task,
      filesInspected: targetFiles,
      filesEdited: [],
      editsApplied: 0,
      rolledBack: false,
      report: [
        'Editor subagent: no valid edit proposals returned (budget unused).',
        'Ensure the nested model replies with JSON: [{"filePath","oldText","newText"}, ...]',
        errors.join('\n'),
      ]
        .filter(Boolean)
        .join('\n'),
      errors,
    };
  }

  const edited = new Set<string>();
  let editsApplied = 0;
  const applyLog: string[] = [];

  for (const p of proposals) {
    if (edited.size >= maxFiles && !edited.has(p.filePath)) {
      applyLog.push(`skip ${p.filePath} (maxFiles=${maxFiles})`);
      continue;
    }
    try {
      const result = await params.applyEdit(p.filePath, p.oldText, p.newText);
      if (!result.ok) {
        errors.push(`${p.filePath}: ${result.error || 'edit failed'}`);
        applyLog.push(`FAIL ${p.filePath}: ${result.error || 'edit failed'}`);
        continue;
      }
      edited.add(p.filePath);
      editsApplied += 1;
      applyLog.push(`OK ${p.filePath} (+${p.newText.length - p.oldText.length} chars)`);
      if (result.content != null) {
        snapshots.set(`__after__${p.filePath}`, result.content);
      }
    } catch (err) {
      errors.push(`${p.filePath}: ${(err as Error).message}`);
      applyLog.push(`FAIL ${p.filePath}: ${(err as Error).message}`);
    }
  }

  // Diagnose (+ optional verify) edited files; rollback all on failure
  let rolledBack = false;
  let verified = false;
  const diagLines: string[] = [];
  let verifyBlock = '';
  if (edited.size > 0 && typeof params.diagnose === 'function') {
    let failed = false;
    for (const f of edited) {
      try {
        const content =
          snapshots.get(`__after__${f}`) ?? (await params.readFile(f));
        const errText = await params.diagnose(f, content);
        if (errText) {
          failed = true;
          diagLines.push(`### ${f}\n${errText}`);
        } else {
          diagLines.push(`### ${f}\n(no semantic errors)`);
        }
      } catch (err) {
        failed = true;
        diagLines.push(`### ${f}\n(diagnose failed: ${(err as Error).message})`);
      }
    }
    if (!failed && typeof params.verify === 'function') {
      try {
        const vr = await params.verify();
        const verifyFailed = typeof vr.exitCode === 'number' && vr.exitCode !== 0;
        verifyBlock = [
          '## Verify',
          `exit=${vr.exitCode ?? 'n/a'}${vr.skipped ? ` (skipped: ${vr.reason})` : ''}`,
          (vr.stdout || '').slice(0, 1200),
          (vr.stderr || '').slice(0, 800),
        ]
          .filter(Boolean)
          .join('\n');
        if (verifyFailed) {
          failed = true;
          errors.push(`verify failed exit=${vr.exitCode}`);
        } else if (!vr.skipped) {
          verified = true;
        }
      } catch (err) {
        failed = true;
        errors.push(`verify: ${(err as Error).message}`);
        verifyBlock = `## Verify\n(error: ${(err as Error).message})`;
      }
    }
    if (failed) {
      rolledBack = true;
      verified = false;
      for (const f of edited) {
        const original = snapshots.get(f);
        if (original == null) continue;
        try {
          await params.writeFile(f, original);
          applyLog.push(`ROLLBACK ${f}`);
        } catch (err) {
          errors.push(`rollback ${f}: ${(err as Error).message}`);
        }
      }
    }
  }

  const ok = editsApplied > 0 && !rolledBack && errors.length === 0;
  const report = [
    `[Editor Subagent] task: ${params.task}`,
    `budget: maxFiles=${maxFiles} maxEdits=${maxEdits}`,
    `inspected: ${targetFiles.join(', ') || '(none)'}`,
    `applied: ${editsApplied} edit(s) across ${edited.size} file(s)`,
    rolledBack
      ? 'RESULT: ROLLED BACK (diagnostics/verify failed)'
      : ok
        ? verified
          ? 'RESULT: OK (verified)'
          : 'RESULT: OK'
        : 'RESULT: PARTIAL/FAIL',
    '',
    '## Apply log',
    ...applyLog.map((l) => `- ${l}`),
    diagLines.length ? `\n## Diagnostics\n${diagLines.join('\n\n')}` : '',
    verifyBlock,
    errors.length ? `\n## Errors\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);

  return {
    ok,
    role: 'editor',
    task: params.task,
    filesInspected: targetFiles,
    filesEdited: rolledBack ? [] : [...edited],
    editsApplied: rolledBack ? 0 : editsApplied,
    rolledBack,
    verified,
    report,
    errors,
  };
}
