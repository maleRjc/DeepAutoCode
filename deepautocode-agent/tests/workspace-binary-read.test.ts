import { describe, expect, it } from 'vitest';
import {
  buildBlockedBinaryReadMessage,
  isBlockedBinaryReadPath,
} from '../src/core/WorkspaceBinaryRead.js';
import { resolveLlmPostTimeoutMs } from '../src/core/DeepSeekModels.js';

describe('WorkspaceBinaryRead', () => {
  it('blocks PDF read_file paths', () => {
    expect(isBlockedBinaryReadPath('docs/tutorials/foo.pdf')).toBe(true);
    expect(buildBlockedBinaryReadMessage('docs/tutorials/foo.pdf')).toContain('BINARY_READ_BLOCKED');
    expect(buildBlockedBinaryReadMessage('docs/tutorials/foo.pdf')).toContain('foo.md');
  });

  it('allows markdown', () => {
    expect(isBlockedBinaryReadPath('docs/tutorials/foo.md')).toBe(false);
  });
});

describe('resolveLlmPostTimeoutMs', () => {
  it('gives GLM longer budget, extra on SSH mirror', () => {
    expect(
      resolveLlmPostTimeoutMs({ isReasonerModel: false, isGlmModel: true, isLocalInference: false })
    ).toBe(300_000);
    expect(
      resolveLlmPostTimeoutMs({
        isReasonerModel: false,
        isGlmModel: true,
        isLocalInference: false,
        isSshMirrorWorkspace: true,
      })
    ).toBe(360_000);
  });
});
