/**
 * Project-aware language diagnostics for the Agent loop (no Extension Host).
 * - TS/JS: TypeScript Language Service with nearest tsconfig.json
 * - C/C++: optional `clangd --check` when on PATH
 * - Python: optional `py_compile` syntax check
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { BuildDiagnostic } from './BuildDiagnostics.js';

export interface DiagnoseFileParams {
  workspaceRoot: string;
  filePath: string;
  content: string;
  maxErrors?: number;
}

function normalizeFsPath(p: string): string {
  if (!p) return '';
  let resolved = path.resolve(p);
  try {
    if (ts.sys.realpath) resolved = ts.sys.realpath(resolved);
  } catch {
    // keep resolved
  }
  resolved = resolved.replace(/\\/g, '/');
  if (/^[a-z]:/i.test(resolved)) {
    resolved = resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}

function isTsJs(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(filePath);
}

function isCpp(filePath: string): boolean {
  return /\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|hxx)$/i.test(filePath);
}

function isPython(filePath: string): boolean {
  return /\.py$/i.test(filePath);
}

const DEFAULT_TS_OPTIONS: ts.CompilerOptions = {
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

function loadProjectTsConfig(
  workspaceRoot: string,
  fileAbs: string
): { options: ts.CompilerOptions; fileNames: string[]; configFile?: string } {
  const configPath = ts.findConfigFile(
    path.dirname(fileAbs),
    ts.sys.fileExists,
    'tsconfig.json'
  );
  if (!configPath) {
    const alt = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json');
    if (!alt) {
      return { options: { ...DEFAULT_TS_OPTIONS }, fileNames: [fileAbs] };
    }
    return parseTsConfig(alt, workspaceRoot, fileAbs);
  }
  return parseTsConfig(configPath, workspaceRoot, fileAbs);
}

function parseTsConfig(
  configPath: string,
  workspaceRoot: string,
  fileAbs: string
): { options: ts.CompilerOptions; fileNames: string[]; configFile: string } {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    return {
      options: { ...DEFAULT_TS_OPTIONS },
      fileNames: [fileAbs],
      configFile: configPath,
    };
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );
  const options: ts.CompilerOptions = {
    ...DEFAULT_TS_OPTIONS,
    ...parsed.options,
    noEmit: true,
    skipLibCheck: parsed.options.skipLibCheck ?? true,
  };
  // Cap project files so post-edit stays fast; always include the edited file
  const names = (parsed.fileNames || [])
    .map((f) => normalizeFsPath(f))
    .filter((f) => isTsJs(f));
  const edited = normalizeFsPath(fileAbs);
  const capped: string[] = [];
  const seen = new Set<string>();
  const push = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    capped.push(f);
  };
  push(edited);
  for (const f of names) {
    if (capped.length >= 80) break;
    push(f);
  }
  // Prefer nearby files if project is huge
  if (names.length > 80) {
    const dir = path.dirname(edited).replace(/\\/g, '/');
    for (const f of names) {
      if (capped.length >= 120) break;
      if (f.startsWith(dir + '/') || f.startsWith(dir)) push(f);
    }
  }
  void workspaceRoot;
  return { options, fileNames: capped, configFile: configPath };
}

/**
 * Run TypeScript Language Service diagnostics with nearest tsconfig when present.
 */
export function diagnoseTypeScriptFile(params: DiagnoseFileParams): BuildDiagnostic[] {
  const { workspaceRoot, content } = params;
  const maxErrors = params.maxErrors ?? 30;
  const rel = String(params.filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!isTsJs(rel)) return [];

  const root = normalizeFsPath(workspaceRoot);
  const abs = normalizeFsPath(path.resolve(workspaceRoot, rel));
  const project = loadProjectTsConfig(workspaceRoot, abs);

  const versions = new Map<string, string>();
  const snapshots = new Map<string, ts.IScriptSnapshot>();

  for (const fileName of project.fileNames) {
    const key = normalizeFsPath(fileName);
    if (key === abs) {
      versions.set(key, '1');
      snapshots.set(key, ts.ScriptSnapshot.fromString(content));
    } else if (ts.sys.fileExists(fileName)) {
      const text = ts.sys.readFile(fileName) ?? '';
      versions.set(key, '1');
      snapshots.set(key, ts.ScriptSnapshot.fromString(text));
    }
  }
  // Ensure edited file is always present even if outside tsconfig include
  if (!snapshots.has(abs)) {
    versions.set(abs, '1');
    snapshots.set(abs, ts.ScriptSnapshot.fromString(content));
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => project.options,
    getScriptFileNames: () => Array.from(snapshots.keys()),
    getScriptVersion: (fileName) => versions.get(normalizeFsPath(fileName)) ?? '0',
    getScriptSnapshot: (fileName) => {
      const key = normalizeFsPath(fileName);
      const existing = snapshots.get(key);
      if (existing) return existing;
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

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  try {
    let syn: readonly ts.Diagnostic[] = [];
    let sem: readonly ts.Diagnostic[] = [];
    try {
      syn = service.getSyntacticDiagnostics(abs);
      sem = service.getSemanticDiagnostics(abs);
    } catch {
      return [];
    }
    const out: BuildDiagnostic[] = [];
    const sourceTag = project.configFile ? 'typescript-ls+tsconfig' : 'typescript-ls';
    for (const d of [...syn, ...sem]) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      const start = d.start ?? 0;
      const sf = d.file;
      const lc = sf?.getLineAndCharacterOfPosition(start) ?? { line: 0, character: 0 };
      const diagFile = sf?.fileName
        ? path.relative(workspaceRoot, sf.fileName).replace(/\\/g, '/') || rel
        : rel;
      out.push({
        file: diagFile,
        line: lc.line + 1,
        column: lc.character + 1,
        severity: 'error',
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n').slice(0, 300),
        source: sourceTag,
      });
      if (out.length >= maxErrors) break;
    }
    return out;
  } finally {
    service.dispose();
  }
}

function runProcessCapture(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 6000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    } catch {
      resolve({ code: null, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ code: null, stdout, stderr: stderr || 'timeout' });
    }, timeoutMs);
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr?.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Parse clangd --check / clang -fsyntax-only style path:line:col: error: msg */
function parseClangStyleDiagnostics(
  text: string,
  relFallback: string,
  source: string,
  maxErrors: number
): BuildDiagnostic[] {
  const out: BuildDiagnostic[] = [];
  const re =
    /([^\s:]+\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|hxx)):(\d+):(\d+):\s*(?:fatal\s+)?(error|warning):\s*([^\r\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (String(m[4]).toLowerCase() === 'warning') continue;
    const file = String(m[1]).replace(/\\/g, '/');
    out.push({
      file: file.includes('/') || file.includes('\\') ? path.basename(file) === path.basename(relFallback) ? relFallback : file : relFallback,
      line: Number(m[2]) || 1,
      column: Number(m[3]) || 1,
      severity: 'error',
      message: String(m[5] || 'error').slice(0, 300),
      source,
    });
    if (out.length >= maxErrors) break;
  }
  return out;
}

export async function diagnoseCppFile(params: DiagnoseFileParams): Promise<BuildDiagnostic[]> {
  const rel = String(params.filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!isCpp(rel)) return [];
  const maxErrors = params.maxErrors ?? 30;
  const abs = path.resolve(params.workspaceRoot, rel);
  const tmpDir = path.join(params.workspaceRoot, '.deepautocode-data', 'diag-tmp');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    // ignore
  }
  const tmpFile = path.join(tmpDir, path.basename(rel) || 'edit.cpp');
  try {
    fs.writeFileSync(tmpFile, params.content, 'utf-8');
  } catch {
    return [];
  }

  // Prefer clangd --check (true LSP diagnostics without long-lived server)
  const clangd = await runProcessCapture(
    'clangd',
    ['--check=' + tmpFile, '--background-index=false'],
    params.workspaceRoot,
    7000
  );
  if (clangd.code !== null) {
    const combined = `${clangd.stdout}\n${clangd.stderr}`;
    const diags = parseClangStyleDiagnostics(combined, rel, 'clangd', maxErrors);
    if (diags.length > 0 || clangd.code === 0) return diags;
  }

  // Fallback: clang/clang++ -fsyntax-only
  const isCuda = /\.cu$/i.test(rel);
  const compiler = isCuda ? 'nvcc' : /\.(?:cc|cpp|cxx|hpp)$/i.test(rel) ? 'clang++' : 'clang';
  const args =
    compiler === 'nvcc'
      ? ['-c', '-o', path.join(tmpDir, 'a.o'), tmpFile]
      : ['-fsyntax-only', '-Wall', tmpFile];
  const clang = await runProcessCapture(compiler, args, params.workspaceRoot, 7000);
  if (clang.code === null && compiler.startsWith('clang')) {
    const gxx = await runProcessCapture(
      /\.(?:cc|cpp|cxx)$/i.test(rel) ? 'g++' : 'gcc',
      ['-fsyntax-only', '-Wall', tmpFile],
      params.workspaceRoot,
      7000
    );
    return parseClangStyleDiagnostics(
      `${gxx.stdout}\n${gxx.stderr}`,
      rel,
      'gcc-syntax',
      maxErrors
    );
  }
  return parseClangStyleDiagnostics(
    `${clang.stdout}\n${clang.stderr}`,
    rel,
    compiler === 'nvcc' ? 'nvcc' : 'clang-syntax',
    maxErrors
  );
}

export async function diagnosePythonFile(params: DiagnoseFileParams): Promise<BuildDiagnostic[]> {
  const rel = String(params.filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!isPython(rel)) return [];
  const tmpDir = path.join(params.workspaceRoot, '.deepautocode-data', 'diag-tmp');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    // ignore
  }
  const tmpFile = path.join(tmpDir, path.basename(rel) || 'edit.py');
  try {
    fs.writeFileSync(tmpFile, params.content, 'utf-8');
  } catch {
    return [];
  }
  const py = await runProcessCapture(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-m', 'py_compile', tmpFile],
    params.workspaceRoot,
    5000
  );
  if (py.code === 0) return [];
  const text = `${py.stdout}\n${py.stderr}`;
  const m =
    /File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+[^\r\n]+)?\r?\n\s*[^\r\n]+\r?\n([A-Za-z_][\w.]*Error:\s*[^\r\n]+)/i.exec(
      text
    ) || /(\w+Error):\s*([^\r\n]+)/i.exec(text);
  if (!m) {
    if (!text.trim()) return [];
    return [
      {
        file: rel,
        line: 1,
        severity: 'error',
        message: text.trim().slice(0, 300),
        source: 'py_compile',
      },
    ];
  }
  if (m.length >= 4 && m[2] && /^\d+$/.test(m[2])) {
    return [
      {
        file: rel,
        line: Number(m[2]) || 1,
        severity: 'error',
        message: String(m[3] || 'SyntaxError').slice(0, 300),
        source: 'py_compile',
      },
    ];
  }
  return [
    {
      file: rel,
      line: 1,
      severity: 'error',
      message: `${m[1]}: ${m[2] || ''}`.slice(0, 300),
      source: 'py_compile',
    },
  ];
}

/** Unified post-edit diagnostics entry for Agent RuntimeFactory. */
export async function diagnoseEditedFile(
  params: DiagnoseFileParams
): Promise<BuildDiagnostic[]> {
  const rel = String(params.filePath || '');
  if (isTsJs(rel)) return diagnoseTypeScriptFile(params);
  if (isCpp(rel)) return diagnoseCppFile(params);
  if (isPython(rel)) return diagnosePythonFile(params);
  return [];
}

/** Append a short code window around each diagnostic for the model. */
export function attachDiagnosticSnippets(
  content: string,
  diags: BuildDiagnostic[],
  radius = 2
): string {
  if (!diags.length) return '';
  const lines = content.split(/\r?\n/);
  const blocks: string[] = [];
  for (const d of diags.slice(0, 8)) {
    const idx = Math.max(0, (d.line || 1) - 1);
    const start = Math.max(0, idx - radius);
    const end = Math.min(lines.length - 1, idx + radius);
    const window = lines
      .slice(start, end + 1)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
    blocks.push(`--- ${d.file}:${d.line} ${d.message}\n${window}`);
  }
  return blocks.join('\n');
}
