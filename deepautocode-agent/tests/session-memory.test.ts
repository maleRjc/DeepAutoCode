import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendAgentMemory,
  digestTextToMemorySummary,
  formatAgentMemoryForPrompt,
  loadAgentMemory,
} from '../src/core/SessionMemory.js';

describe('SessionMemory', () => {
  it('appends and loads digests', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-mem-'));
    await appendAgentMemory(root, {
      source: 'compact',
      title: 'Compact note',
      summary: 'Fixed verify gate and MCP toggles.',
      sessionId: 'sess_1',
    });
    await appendAgentMemory(root, {
      source: 'checkpoint',
      title: 'CK',
      summary: 'Touched RuntimeFactory.ts',
    });
    const store = await loadAgentMemory(root);
    expect(store.entries.length).toBe(2);
    expect(store.entries[0].source).toBe('checkpoint');
    const prompt = formatAgentMemoryForPrompt(store, 2);
    expect(prompt).toContain('Cross-session Agent Memory');
    expect(prompt).toContain('MCP toggles');
  });

  it('digests free text', () => {
    expect(digestTextToMemorySummary('hello ```code``` world')).toContain('hello');
    expect(digestTextToMemorySummary('')).toBe('');
  });
});
