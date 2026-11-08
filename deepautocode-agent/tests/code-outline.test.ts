import { describe, expect, it } from 'vitest';
import {
  extractCodeOutline,
  extractCodeOutlineSymbols,
  extractHeuristicOutline,
  extractTypeScriptOutline,
  findBlockEndLine,
} from '../src/core/CodeOutline.js';

describe('CodeOutline (lightweight symbol / AST outline)', () => {
  it('findBlockEndLine matches braces and prototypes', () => {
    const body = ['int foo() {', '  return 1;', '}', ''];
    expect(findBlockEndLine(body, 0)).toBe(2);
    const proto = ['int bar(int x);', ''];
    expect(findBlockEndLine(proto, 0)).toBe(0);
  });

  it('extracts TS/JS symbols with start–end ranges via AST', () => {
    const src = `
export interface Opts { n: number }
export type Id = string
export class Greeter {
  constructor() {}
  greet(name: string) {
    return 'hi ' + name
  }
}
export const run = async () => {
  return 1
}
export function helper(x: number) {
  return x + 1
}
`.trim();
    const symbols = extractTypeScriptOutline(src, 'demo.ts', 50);
    const names = symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain('interface:Opts');
    expect(names).toContain('type:Id');
    expect(names).toContain('class:Greeter');
    expect(names).toContain('method:greet');
    expect(names).toContain('function:run');
    expect(names).toContain('function:helper');
    const greet = symbols.find((s) => s.name === 'greet');
    expect(greet).toBeTruthy();
    expect(greet!.endLine).toBeGreaterThan(greet!.startLine);
    const formatted = extractCodeOutline(src, 50, 'demo.ts');
    expect(formatted.some((l) => /^L\d+-L\d+: method greet/.test(l))).toBe(true);
  });

  it('extracts C++-like functions/structs with end lines', () => {
    const src = `
struct Comm {
  int rank;
};

static int reduceCopy(int n) {
  if (n == 0) return 0;
  return n + 1;
}

#define CHECK_OK(x) do { if (!(x)) return -1; } while (0)
`.trim();
    const symbols = extractHeuristicOutline(src, 'src/enqueue.cc', 50);
    const byName = Object.fromEntries(symbols.map((s) => [s.name, s]));
    expect(byName.Comm?.kind).toBe('struct');
    expect(byName.reduceCopy?.kind).toBe('function');
    expect(byName.reduceCopy.endLine).toBeGreaterThan(byName.reduceCopy.startLine);
    expect(byName.CHECK_OK?.kind).toBe('macro');
  });

  it('path-aware dispatch prefers AST for .ts files', () => {
    const src = 'export const add = (a: number, b: number) => a + b;\n';
    const symbols = extractCodeOutlineSymbols(src, { filePath: 'math.ts' });
    expect(symbols.some((s) => s.name === 'add' && s.kind === 'function')).toBe(true);
  });
});
