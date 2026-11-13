import fs from 'fs';

const path = new URL('../src/App.tsx', import.meta.url);
let src = fs.readFileSync(path, 'utf8');
const before = (src.match(/guideLang === 'zh'/g) || []).length;
console.log('guideLang === zh count before:', before);

function scanExpr(s, start) {
  let i = start;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inStr = null;
  let escaped = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      i++;
      continue;
    }
    if (c === '(') {
      depthParen++;
      i++;
      continue;
    }
    if (c === ')') {
      if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) return i;
      depthParen--;
      i++;
      continue;
    }
    if (c === '{') {
      depthBrace++;
      i++;
      continue;
    }
    if (c === '}') {
      if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) return i;
      depthBrace--;
      i++;
      continue;
    }
    if (c === '[') {
      depthBracket++;
      i++;
      continue;
    }
    if (c === ']') {
      if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) return i;
      depthBracket--;
      i++;
      continue;
    }
    if (
      (c === ',' || c === ';') &&
      depthParen === 0 &&
      depthBrace === 0 &&
      depthBracket === 0
    ) {
      return i;
    }
    if (c === ':' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      return i;
    }
    i++;
  }
  return i;
}

function replaceGuideLangTernaries(input) {
  // Match both inline and multiline: guideLang === 'zh' [ws] ? ...
  const re = /guideLang === 'zh'\s*\?/g;
  let out = '';
  let i = 0;
  let replaced = 0;
  let match;
  while ((match = re.exec(input)) !== null) {
    if (match.index < i) continue;
    out += input.slice(i, match.index);
    let p = match.index + match[0].length;
    while (p < input.length && /\s/.test(input[p])) p++;
    const thenStart = p;
    const thenEnd = scanExpr(input, thenStart);
    let q = thenEnd;
    while (q < input.length && /\s/.test(input[q])) q++;
    if (input[q] !== ':') {
      out += input.slice(match.index, thenEnd);
      i = thenEnd;
      re.lastIndex = i;
      continue;
    }
    q++;
    while (q < input.length && /\s/.test(input[q])) q++;
    const elseStart = q;
    const elseEnd = scanExpr(input, elseStart);
    const thenExpr = input.slice(thenStart, thenEnd).trim();
    const elseExpr = input.slice(elseStart, elseEnd).trim();
    out += `tr(${thenExpr}, ${elseExpr})`;
    replaced++;
    i = elseEnd;
    re.lastIndex = i;
  }
  out += input.slice(i);
  console.log('replaced ternaries:', replaced);
  return out;
}

src = replaceGuideLangTernaries(src);
const after = (src.match(/guideLang === 'zh'/g) || []).length;
console.log('guideLang === zh count after:', after);
fs.writeFileSync(path, src);
