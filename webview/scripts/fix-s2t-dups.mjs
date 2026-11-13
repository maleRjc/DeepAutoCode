import fs from 'fs';

const path = new URL('../src/i18n/s2t.ts', import.meta.url);
const s = fs.readFileSync(path, 'utf8');
const start = s.indexOf('const CHAR_MAP');
const brace = s.indexOf('{', start);
let depth = 0;
let end = brace;
for (let i = brace; i < s.length; i++) {
  if (s[i] === '{') depth++;
  else if (s[i] === '}') {
    depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
const body = s.slice(brace, end + 1);
const keys = [...body.matchAll(/\n\s*([^\s:'"`]+)\s*:/g)].map((x) => x[1]);
const seen = new Map();
const dups = [];
for (const k of keys) {
  if (seen.has(k)) dups.push(k);
  else seen.set(k, 1);
}
console.log('dup count', dups.length);
console.log([...new Set(dups)].join(','));

// Rewrite CHAR_MAP keeping last occurrence of each key
let src = s;
const mapMatch = src.match(/const CHAR_MAP[^=]*=\s*\{/);
if (!mapMatch) process.exit(1);
const mapStart = src.indexOf(mapMatch[0]) + mapMatch[0].length;
// parse entries loosely:  key: 'value',
const entryRe = /([^\s,'"`{}]+)\s*:\s*'((?:\\'|[^'])*)'\s*,?/g;
const entries = [];
let m;
const mapBody = src.slice(mapStart, end);
while ((m = entryRe.exec(mapBody)) !== null) {
  entries.push([m[1], m[2]]);
}
const final = new Map();
for (const [k, v] of entries) final.set(k, v);
const rebuilt =
  'const CHAR_MAP: Record<string, string> = {\n' +
  [...final.entries()].map(([k, v]) => `  ${k}: '${v}',`).join('\n') +
  '\n};\n';

const before = src.slice(0, start);
const after = src.slice(end + 1).replace(/^\s*;?\s*/, '');
src = before + rebuilt + after;
fs.writeFileSync(path, src);
console.log('rewrote CHAR_MAP entries:', final.size);
