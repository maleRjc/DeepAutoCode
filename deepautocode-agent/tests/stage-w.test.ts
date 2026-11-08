import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBrowserAction } from '../src/core/AgentBrowser.js';
import { IgnoreMatcher, loadIgnoreRules, tokenizeSemantic } from '../src/core/index.js';
import { SemanticIndex } from '../src/core/SemanticIndex.js';
import {
  searchIndexedFiles,
  WorkspaceFileIndex,
} from '../src/core/WorkspaceFileIndex.js';
import { ensureAgentWorktree } from '../src/core/WorkspaceSafety.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('Stage W ignore rules', () => {
  it('honors .cursorignore patterns', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-ign-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'ok.ts'), 'export const ok = 1;\n');
    await fs.writeFile(path.join(root, 'secrets', 'key.ts'), 'export const key = "x";\n');
    await fs.writeFile(path.join(root, '.cursorignore'), 'secrets/\n*.pem\n');
    const rules = await loadIgnoreRules(root, { includeGitignore: false });
    const matcher = new IgnoreMatcher(rules.patterns);
    expect(matcher.ignores('secrets', true)).toBe(true);
    expect(matcher.ignores('secrets/key.ts', false)).toBe(true);
    expect(matcher.ignores('src/ok.ts', false)).toBe(false);

    const index = new WorkspaceFileIndex(root);
    const files = await index.ensureFresh(true);
    expect(files.map((f) => f.relPath)).toContain('src/ok.ts');
    expect(files.map((f) => f.relPath).some((r) => r.startsWith('secrets/'))).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('Stage W semantic index', () => {
  let root = '';
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-sem-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src', 'authService.ts'),
      'export function validateUserToken(token: string) {\n  return token.length > 0;\n}\n'
    );
    await fs.writeFile(
      path.join(root, 'src', 'uiTheme.ts'),
      'export const themeColors = { primary: "#09f" };\n'
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('tokenizes camelCase', () => {
    expect(tokenizeSemantic('validateUserToken')).toEqual(
      expect.arrayContaining(['validate', 'user', 'token'])
    );
  });

  it('ranks auth-related files for NL query', async () => {
    const index = new WorkspaceFileIndex(root);
    const sem = new SemanticIndex(index);
    const hits = await sem.search('validate user authentication token', { limit: 5 });
    expect(hits[0]?.relPath).toContain('authService');
  });

  it('searchIndexedFiles mode=semantic returns tf-idf block', async () => {
    const index = new WorkspaceFileIndex(root);
    const out = await searchIndexedFiles({
      root,
      index,
      query: 'user token validation',
      mode: 'semantic',
    });
    expect(out).toMatch(/semantic\/tf-idf/i);
    expect(out).toContain('authService');
  });
});

describe('Stage W browser HTTP snapshot', () => {
  it('returns structured snapshot without CDP', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><head><title>Demo</title></head><body><h1>Hello</h1><button>Go</button><a href="/x">Link</a></body></html>'
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await runBrowserAction({
        action: 'snapshot',
        url: `http://127.0.0.1:${port}/`,
      });
      expect(res.ok).toBe(true);
      expect(res.mode).toBe('http');
      expect(res.pageTitle).toBe('Demo');
      expect(Array.isArray(res.accessibilityTree)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});

describe('Stage W worktree', () => {
  it('creates a git worktree under .deepautocode/worktrees', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-wt-'));
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await fs.writeFile(path.join(root, 'README.md'), 'hi\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });

    const wt = await ensureAgentWorktree({ workspaceRoot: root, sessionId: 'sess_demo_1' });
    expect(wt.enabled).toBe(true);
    expect(wt.worktreePath).toBeTruthy();
    const st = await fs.stat(wt.worktreePath!);
    expect(st.isDirectory()).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});
