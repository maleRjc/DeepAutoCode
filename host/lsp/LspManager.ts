import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export interface LspLocation {
  file: string;
  line: number;
  character?: number;
}

export interface LspDiagnostic {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

export interface LspStatus {
  typescript: { ready: boolean; mode: 'language-service' };
  clangd: { ready: boolean; mode: 'stdio' | 'unavailable'; reason?: string };
}

/**
 * Real language intelligence without a full VS Code Extension Host:
 * - TypeScript/JavaScript: in-process TypeScript Language Service
 * - C/C++: optional clangd over stdio JSON-RPC when `clangd` is on PATH (lazy start)
 */
export class LspManager {
  private workspaceRoot = '';
  private tsService: ts.LanguageService | null = null;
  private scriptVersions = new Map<string, string>();
  private scriptSnapshots = new Map<string, ts.IScriptSnapshot>();
  private clangd: ChildProcessWithoutNullStreams | null = null;
  private clangdBuf = '';
  private clangdNextId = 1;
  private clangdPending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private clangdReady = false;
  private clangdStarting: Promise<void> | null = null;
  private clangdReason = 'not started';
  private clangdDiagnostics = new Map<string, LspDiagnostic[]>();

  async setWorkspace(root: string): Promise<void> {
    const next = normalizeFsPath(root || '');
    if (next === this.workspaceRoot) return;
    await this.dispose();
    this.workspaceRoot = next;
    if (this.workspaceRoot) {
      this.initTypeScriptService();
    }
  }

  getStatus(): LspStatus {
    return {
      typescript: { ready: Boolean(this.tsService), mode: 'language-service' },
      clangd: {
        ready: this.clangdReady,
        mode: this.clangdReady ? 'stdio' : 'unavailable',
        reason: this.clangdReady ? undefined : this.clangdReason,
      },
    };
  }

  private initTypeScriptService(): void {
    if (!this.workspaceRoot) return;
    const root = this.workspaceRoot;
    const versions = this.scriptVersions;
    const snapshots = this.scriptSnapshots;

    const defaultCompilerOptions: ts.CompilerOptions = {
      allowJs: true,
      checkJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    };
    let resolvedCompilerOptions: ts.CompilerOptions = defaultCompilerOptions;
    try {
      const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
      if (configPath) {
        const readRes = ts.readConfigFile(configPath, ts.sys.readFile);
        if (!readRes.error && readRes.config) {
          const parsed = ts.parseJsonConfigFileContent(
            readRes.config,
            ts.sys,
            path.dirname(configPath)
          );
          resolvedCompilerOptions = {
            ...defaultCompilerOptions,
            ...parsed.options,
            allowJs: true,
            skipLibCheck: true,
            noEmit: true,
          };
        }
      }
    } catch {
      resolvedCompilerOptions = defaultCompilerOptions;
    }

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => resolvedCompilerOptions,
      getScriptFileNames: () => Array.from(snapshots.keys()),
      getScriptVersion: (fileName) => versions.get(normalizeFsPath(fileName)) ?? '0',
      getScriptSnapshot: (fileName) => {
        const key = normalizeFsPath(fileName);
        const existing = snapshots.get(key);
        if (existing) return existing;
        // Fall back to disk for libs / unexpected lookups
        if (ts.sys.fileExists(fileName)) {
          const text = ts.sys.readFile(fileName) ?? '';
          const snap = ts.ScriptSnapshot.fromString(text);
          snapshots.set(key, snap);
          versions.set(key, '1');
          return snap;
        }
        return undefined;
      },
      getCurrentDirectory: () => root,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName) =>
        snapshots.has(normalizeFsPath(fileName)) || ts.sys.fileExists(fileName),
      readFile: (fileName) => {
        const key = normalizeFsPath(fileName);
        const snap = snapshots.get(key);
        if (snap) return snap.getText(0, snap.getLength());
        return ts.sys.readFile(fileName);
      },
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    };
    this.tsService = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  private abs(relOrAbs: string): string {
    const resolved = path.isAbsolute(relOrAbs)
      ? relOrAbs
      : path.resolve(this.workspaceRoot, relOrAbs);
    return normalizeFsPath(resolved);
  }

  private rel(absPath: string): string {
    return path.relative(this.workspaceRoot, absPath).replace(/\\/g, '/') || path.basename(absPath);
  }

  private isTsJs(filePath: string): boolean {
    return /\.(?:[cm]?[jt]sx?)$/i.test(filePath);
  }

  private isCpp(filePath: string): boolean {
    return /\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|hxx)$/i.test(filePath);
  }

  async openDocument(filePath: string, content?: string): Promise<void> {
    if (!this.workspaceRoot) return;
    const abs = this.abs(filePath);
    let text = content;
    if (text == null) {
      try {
        text = await fs.readFile(abs, 'utf-8');
      } catch {
        text = '';
      }
    }
    if (this.isTsJs(abs)) {
      const prev = Number(this.scriptVersions.get(abs) ?? 0);
      this.scriptVersions.set(abs, String(prev + 1));
      this.scriptSnapshots.set(abs, ts.ScriptSnapshot.fromString(text));
    }
    if (this.isCpp(abs)) {
      await this.ensureClangd();
      if (this.clangdReady) {
        await this.clangdNotify('textDocument/didOpen', {
          textDocument: {
            uri: pathToFileURL(abs),
            languageId: 'cpp',
            version: Date.now(),
            text,
          },
        });
      }
    }
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
    content?: string
  ): Promise<LspLocation[]> {
    await this.openDocument(filePath, content);
    const abs = this.abs(filePath);
    if (this.isTsJs(abs) && this.tsService) {
      const pos = this.offsetOf(abs, line, character);
      let defs: readonly ts.DefinitionInfo[] = [];
      try {
        defs =
          this.tsService.getDefinitionAtPosition(abs, pos) ||
          this.tsService.getTypeDefinitionAtPosition(abs, pos) ||
          [];
      } catch {
        return [];
      }
      return defs.map((d) => {
        const sf = this.tsService!.getProgram()?.getSourceFile(d.fileName);
        const lc = sf?.getLineAndCharacterOfPosition(d.textSpan.start) ?? {
          line: line - 1,
          character: 0,
        };
        return {
          file: this.rel(normalizeFsPath(d.fileName)),
          line: lc.line + 1,
          character: lc.character + 1,
        };
      });
    }
    if (this.isCpp(abs)) {
      await this.ensureClangd();
      if (!this.clangdReady) return [];
      const res = await this.clangdRequest('textDocument/definition', {
        textDocument: { uri: pathToFileURL(abs) },
        position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
      });
      return normalizeLspLocations(res, this.workspaceRoot);
    }
    return [];
  }

  async diagnostics(filePath: string, content?: string): Promise<LspDiagnostic[]> {
    await this.openDocument(filePath, content);
    const abs = this.abs(filePath);
    if (this.isTsJs(abs) && this.tsService) {
      let syn: readonly ts.Diagnostic[] = [];
      let sem: readonly ts.Diagnostic[] = [];
      try {
        syn = this.tsService.getSyntacticDiagnostics(abs);
        sem = this.tsService.getSemanticDiagnostics(abs);
      } catch {
        return [];
      }
      const out: LspDiagnostic[] = [];
      for (const d of [...syn, ...sem]) {
        const start = d.start ?? 0;
        const sf = d.file;
        const lc = sf?.getLineAndCharacterOfPosition(start) ?? { line: 0, character: 0 };
        out.push({
          file: this.rel(abs),
          line: lc.line + 1,
          column: lc.character + 1,
          severity: d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
          message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
          source: 'typescript',
        });
      }
      return out;
    }
    if (this.isCpp(abs)) {
      await this.ensureClangd();
      return this.clangdDiagnostics.get(this.rel(abs)) || [];
    }
    return [];
  }

  private offsetOf(abs: string, line: number, character: number): number {
    const snap = this.scriptSnapshots.get(abs);
    const text = snap?.getText(0, snap.getLength()) || '';
    const lines = text.split(/\r?\n/);
    let offset = 0;
    const target = Math.max(1, line) - 1;
    for (let i = 0; i < lines.length && i < target; i++) {
      offset += lines[i].length + 1;
    }
    return offset + Math.max(0, character - 1);
  }

  private async ensureClangd(): Promise<void> {
    if (this.clangdReady || !this.workspaceRoot) return;
    if (this.clangdStarting) {
      await this.clangdStarting;
      return;
    }
    this.clangdStarting = this.tryStartClangd().finally(() => {
      this.clangdStarting = null;
    });
    await this.clangdStarting;
  }

  private async tryStartClangd(): Promise<void> {
    try {
      const child = spawn('clangd', ['--background-index=false'], {
        cwd: this.workspaceRoot || undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      this.clangd = child;
      this.clangdReason = 'starting';
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => this.onClangdData(chunk));
      child.stderr.on('data', () => undefined);
      child.on('error', (err) => {
        this.clangdReady = false;
        this.clangdReason = err.message;
        this.clangd = null;
      });
      child.on('exit', () => {
        this.clangdReady = false;
        this.clangdReason = 'clangd exited';
        this.clangd = null;
      });

      await this.clangdRequest('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(this.workspaceRoot),
        capabilities: {
          textDocument: {
            definition: { linkSupport: false },
            publishDiagnostics: {},
          },
        },
      });
      await this.clangdNotify('initialized', {});
      this.clangdReady = true;
      this.clangdReason = 'ready';
    } catch (err) {
      this.clangdReady = false;
      this.clangdReason = (err as Error).message || 'clangd not available';
      if (this.clangd) {
        try {
          this.clangd.kill();
        } catch {
          // ignore
        }
        this.clangd = null;
      }
    }
  }

  private onClangdData(chunk: string): void {
    this.clangdBuf += chunk;
    while (true) {
      const headerEnd = this.clangdBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.clangdBuf.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.clangdBuf = this.clangdBuf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.clangdBuf.length < bodyStart + len) return;
      const body = this.clangdBuf.slice(bodyStart, bodyStart + len);
      this.clangdBuf = this.clangdBuf.slice(bodyStart + len);
      try {
        const msg = JSON.parse(body);
        if (msg.id != null && this.clangdPending.has(Number(msg.id))) {
          const pending = this.clangdPending.get(Number(msg.id))!;
          this.clangdPending.delete(Number(msg.id));
          if (msg.error) pending.reject(new Error(msg.error.message || 'LSP error'));
          else pending.resolve(msg.result);
        } else if (msg.method === 'textDocument/publishDiagnostics') {
          const uri = String(msg.params?.uri || '');
          const file = fileURLToPathSafe(uri, this.workspaceRoot);
          const diags: LspDiagnostic[] = (msg.params?.diagnostics || []).map((d: any) => ({
            file,
            line: (d.range?.start?.line ?? 0) + 1,
            column: (d.range?.start?.character ?? 0) + 1,
            severity:
              d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : ('info' as const),
            message: String(d.message || ''),
            source: 'clangd',
          }));
          this.clangdDiagnostics.set(file, diags);
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  private clangdSend(msg: Record<string, unknown>): void {
    if (!this.clangd?.stdin.writable) {
      throw new Error('clangd stdin closed');
    }
    const json = JSON.stringify(msg);
    this.clangd.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf-8')}\r\n\r\n${json}`);
  }

  private clangdRequest(method: string, params: unknown): Promise<any> {
    const id = this.clangdNextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clangdPending.delete(id);
        reject(new Error(`clangd timeout: ${method}`));
      }, 8000);
      this.clangdPending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.clangdSend({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.clangdPending.delete(id);
        reject(err as Error);
      }
    });
  }

  private async clangdNotify(method: string, params: unknown): Promise<void> {
    this.clangdSend({ jsonrpc: '2.0', method, params });
  }

  async dispose(): Promise<void> {
    this.tsService?.dispose();
    this.tsService = null;
    this.scriptSnapshots.clear();
    this.scriptVersions.clear();
    this.clangdDiagnostics.clear();
    for (const [, p] of this.clangdPending) {
      p.reject(new Error('LSP disposed'));
    }
    this.clangdPending.clear();
    if (this.clangd) {
      const child = this.clangd;
      this.clangd = null;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        child.once('exit', done);
        try {
          child.kill();
        } catch {
          done();
          return;
        }
        setTimeout(done, 500);
      });
    }
    this.clangdReady = false;
    this.clangdStarting = null;
    this.clangdReason = 'disposed';
    this.workspaceRoot = '';
  }
}

/** Canonical absolute path for Language Service map keys (Windows-safe). */
function normalizeFsPath(p: string): string {
  if (!p) return '';
  let resolved = path.resolve(p);
  // Prefer realpath when available so short/long Windows paths match
  try {
    if (ts.sys.realpath) {
      resolved = ts.sys.realpath(resolved);
    }
  } catch {
    // keep resolved
  }
  // TypeScript script names use forward slashes
  resolved = resolved.replace(/\\/g, '/');
  if (/^[a-z]:/i.test(resolved)) {
    resolved = resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}

function pathToFileURL(absPath: string): string {
  const normalized = normalizeFsPath(absPath);
  if (/^[A-Za-z]:/.test(normalized)) {
    return `file:///${normalized}`;
  }
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

function fileURLToPathSafe(uri: string, workspaceRoot: string): string {
  try {
    let p = uri.replace(/^file:\/\//, '');
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    p = decodeURIComponent(p);
    return path.relative(workspaceRoot, normalizeFsPath(p)).replace(/\\/g, '/') || path.basename(p);
  } catch {
    return uri;
  }
}

function normalizeLspLocations(res: any, workspaceRoot: string): LspLocation[] {
  const arr = Array.isArray(res) ? res : res ? [res] : [];
  return arr
    .map((loc: any) => {
      const uri = loc.targetUri || loc.uri;
      const range = loc.targetRange || loc.targetSelectionRange || loc.range;
      if (!uri || !range) return null;
      return {
        file: fileURLToPathSafe(String(uri), workspaceRoot),
        line: (range.start?.line ?? 0) + 1,
        character: (range.start?.character ?? 0) + 1,
      } as LspLocation;
    })
    .filter(Boolean) as LspLocation[];
}
