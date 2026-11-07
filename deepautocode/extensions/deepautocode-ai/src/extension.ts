import path from 'node:path';
import {
  AgentClientBridge,
  type SecretStorageAdapter,
} from '@deepautocode/agent';
import { buildWebviewCspHeader, generateCspNonce } from '../../../src/csp.js';

/**
 * Minimal ambient interface for Code - OSS (`vscode`) Extension Host API
 * Enables compilation and testing both inside Code - OSS Extension Host and in standalone Node tests.
 */
export interface VsCodeApiLike {
  Uri: {
    file(fsPath: string): { fsPath: string; toString(): string };
    parse(value: string): { fsPath: string; toString(): string };
  };
  workspace: {
    workspaceFolders?: Array<{ uri: { fsPath: string } }>;
    openTextDocument(uri: { fsPath: string }): Promise<{ isDirty?: boolean }>;
    fs: {
      readFile(uri: { fsPath: string }): Promise<Uint8Array>;
      writeFile(uri: { fsPath: string }, content: Uint8Array): Promise<void>;
    };
  };
  window: {
    showTextDocument(
      doc: unknown,
      options?: { preview?: boolean; selection?: unknown }
    ): Promise<unknown>;
    createTerminal(options: { name: string; cwd?: string }): {
      show(): void;
      sendText(text: string, addNewLine?: boolean): void;
      dispose(): void;
    };
    registerWebviewViewProvider(
      viewId: string,
      provider: {
        resolveWebviewView(webviewView: {
          webview: {
            options: Record<string, unknown>;
            cspSource: string;
            html: string;
            postMessage(message: unknown): Promise<boolean>;
            onDidReceiveMessage(listener: (msg: unknown) => void): { dispose(): void };
          };
          onDidDispose(listener: () => void): { dispose(): void };
        }): void | Promise<void>;
      }
    ): { dispose(): void };
  };
  commands: {
    executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): void };
  };
}

export interface VsCodeExtensionContextLike {
  globalStorageUri: { fsPath: string };
  extensionUri: { fsPath: string };
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  subscriptions: Array<{ dispose(): unknown }>;
}

/**
 * Section 7.2 & 9.1: Adapter binding Code - OSS `ExtensionContext.secrets` (OS Keychain / Credential Manager)
 * to `@deepautocode/agent` `SecretStorageAdapter`.
 */
export class VsCodeSecretStorageAdapter implements SecretStorageAdapter {
  constructor(private readonly secrets: VsCodeExtensionContextLike['secrets']) {}

  async getSecret(keyRef: string): Promise<string | undefined> {
    return this.secrets.get(keyRef);
  }

  async setSecret(keyRef: string, secretValue: string): Promise<void> {
    await this.secrets.store(keyRef, secretValue);
  }

  async deleteSecret(keyRef: string): Promise<void> {
    await this.secrets.delete(keyRef);
  }
}

/**
 * Appendix B: Bind real Code - OSS Extension Host APIs to `CapabilityRegistry`
 */
export function bindCodeOssHostCapabilities(
  bridge: AgentClientBridge,
  vscode: VsCodeApiLike
): void {
  // 1. open-file -> workspace.openTextDocument + window.showTextDocument
  bridge.capabilityRegistry.registerExecutor<any, any>('open-file', async (input, ctx) => {
    const targetPath = ctx.canonicalPath!;
    const uri = vscode.Uri.file(targetPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: input.preview });
    return {
      opened: true,
      canonicalPath: targetPath,
      unsavedChanges: Boolean(doc.isDirty),
    };
  });

  // 2. reveal-diff -> vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title)
  bridge.capabilityRegistry.registerExecutor<any, any>('reveal-diff', async (input, ctx) => {
    const targetPath = ctx.canonicalPath!;
    const leftUri = vscode.Uri.file(targetPath);
    const rightUri = vscode.Uri.file(targetPath);
    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      input.title ?? `DeepAutoCode Diff: ${path.basename(targetPath)}`
    );
    return {
      revealed: true,
      diffId: input.diffId,
      canonicalPath: targetPath,
    };
  });

  // 3. read-file -> vscode.workspace.fs.readFile
  bridge.capabilityRegistry.registerExecutor<any, any>('read-file', async (input, ctx) => {
    const targetPath = ctx.canonicalPath!;
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(targetPath));
    const buf = Buffer.from(bytes);
    const truncated = buf.byteLength > input.maxBytes;
    const slice = truncated ? buf.subarray(0, input.maxBytes) : buf;
    return {
      canonicalPath: targetPath,
      content: input.encoding === 'base64' ? slice.toString('base64') : slice.toString('utf-8'),
      byteLength: buf.byteLength,
      truncated,
    };
  });

  // 4. write-file -> vscode.workspace.fs.writeFile
  bridge.capabilityRegistry.registerExecutor<any, any>('write-file', async (input, ctx) => {
    const targetPath = ctx.canonicalPath!;
    const buf = Buffer.from(input.content, 'utf-8');
    await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), buf);
    return {
      canonicalPath: targetPath,
      bytesWritten: buf.byteLength,
      operation: 'modify' as const,
    };
  });

  // 5. run-build -> vscode.window.createTerminal
  bridge.capabilityRegistry.registerExecutor<any, any>('run-build', async (input, ctx) => {
    const start = Date.now();
    const cwd = ctx.canonicalPath ?? ctx.workspaceRoot;
    const terminal = vscode.window.createTerminal({
      name: 'DeepAutoCode Build Task',
      cwd,
    });
    terminal.show();
    terminal.sendText(input.command, true);
    return {
      exitCode: 0,
      stdout: `Dispatched to Code - OSS Terminal in ${cwd}: ${input.command}`,
      stderr: '',
      durationMs: Date.now() - start,
    };
  });
}

/**
 * Code - OSS Extension Host Entry Point (`activate`)
 */
export async function activateDeepAutoCodeExtension(
  context: VsCodeExtensionContextLike,
  vscode: VsCodeApiLike
): Promise<{ bridge: AgentClientBridge; deactivate: () => Promise<void> }> {
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const storageDir = path.join(context.globalStorageUri.fsPath, 'agent-runtime');

  const bridge = await AgentClientBridge.create({
    storageDir,
    workspaceRoot,
    initialBackendMode: 'local',
    secretStorage: new VsCodeSecretStorageAdapter(context.secrets),
  });

  bindCodeOssHostCapabilities(bridge, vscode);

  const viewProvider = vscode.window.registerWebviewViewProvider('deepautocode.aiPanel', {
    async resolveWebviewView(webviewView) {
      const nonce = generateCspNonce();
      const csp = buildWebviewCspHeader({
        cspSource: webviewView.webview.cspSource,
        nonce,
      });

      webviewView.webview.options = {
        enableScripts: true,
      };

      webviewView.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DeepAutoCode AI</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="./webview/index.js"></script>
</body>
</html>`;

      // Attach Webview to EventBridge (automatically replaces old subscription on reopen)
      const detach = bridge.attachWebview('code-oss-sidebar-webview', (event) => {
        void webviewView.webview.postMessage(event);
      });

      const msgDisposable = webviewView.webview.onDidReceiveMessage(async (rawMsg) => {
        const response = await bridge.handleWebviewMessage(rawMsg);
        await webviewView.webview.postMessage(response);
      });

      webviewView.onDidDispose(() => {
        msgDisposable.dispose();
        void detach();
      });
    },
  });

  context.subscriptions.push(viewProvider);

  return {
    bridge,
    deactivate: async () => {
      await bridge.dispose();
    },
  };
}
