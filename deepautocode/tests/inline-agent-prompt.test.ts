import { describe, expect, it } from 'vitest';
import {
  buildInlineAgentPrompt,
  isInlineExplainInstruction,
  offsetToLineCol,
  selectionFromOffsets,
} from '../src/inline-agent-prompt.js';

describe('inline-agent-prompt (Ctrl+I → Agent tool chain)', () => {
  it('detects explain vs edit instructions', () => {
    expect(isInlineExplainInstruction('Explain this function')).toBe(true);
    expect(isInlineExplainInstruction('解释这段逻辑')).toBe(true);
    expect(isInlineExplainInstruction('Refactor for clarity')).toBe(false);
  });

  it('maps offsets to line/col and selection ranges', () => {
    const content = 'aaa\nbbb\nccc\n';
    expect(offsetToLineCol(content, 0)).toEqual({ line: 1, col: 1 });
    expect(offsetToLineCol(content, 4)).toEqual({ line: 2, col: 1 });
    const sel = selectionFromOffsets(content, 4, 7);
    expect(sel.hasSelection).toBe(true);
    expect(sel.startLine).toBe(2);
    expect(sel.endLine).toBe(2);
    expect(sel.text).toBe('bbb');
  });

  it('builds INLINE_EDIT prompt with tool-chain instructions', () => {
    const result = buildInlineAgentPrompt({
      instruction: 'Rename foo to bar',
      filePath: 'src\\alpha.ts',
      startLine: 10,
      endLine: 18,
      selectedText: 'function foo() {}',
    });
    expect(result.mode).toBe('auto');
    expect(result.prompt).toContain('[INLINE_EDIT]');
    expect(result.prompt).toContain('[FORCE_AUTO_ACTION]');
    expect(result.prompt).toContain('Target file: src/alpha.ts');
    expect(result.prompt).toContain('L10-L18');
    expect(result.prompt).toContain('function foo() {}');
    expect(result.prompt).toContain('editor / edit_file');
    expect(result.prompt).toContain('verify/build');
  });

  it('builds INLINE_QUERY prompt for explain', () => {
    const result = buildInlineAgentPrompt({
      instruction: 'Explain invariants',
      filePath: 'src/beta.ts',
      startLine: 5,
      endLine: 5,
    });
    expect(result.mode).toBe('plan');
    expect(result.prompt).toContain('[INLINE_QUERY]');
    expect(result.prompt).toContain('[READ_ONLY_ANALYSIS]');
    expect(result.prompt).toContain('Do NOT modify files');
  });
});
