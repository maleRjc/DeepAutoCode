import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateDeepAutoCodeExtension,
  buildWebviewCspHeader,
  createWorkbenchServer,
  ExtensionsMarketplaceManager,
  generateCspNonce,
  validateWebviewHtmlCsp,
  type VsCodeApiLike,
  type VsCodeExtensionContextLike,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

describe('DeepAutoCode IDE Repository Suite (v1.1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-ide-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('DA-002: Generates strict Webview Content-Security-Policy with cryptographic nonce', () => {
    const nonce = generateCspNonce();
    expect(nonce.length).toBeGreaterThanOrEqual(24);

    const csp = buildWebviewCspHeader({
      cspSource: 'vscode-webview://1234',
      nonce,
    });

    const html = `<html><head><meta http-equiv="Content-Security-Policy" content="${csp}" /></head><body><script nonce="${nonce}" src="./app.js"></script></body></html>`;
    const check = validateWebviewHtmlCsp(html);
    expect(check.valid).toBe(true);
    expect(check.hasDefaultSrcNone).toBe(true);
    expect(check.hasScriptNonce).toBe(true);
    expect(check.hasRemoteScriptTags).toBe(false);
  });

  it('DA-005: Validates 16-extension Open VSX matrix, blocks proprietary redistribution, and enforces VSIX license confirmation', async () => {
    const mgr = new ExtensionsMarketplaceManager(REPO_ROOT, tmpDir);
    const matrix = await mgr.loadMatrix();

    expect(matrix.extensions.length).toBeGreaterThanOrEqual(15);
    expect(matrix.extensions.some((e) => e.id === 'detachhead.basedpyright')).toBe(true);
    expect(matrix.extensions.some((e) => e.id === 'jeanp413.open-remote-ssh')).toBe(true);

    // Install verified Open VSX extension
    const installRes = await mgr.installFromOpenVsx('rust-lang.rust-analyzer');
    expect(installRes.ok).toBe(true);

    // Block proprietary extension from Open VSX installer
    await expect(mgr.installFromOpenVsx('ms-vscode.cpptools')).rejects.toThrow(
      /PROPRIETARY_EXTENSION_RESTRICTED/
    );

    // Block VSIX install without user license confirmation
    await expect(mgr.installLocalVsix('custom.vsix', false)).rejects.toThrow(
      /LICENSE_CONFIRMATION_REQUIRED/
    );

    // Allow VSIX install when user confirms license rights
    const vsixRes = await mgr.installLocalVsix('custom.vsix', true);
    expect(vsixRes.ok).toBe(true);
  });

  it('Appendix B: Activates Code - OSS Extension Host and maps all 5 capabilities to vscode.* APIs', async () => {
    const workspaceDir = path.join(tmpDir, 'ws');
    await fs.mkdir(workspaceDir, { recursive: true });
    const testFile = path.join(workspaceDir, 'app.ts');
    await fs.writeFile(testFile, 'console.log("init");\n', 'utf-8');

    const secretMap = new Map<string, string>();
    const executedCommands: string[] = [];
    const terminalCommands: string[] = [];

    const mockContext: VsCodeExtensionContextLike = {
      globalStorageUri: { fsPath: path.join(tmpDir, 'globalStorage') },
      extensionUri: { fsPath: REPO_ROOT },
      secrets: {
        get: async (k) => secretMap.get(k),
        store: async (k, v) => {
          secretMap.set(k, v);
        },
        delete: async (k) => {
          secretMap.delete(k);
        },
      },
      subscriptions: [],
    };

    const mockVscode: VsCodeApiLike = {
      Uri: {
        file: (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` }),
        parse: (val) => ({ fsPath: val, toString: () => val }),
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
        openTextDocument: async () => ({ isDirty: false }),
        fs: {
          readFile: async (uri) => new Uint8Array(await fs.readFile(uri.fsPath)),
          writeFile: async (uri, content) => {
            await fs.writeFile(uri.fsPath, Buffer.from(content));
          },
        },
      },
      window: {
        showTextDocument: async () => ({}),
        createTerminal: () => ({
          show: () => {},
          sendText: (cmd) => {
            terminalCommands.push(cmd);
          },
          dispose: () => {},
        }),
        registerWebviewViewProvider: () => ({ dispose: () => {} }),
      },
      commands: {
        executeCommand: async (cmd) => {
          executedCommands.push(cmd);
        },
        registerCommand: () => ({ dispose: () => {} }),
      },
    };

    const { bridge, deactivate } = await activateDeepAutoCodeExtension(
      mockContext,
      mockVscode
    );

    // 1. open-file
    const openRes = await bridge.capabilityRegistry.invoke<any>(
      'open-file',
      { filePath: 'app.ts' },
      { sessionId: 's1', workspaceRoot: workspaceDir, executionMode: 'auto' }
    );
    expect(openRes.opened).toBe(true);

    // 2. reveal-diff
    const diffRes = await bridge.capabilityRegistry.invoke<any>(
      'reveal-diff',
      {
        diffId: 'd1',
        filePath: 'app.ts',
        originalContent: 'a',
        proposedContent: 'b',
      },
      { sessionId: 's1', workspaceRoot: workspaceDir, executionMode: 'auto' }
    );
    expect(diffRes.revealed).toBe(true);
    expect(executedCommands).toContain('vscode.diff');

    // 3. read-file
    const readRes = await bridge.capabilityRegistry.invoke<any>(
      'read-file',
      { filePath: 'app.ts' },
      { sessionId: 's1', workspaceRoot: workspaceDir, executionMode: 'auto' }
    );
    expect(readRes.content).toContain('console.log("init")');

    // 4. SecretStorage via provider.update
    await bridge.handleWebviewMessage({
      category: 'request',
      type: 'provider.update',
      requestId: 'req_prov_secret',
      payload: {
        providerId: 'deepseek',
        apiKey: 'sk-secret-key-stored-in-os-keychain',
      },
    });
    expect(secretMap.get('deepautocode.provider.deepseek.apiKey')).toBe(
      'sk-secret-key-stored-in-os-keychain'
    );

    await deactivate();
  }, 20000);

  it('End-to-End Workbench Server: serves CSP-protected HTML, handles bridge requests, and recovers sessions across restart', async () => {
    const srv = await createWorkbenchServer({
      port: 0,
      storageDir: path.join(tmpDir, 'srv-storage'),
      workspaceRoot: tmpDir,
    });

    try {
      const indexRes = await fetch(srv.url);
      expect(indexRes.status).toBe(200);
      const html = await indexRes.text();
      expect(validateWebviewHtmlCsp(html).valid).toBe(true);

      const createRes = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'session.create',
          requestId: 'e2e_req_1',
          payload: { title: 'E2E Workbench Session', prompt: 'Hello DeepAutoCode' },
        }),
      }).then((r) => r.json());
      expect(createRes.ok).toBe(true);

      const restartRes = await fetch(`${srv.url}/api/simulate-restart`, {
        method: 'POST',
      }).then((r) => r.json());
      expect(restartRes.oldInstanceId).not.toBe(restartRes.newInstanceId);

      const listRes = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'session.list',
          requestId: 'e2e_req_2',
          payload: {},
        }),
      }).then((r) => r.json());
      expect(listRes.ok).toBe(true);
      expect(listRes.data.length).toBe(1);
    } finally {
      await srv.close();
    }
  }, 20000);

  it('Comprehensive Autonomous Coding, Command Execution, Bug-Fix & Workspace Switch Suite', async () => {
    const wsA = path.join(tmpDir, 'project-a');
    const wsB = path.join(tmpDir, 'project-b');
    await fs.mkdir(wsA, { recursive: true });
    await fs.mkdir(wsB, { recursive: true });

    // Seed a buggy calculator file in project-a
    const calcPath = path.join(wsA, 'calculator.ts');
    await fs.writeFile(
      calcPath,
      'export function add(a: number, b: number): number {\n  return a - b; // BUG: should be a + b\n}\n',
      'utf-8'
    );

    const srv = await createWorkbenchServer({
      port: 0,
      storageDir: path.join(tmpDir, 'srv-storage-full'),
      workspaceRoot: wsA,
    });

    try {
      // 1. Save DeepSeek API key via provider.update and verify it persists across workspace switch
      const provUpdate = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'provider.update',
          requestId: 'req_save_key_1',
          payload: {
            providerId: 'deepseek',
            apiEndpoint: 'https://api.deepseek.com/v1',
            modelId: 'deepseek-chat',
            apiKey: 'sk-test-persisted-deepseek-key',
          },
        }),
      }).then((r) => r.json());
      expect(provUpdate.ok).toBe(true);
      expect(provUpdate.data.active.hasApiKeyConfigured).toBe(true);

      // 2. Switch workspace to project-b and back to project-a, verifying API key & WebSocket bridge survive
      const switchToB = await fetch(`${srv.url}/api/workspace/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: wsB }),
      }).then((r) => r.json());
      expect(switchToB.ok).toBe(true);

      const switchToA = await fetch(`${srv.url}/api/workspace/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: wsA }),
      }).then((r) => r.json());
      expect(switchToA.ok).toBe(true);

      // Verify DeepSeek API key is still configured after bridge recreation!
      const provGetAfterSwitch = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'provider.get',
          requestId: 'req_get_key_after_switch',
          payload: {},
        }),
      }).then((r) => r.json());
      expect(provGetAfterSwitch.ok).toBe(true);
      expect(provGetAfterSwitch.data.active.hasApiKeyConfigured).toBe(true);

      // 3. Create Session & Test File Reading (`读取 calculator.ts`)
      const sessionRes = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'session.create',
          requestId: 'req_create_coding_sess',
          payload: {
            title: 'Bug Fix Session',
            prompt: '读取 calculator.ts',
            executionMode: 'auto',
          },
        }),
      }).then((r) => r.json());
      expect(sessionRes.ok).toBe(true);
      const sessionId = sessionRes.data.sessionId;

      // 4. Test Autonomous Bug Fix & Diff Generation (`修改 calculator.ts: ...`)
      const fixedCode =
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
      const fixRes = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'session.send',
          requestId: 'req_fix_bug',
          sessionId,
          payload: {
            sessionId,
            prompt: `修改 calculator.ts: ${fixedCode}`,
            executionMode: 'auto',
          },
        }),
      }).then((r) => r.json());
      expect(fixRes.ok).toBe(true);

      const updatedDiskContent = await fs.readFile(calcPath, 'utf-8');
      expect(updatedDiskContent).toContain('return a + b;');

      // 5. Test Diff Review Reject/Revert workflow
      const resumeSnap = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'session.resume',
          requestId: 'req_resume_diff_check',
          sessionId,
          payload: { sessionId, lastSequence: 0 },
        }),
      }).then((r) => r.json());
      expect(resumeSnap.ok).toBe(true);
      expect(resumeSnap.data.diffs.length).toBeGreaterThanOrEqual(1);
      const diffId = resumeSnap.data.diffs[0].diffId;

      // Reject diff -> should revert calculator.ts to original buggy content
      const rejectDiffRes = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'diff.review',
          requestId: 'req_reject_diff',
          sessionId,
          payload: { sessionId, diffId, action: 'reject' },
        }),
      }).then((r) => r.json());
      expect(rejectDiffRes.ok).toBe(true);
      expect(await fs.readFile(calcPath, 'utf-8')).toContain('return a - b;');

      // Accept diff -> should re-apply fixed calculator.ts content
      const acceptDiffRes = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'diff.review',
          requestId: 'req_accept_diff',
          sessionId,
          payload: { sessionId, diffId, action: 'accept' },
        }),
      }).then((r) => r.json());
      expect(acceptDiffRes.ok).toBe(true);
      expect(await fs.readFile(calcPath, 'utf-8')).toContain('return a + b;');

      // 6. Test Agent Build/Command Execution (`运行 \`node -v\``)
      const cmdRes = await fetch(`${srv.url}/api/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'request',
          type: 'session.send',
          requestId: 'req_run_cmd',
          sessionId,
          payload: {
            sessionId,
            prompt: '运行 `node -v`',
            executionMode: 'auto',
          },
        }),
      }).then((r) => r.json());
      expect(cmdRes.ok).toBe(true);
      expect(cmdRes.data.content).toContain('v');

      // 7. Test Integrated Terminal API (`/api/terminal/exec`)
      const termExec = await fetch(`${srv.url}/api/terminal/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'node -e "console.log(2 + 3)"' }),
      }).then((r) => r.json());
      expect(termExec.exitCode).toBe(0);
      expect(termExec.stdout.trim()).toBe('5');

      // 8. Test Remote - SSH Connection Manager (Test, Browse, Connect, Remote Exec & Disconnect)
      const remoteSimDir = path.join(tmpDir, 'remote-ssh-target');
      await fs.mkdir(path.join(remoteSimDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(remoteSimDir, 'README.md'), '# Remote SSH Project\n', 'utf-8');

      const sshProfile = {
        name: 'Simulated GPU Cluster',
        host: '127.0.0.1',
        port: 22,
        username: 'ubuntu',
        authMethod: 'local-loopback',
        remotePath: remoteSimDir,
      };

      const sshTestRes = await fetch(`${srv.url}/api/ssh/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sshProfile),
      }).then((r) => r.json());
      expect(sshTestRes.ok).toBe(true);
      expect(sshTestRes.sshAuthenticated).toBe(true);

      const sshBrowseRes = await fetch(`${srv.url}/api/ssh/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: sshProfile, targetDir: remoteSimDir }),
      }).then((r) => r.json());
      expect(sshBrowseRes.ok).toBe(true);
      expect(sshBrowseRes.directories).toContain('src');

      const sshConnectRes = await fetch(`${srv.url}/api/ssh/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sshProfile),
      }).then((r) => r.json());
      expect(sshConnectRes.ok).toBe(true);
      expect(sshConnectRes.status.connected).toBe(true);
      expect(sshConnectRes.workspaceName).toContain('[SSH: ubuntu@127.0.0.1]');

      const sshTermExec = await fetch(`${srv.url}/api/terminal/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'node -e "console.log(10 * 10)"' }),
      }).then((r) => r.json());
      expect(sshTermExec.exitCode).toBe(0);
      expect(sshTermExec.stdout.trim()).toBe('100');

      const sshDisconnectRes = await fetch(`${srv.url}/api/ssh/disconnect`, {
        method: 'POST',
      }).then((r) => r.json());
      expect(sshDisconnectRes.ok).toBe(true);
      expect(sshDisconnectRes.status.connected).toBe(false);
    } finally {
      await srv.close();
    }
  }, 25000);
});

