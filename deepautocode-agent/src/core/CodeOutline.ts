import path from 'node:path';
import ts from 'typescript';

export type OutlineSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'namespace'
  | 'macro'
  | 'const'
  | 'variable'
  | 'module'
  | 'other';

export interface OutlineSymbol {
  kind: OutlineSymbolKind;
  name: string;
  startLine: number;
  endLine: number;
  detail?: string;
}

export interface ExtractOutlineOptions {
  filePath?: string;
  maxEntries?: number;
}

const CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'sizeof',
  'alignof',
  'typeof',
  'WARN',
  'INFO',
  'TRACE',
  'NCCLCHECK',
  'CUDACHECK',
  'HIPCHECK',
]);

function extOf(filePath?: string): string {
  if (!filePath) return '';
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

function isTsJs(ext: string): boolean {
  return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(ext);
}

function isCppLike(ext: string): boolean {
  return ['c', 'cc', 'cpp', 'cxx', 'cu', 'cuh', 'h', 'hh', 'hpp', 'hxx', 'hip'].includes(ext);
}

/**
 * Approximate end line by brace matching from a declaration start.
 * Falls back to the start line when no body is found (prototypes / one-liners).
 */
export function findBlockEndLine(lines: string[], startIdx: number, maxScan = 4000): number {
  let depth = 0;
  let seenBrace = false;
  const limit = Math.min(lines.length, startIdx + maxScan);
  for (let i = startIdx; i < limit; i++) {
    const line = lines[i];
    // Strip simple // comments to reduce false braces in comments
    const code = line.replace(/\/\/.*$/, '');
    for (let j = 0; j < code.length; j++) {
      const ch = code[j];
      if (ch === '{') {
        depth += 1;
        seenBrace = true;
      } else if (ch === '}') {
        depth -= 1;
        if (seenBrace && depth <= 0) {
          return i;
        }
      }
    }
    if (!seenBrace && /;\s*$/.test(code.trim()) && i >= startIdx) {
      return i;
    }
    // Declarations that open on a following line: keep scanning a bit
    if (!seenBrace && i - startIdx > 12) {
      return startIdx;
    }
  }
  return seenBrace ? Math.min(lines.length - 1, startIdx + maxScan - 1) : startIdx;
}

export function formatOutlineSymbols(symbols: OutlineSymbol[]): string[] {
  return symbols.map((s) => {
    const range =
      s.endLine > s.startLine ? `L${s.startLine}-L${s.endLine}` : `L${s.startLine}`;
    const detail = s.detail ? ` ${s.detail}` : '';
    return `${range}: ${s.kind} ${s.name}${detail}`.slice(0, 160);
  });
}

function pushSymbol(
  out: OutlineSymbol[],
  maxEntries: number,
  symbol: OutlineSymbol
): boolean {
  if (out.length >= maxEntries) return false;
  out.push({
    ...symbol,
    endLine: Math.max(symbol.startLine, symbol.endLine),
    name: symbol.name || 'anonymous',
  });
  return out.length < maxEntries;
}

/**
 * TypeScript / JavaScript AST outline via the `typescript` package.
 */
export function extractTypeScriptOutline(
  content: string,
  filePath = 'file.ts',
  maxEntries = 120
): OutlineSymbol[] {
  const lower = filePath.toLowerCase();
  const scriptKind =
    lower.endsWith('.tsx') || lower.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

  const sf = ts.createSourceFile(
    filePath || 'file.ts',
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const out: OutlineSymbol[] = [];
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node, depth: number) => {
    if (out.length >= maxEntries) return;

    const startLine = lineOf(node.getStart(sf, false));
    const endLine = lineOf(node.end);

    const add = (kind: OutlineSymbolKind, name: string, detail?: string) => {
      pushSymbol(out, maxEntries, { kind, name, startLine, endLine, detail });
    };

    if (ts.isFunctionDeclaration(node) && node.name) {
      add('function', node.name.getText(sf));
    } else if (ts.isClassDeclaration(node) && node.name) {
      add('class', node.name.getText(sf));
    } else if (ts.isInterfaceDeclaration(node)) {
      add('interface', node.name.getText(sf));
    } else if (ts.isTypeAliasDeclaration(node)) {
      add('type', node.name.getText(sf));
    } else if (ts.isEnumDeclaration(node)) {
      add('enum', node.name.getText(sf));
    } else if (ts.isModuleDeclaration(node) && node.name) {
      add('namespace', node.name.getText(sf));
    } else if (ts.isMethodDeclaration(node) && node.name) {
      add('method', node.name.getText(sf));
    } else if (ts.isConstructorDeclaration(node)) {
      add('method', 'constructor');
    } else if (ts.isGetAccessorDeclaration(node) && node.name) {
      add('method', `get ${node.name.getText(sf)}`);
    } else if (ts.isSetAccessorDeclaration(node) && node.name) {
      add('method', `set ${node.name.getText(sf)}`);
    } else if (ts.isVariableStatement(node) && depth <= 2) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.getText(sf);
        const init = decl.initializer;
        if (
          init &&
          (ts.isArrowFunction(init) ||
            ts.isFunctionExpression(init) ||
            ts.isClassExpression(init))
        ) {
          add(
            ts.isClassExpression(init) ? 'class' : 'function',
            name,
            node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
              ? '(export)'
              : undefined
          );
        } else if (
          node.declarationList.flags & ts.NodeFlags.Const &&
          depth === 0 &&
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          add('const', name, '(export)');
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };

  visit(sf, 0);
  return out.slice(0, maxEntries);
}

/**
 * Regex + brace-scan heuristic for C/C++/CUDA and other languages.
 */
export function extractHeuristicOutline(
  content: string,
  filePath?: string,
  maxEntries = 120
): OutlineSymbol[] {
  const lines = content.split(/\r?\n/);
  const out: OutlineSymbol[] = [];
  const ext = extOf(filePath);
  const cpp = !filePath || isCppLike(ext);

  const patterns: Array<{
    re: RegExp;
    kind: OutlineSymbolKind;
    nameGroup?: number;
  }> = [
    {
      re: /^\s*(?:struct|class|enum|union)\s+([A-Za-z_]\w*)\b/,
      kind: 'struct',
      nameGroup: 1,
    },
    {
      re: /^\s*namespace\s+([A-Za-z_]\w*)\b/,
      kind: 'namespace',
      nameGroup: 1,
    },
    {
      re: /^\s*#\s*define\s+([A-Za-z_]\w*)\s*\(/,
      kind: 'macro',
      nameGroup: 1,
    },
    {
      re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/,
      kind: 'function',
      nameGroup: 1,
    },
    {
      re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_]\w*)/,
      kind: 'class',
      nameGroup: 1,
    },
    {
      re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_]\w*)/,
      kind: 'interface',
      nameGroup: 1,
    },
    {
      re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\(|function\b)/,
      kind: 'function',
      nameGroup: 1,
    },
    {
      re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
      kind: 'function',
      nameGroup: 1,
    },
    {
      re: /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/,
      kind: 'class',
      nameGroup: 1,
    },
    {
      re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
      kind: 'function',
      nameGroup: 1,
    },
    {
      re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/,
      kind: 'struct',
      nameGroup: 1,
    },
    {
      re: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/,
      kind: 'function',
      nameGroup: 1,
    },
  ];

  if (cpp) {
    patterns.push({
      re: /^\s*(?:static\s+|inline\s+|__forceinline__\s+|__device__\s+|__global__\s+|__host__\s+|extern\s+|constexpr\s+|virtual\s+)*(?:[A-Za-z_][\w:<>*&\s]{1,64})\s+([A-Za-z_]\w*)\s*\([^;]*$/,
      kind: 'function',
      nameGroup: 1,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    if (out.length >= maxEntries) break;
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }
    for (const pat of patterns) {
      const m = line.match(pat.re);
      if (!m) continue;
      const name = (pat.nameGroup != null ? m[pat.nameGroup] : m[1]) || 'anonymous';
      if (CONTROL_KEYWORDS.has(name)) break;

      let kind = pat.kind;
      if (/^\s*(?:struct|class|enum|union)\b/.test(trimmed)) {
        if (trimmed.startsWith('class')) kind = 'class';
        else if (trimmed.startsWith('enum')) kind = 'enum';
        else if (trimmed.startsWith('union')) kind = 'struct';
        else kind = 'struct';
      }

      const endIdx = findBlockEndLine(lines, i);
      const detail = trimmed.slice(0, 80);
      pushSymbol(out, maxEntries, {
        kind,
        name,
        startLine: i + 1,
        endLine: endIdx + 1,
        detail: `(${detail})`,
      });
      break;
    }
  }

  return out;
}

/**
 * Path-aware outline: TS/JS AST when possible, otherwise enhanced heuristics.
 * Returns formatted lines: `L12-L48: function foo`.
 */
export function extractCodeOutlineSymbols(
  content: string,
  options?: ExtractOutlineOptions
): OutlineSymbol[] {
  const maxEntries = options?.maxEntries ?? 120;
  const filePath = options?.filePath;
  const ext = extOf(filePath);

  if (isTsJs(ext) || (!filePath && /(?:^|\n)\s*(?:import |export |const |function )/m.test(content.slice(0, 2000)))) {
    const ast = extractTypeScriptOutline(content, filePath || 'file.ts', maxEntries);
    if (ast.length > 0) return ast;
  }

  return extractHeuristicOutline(content, filePath, maxEntries);
}

/**
 * Backward-compatible string outline API (with start–end ranges when known).
 */
export function extractCodeOutline(
  content: string,
  maxEntries = 120,
  filePath?: string
): string[] {
  return formatOutlineSymbols(
    extractCodeOutlineSymbols(content, { maxEntries, filePath })
  );
}

export function extractCodeOutlineForPath(
  filePath: string,
  content: string,
  maxEntries = 120
): string[] {
  return extractCodeOutline(content, maxEntries, filePath);
}
