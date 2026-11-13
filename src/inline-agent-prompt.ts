/**
 * Ctrl+I / CodeLens → same Agent tool chain as Composer.
 * Builds a structured prompt with file range + selection + tool instructions.
 */

export type InlineAgentMode = 'plan' | 'auto';

export interface InlineAgentPromptInput {
  instruction: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
  /** When true, treat as read-only even if instruction looks like an edit. */
  forceExplain?: boolean;
}

export interface InlineAgentPromptResult {
  prompt: string;
  mode: InlineAgentMode;
  isExplain: boolean;
  filePath: string;
  startLine: number;
  endLine: number;
}

const MAX_SELECTION_CHARS = 2400;

export function isInlineExplainInstruction(instruction: string): boolean {
  return /^(?:explain|what|why|analyze|解释|说明|分析|是什么|干什么)/i.test(
    String(instruction || '').trim()
  );
}

export function offsetToLineCol(
  content: string,
  offset: number
): { line: number; col: number } {
  const safe = Math.max(0, Math.min(offset, content.length));
  const upto = content.slice(0, safe);
  const lines = upto.split('\n');
  return {
    line: lines.length,
    col: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}

export function selectionFromOffsets(
  content: string,
  selectionStart: number,
  selectionEnd: number
): { startLine: number; endLine: number; text: string; hasSelection: boolean } {
  const a = Math.max(0, Math.min(selectionStart, selectionEnd));
  const b = Math.max(0, Math.max(selectionStart, selectionEnd));
  const start = offsetToLineCol(content, a);
  const end = offsetToLineCol(content, Math.max(a, b - (b > a ? 1 : 0)));
  const text = content.slice(a, b);
  return {
    startLine: start.line,
    endLine: Math.max(start.line, end.line),
    text,
    hasSelection: b > a,
  };
}

/**
 * Build the prompt that Composer/session.send already routes into RuntimeFactory tools.
 */
export function buildInlineAgentPrompt(input: InlineAgentPromptInput): InlineAgentPromptResult {
  const instruction = String(input.instruction || '').trim();
  const filePath = String(input.filePath || '').replace(/\\/g, '/').trim();
  const startLine = Math.max(1, Number(input.startLine) || 1);
  const endLine = Math.max(startLine, Number(input.endLine) || startLine);
  const isExplain = Boolean(input.forceExplain) || isInlineExplainInstruction(instruction);
  const mode: InlineAgentMode = isExplain ? 'plan' : 'auto';

  const selectedRaw = String(input.selectedText || '');
  const selected =
    selectedRaw.length > MAX_SELECTION_CHARS
      ? `${selectedRaw.slice(0, MAX_SELECTION_CHARS)}\n…[truncated]`
      : selectedRaw;

  const rangeLabel =
    startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;

  const header = isExplain
    ? `[INLINE_QUERY] [READ_ONLY_ANALYSIS]`
    : `[INLINE_EDIT] [FORCE_AUTO_ACTION]`;

  const targetBlock = filePath
    ? [
        `Target file: ${filePath}`,
        `Target range: ${rangeLabel}`,
        selected
          ? `Selected snippet:\n\`\`\`\n${selected}\n\`\`\``
          : `No text selection — focus on the enclosing function/block around ${rangeLabel}.`,
      ].join('\n')
    : `No active file — resolve the relevant workspace files via search_codebase first.`;

  const toolChain = isExplain
    ? [
        `Use the same Agent tool chain as Composer (read-only):`,
        `1. Call read_file on the target with start_line/end_line covering ${rangeLabel} (expand to the full enclosing function if needed).`,
        `2. Use outline_file / search_codebase when symbols or callers are unclear.`,
        `3. Answer with concise analysis and clickable file:line references.`,
        `Do NOT modify files, and do NOT ask the user to paste code.`,
      ].join('\n')
    : [
        `Use the same Agent tool chain as Composer:`,
        `1. Call read_file on the target with start_line/end_line covering ${rangeLabel} (expand to the full enclosing function before editing).`,
        `2. Use search_codebase if signatures/callers are unclear — never guess member names.`,
        `3. Apply the change via editor / edit_file (str_replace preferred).`,
        `4. If source was modified, run the workspace verify/build gate (run_commands / auto_build_and_test).`,
        `Do NOT ask the user to paste or manually apply code; operate via tools.`,
      ].join('\n');

  const prompt = [
    header,
    filePath
      ? `Inline Command on ${filePath} (${rangeLabel}): ${instruction}`
      : `Inline Command: ${instruction}`,
    '',
    targetBlock,
    '',
    toolChain,
  ].join('\n');

  return {
    prompt,
    mode,
    isExplain,
    filePath,
    startLine,
    endLine,
  };
}
