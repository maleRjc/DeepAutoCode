import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodeModeEngine } from '../src/core/CodeModeEngine.js';
import {
  PersistentPtyManager,
  PersistentTerminalSession,
} from '../src/core/PersistentPtyManager.js';

describe('CodeModeEngine & PersistentPTY', () => {
  let tmpDir: string;
  let ptyManager: PersistentPtyManager;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-codemode-test-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'src', 'index.ts'),
      'export const version = "1.0.0";\nexport function hello() { return "world"; }\n',
      'utf-8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'src', 'utils.ts'),
      'export const add = (a: number, b: number) => a + b;\n',
      'utf-8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'README.md'),
      '# Test Project\nDeepAutoCode CodeMode sandbox.\n',
      'utf-8'
    );

    ptyManager = new PersistentPtyManager();
  });

  afterAll(async () => {
    ptyManager.closeAll();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('CodeModeEngine', () => {
    it('executes sandboxed JS and returns calculated value', async () => {
      const engine = new CodeModeEngine(tmpDir);
      const res = await engine.execute(`
        const a = 10;
        const b = 25;
        return a + b;
      `);
      expect(res.ok).toBe(true);
      expect(res.value).toBe(35);
    });

    it('supports dac.glob and dac.readFile', async () => {
      const engine = new CodeModeEngine(tmpDir);
      const res = await engine.execute(`
        const files = await dac.glob("src/*.ts");
        const content = await dac.readFile("src/index.ts");
        return { count: files.length, hasHello: content.includes("hello") };
      `);
      expect(res.ok).toBe(true);
      const val = res.value as { count: number; hasHello: boolean };
      expect(val.count).toBe(2);
      expect(val.hasHello).toBe(true);
    });

    it('supports dac.grep across workspace files', async () => {
      const engine = new CodeModeEngine(tmpDir);
      const res = await engine.execute(`
        const matches = await dac.grep(/export function/);
        return matches;
      `);
      expect(res.ok).toBe(true);
      const matches = res.value as Array<{ file: string; line: number; text: string }>;
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0].text).toContain('hello');
    });

    it('strips markdown code blocks automatically', async () => {
      const engine = new CodeModeEngine(tmpDir);
      const res = await engine.execute(`\`\`\`javascript
        return 42 * 2;
      \`\`\``);
      expect(res.ok).toBe(true);
      expect(res.value).toBe(84);
    });

    it('captures syntax errors gracefully', async () => {
      const engine = new CodeModeEngine(tmpDir);
      const res = await engine.execute(`
        return def not valid js syntax;
      `);
      expect(res.ok).toBe(false);
      expect(res.error).toBeDefined();
    });
  });

  describe('PersistentPtyManager', () => {
    it('creates a session and runs commands with exit code', async () => {
      const session = ptyManager.getOrCreateTerminal({ cwd: tmpDir });
      expect(session).toBeInstanceOf(PersistentTerminalSession);

      const res = await session.execute('echo "PTY_TEST_OK"');
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain('PTY_TEST_OK');
    });

    it('persists environment variables across turns', async () => {
      const session = ptyManager.getOrCreateTerminal({ cwd: tmpDir });
      const isWin = os.platform() === 'win32';

      if (isWin) {
        await session.execute('$env:MY_DAC_VAR = "ACTIVE_42"');
        const check = await session.execute('Write-Output $env:MY_DAC_VAR');
        expect(check.exitCode).toBe(0);
        expect(check.output).toContain('ACTIVE_42');
      } else {
        await session.execute('export MY_DAC_VAR="ACTIVE_42"');
        const check = await session.execute('echo $MY_DAC_VAR');
        expect(check.exitCode).toBe(0);
        expect(check.output).toContain('ACTIVE_42');
      }
    });

    it('persists working directory changes (cd) across turns', async () => {
      const session = ptyManager.getOrCreateTerminal({ cwd: tmpDir });
      const isWin = os.platform() === 'win32';

      await session.execute('cd src');
      const pwdRes = await session.execute(isWin ? '(Get-Location).Path' : 'pwd');
      expect(pwdRes.exitCode).toBe(0);
      expect(pwdRes.output.replace(/\\/g, '/')).toContain('src');
    });
  });
});
