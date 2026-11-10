import React from 'react';
import type { DiffLineKind } from '../../../src/diff-line-marks';
import type { SplitDiffRow } from '../types/workbench';

export function formatCompactTokens(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}

export const IMAGE_FILE_EXT_PATTERN = /\.(?:png|ico|jpg|jpeg|gif|webp|svg|bmp|avif)$/i;

export function getImageMimeType(filePath: string): string {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'ico':
      return 'image/x-icon';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
      return 'image/avif';
    default:
      return 'image/png';
  }
}

export function wordAtCursor(content: string, line: number, col: number): string {
  const lines = (content || '').split(/\r?\n/);
  const row = lines[Math.max(0, line - 1)] || '';
  const idx = Math.max(0, Math.min(row.length, col - 1));
  const left = row.slice(0, idx).match(/[A-Za-z0-9_$]+$/)?.[0] || '';
  const right = row.slice(idx).match(/^[A-Za-z0-9_$]+/)?.[0] || '';
  return left + right;
}

export function promptWantsWorkspaceArtifact(rawText: string): boolean {
  const cleaned = String(rawText || '').trim();
  if (!cleaned) return false;
  return (
    /(?:生成|导出|输出|制作|撰写|写一份|写个|写成|保存为|落地为|生成一份|做成).{0,32}(?:pdf|文档|教程|手册|报告|markdown|\.md|docx|html)/i.test(
      cleaned
    ) ||
    /(?:完整的|详细的).{0,20}(?:pdf|教程|文档|手册|报告)/i.test(cleaned) ||
    /(?:pdf|\.md)\s*文档/i.test(cleaned)
  );
}

export function detectUiPromptIntent(
  rawText: string,
  executionMode: 'plan' | 'auto' | 'manual'
): {
  isQueryOnly: boolean;
  badgeText: string;
} {
  const cleaned = String(rawText || '').trim();
  if (!cleaned) {
    return {
      isQueryOnly: executionMode === 'plan',
      badgeText:
        executionMode === 'plan'
          ? '📖 Mode: Read-Only Analysis'
          : '⚡ Smart Routing: Read-Only Query / Auto-Edit & Verify',
    };
  }
  if (
    /(?:只分析|仅分析|不要改|先别改|别修改|不修改|不要修改|只查询|只看|只解释)/i.test(cleaned)
  ) {
    return { isQueryOnly: true, badgeText: '🔍 Detected: Read-Only Analysis (No Edits)' };
  }
  const wantsArtifact = promptWantsWorkspaceArtifact(cleaned);
  if (wantsArtifact) {
    return { isQueryOnly: false, badgeText: '📄 Detected: Generate doc/PDF in workspace (Auto)' };
  }
  const hasActionVerb =
    /(?:修复|修改|改一下|帮我改|直接改|改好|解决|处理|实现|新增|添加|创建|编写|写一个|写一份|生成|导出|制作|重构|优化|升级|替换|删除|编译|构建|运行测试|跑一下|按你的建议|按你说的|按此方案|落地|继续改|还是不对|仍然不对|依然不对|一键自动)/i.test(
      cleaned
    );
  const hasErrorLog =
    /(?:#wrong\s*=\s*[1-9]|Out of bounds values\s*:\s*[1-9]|\bfatal error:|\berror:\s+[^\n]+|\bSegmentation fault\b|\bFAILED\b|ENOENT|EADDRINUSE)/i.test(
      cleaned
    );
  const hasQueryPattern =
    /(?:是什么|是干嘛的|干什么用|在哪里|在哪儿|怎么理解|为什么|为何|如何理解|帮我看看|帮我查|查一下|查询|分析一下|解释一下|介绍一下|讲讲|有哪些|区别是|流程是|调用链|逻辑是)/i.test(
      cleaned
    );
  const endsWithQuestion = /[?？]\s*$/.test(cleaned);
  if (hasQueryPattern && !hasActionVerb && !hasErrorLog && !wantsArtifact) {
    return { isQueryOnly: true, badgeText: '🔍 Smart Route: Read-Only Analysis (No Edits)' };
  }
  if (endsWithQuestion && !hasActionVerb && !hasErrorLog && !wantsArtifact) {
    return { isQueryOnly: true, badgeText: '🔍 Smart Route: Question → Read-Only (No Edits)' };
  }
  if (hasActionVerb || hasErrorLog) {
    return { isQueryOnly: false, badgeText: '🛠️ Smart Route: Auto-Edit + Build & Verify' };
  }
  return {
    isQueryOnly: executionMode === 'plan',
    badgeText:
      executionMode === 'plan'
        ? '📖 Mode: Read-Only Analysis'
        : '⚡ Smart Route: Auto-Detect Intent',
  };
}

export function buildCheckpointContentDiff(
  before: string,
  after: string,
  maxLines = 24
): { summary: string; preview: string } {
  const a = String(before || '').replace(/\r\n/g, '\n').split('\n');
  const b = String(after || '').replace(/\r\n/g, '\n').split('\n');
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && lines.length < maxLines; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (left != null && right == null) {
      lines.push(`- ${left}`);
      removed += 1;
    } else if (left == null && right != null) {
      lines.push(`+ ${right}`);
      added += 1;
    } else {
      lines.push(`- ${left}`);
      lines.push(`+ ${right}`);
      removed += 1;
      added += 1;
    }
  }
  if (lines.length === 0) {
    return { summary: 'no content delta vs current', preview: '(identical)' };
  }
  return {
    summary: `+${added} / -${removed} line changes (sample)`,
    preview: lines.join('\n'),
  };
}

export function formatToolStepLabel(tc: any): string {
  const name = String(tc?.toolName || '');
  const input = tc?.input ?? tc?.args ?? {};
  const targetPath = input.path || input.filePath || input.directory || input.dirPath || '';
  const shortPath = targetPath
    ? String(targetPath).split(/[\\/]/).slice(-2).join('/')
    : '';
  if (name === 'read_file' || name === 'read-file')
    return shortPath ? `Read ${shortPath}` : 'Read file';
  if (name === 'list_files' || name === 'list-files')
    return shortPath ? `Scan ${shortPath}` : 'Scan workspace';
  if (
    name === 'write_file' ||
    name === 'write-file' ||
    name === 'edit_file' ||
    name === 'editor' ||
    name === 'apply_patch' ||
    name === 'reveal-diff'
  )
    return shortPath ? `Edit ${shortPath}` : 'Generate code changes';
  if (
    name === 'run_command' ||
    name === 'run-build' ||
    name === 'auto_build_and_test' ||
    name === 'bash'
  )
    return input.command ? `Run build/command` : 'Run terminal command';
  if (name === 'open_file' || name === 'open-file')
    return shortPath ? `Open ${shortPath}` : 'Locate file';
  if (name === 'browser_action')
    return input.action ? `Browser: ${input.action}` : 'Browser inspect';
  if (name === 'manage_task')
    return input.action ? `Task: ${input.action}` : 'Manage task';
  if (name === 'ask_question') return 'Clarify with user';
  if (name === 'search_web')
    return input.query ? `Web search "${String(input.query).slice(0, 22)}"` : 'Web search';
  if (name === 'define_subagent')
    return input.name ? `Define subagent "${input.name}"` : 'Define subagent';
  if (name === 'manage_subagents')
    return input.action ? `Subagents: ${input.action}` : 'Manage subagents';
  if (name === 'send_message')
    return input.recipient ? `Message → ${input.recipient}` : 'Send subagent message';
  if (name === 'schedule')
    return input.cronExpression
      ? `Cron (${input.cronExpression})`
      : `Timer (${input.durationSeconds || 10}s)`;
  if (name === 'read_transcript') return 'Read transcript log';
  if (name === 'migrate_agent_settings') return 'Migrate agent settings';
  if (name === 'search_marketplace') return 'Search Marketplace catalog';
  if (name === 'list_plugin_accounts') return 'Check plugin accounts';
  return name;
}

function toolCallArgs(tc: any): Record<string, unknown> {
  const raw = tc?.input ?? tc?.args;
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function stringifyClipboardChunk(value: unknown, maxChars: number): string {
  if (value == null) return '';
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.stdout === 'string' || typeof obj.stderr === 'string') {
      const chunks: string[] = [];
      if (obj.exitCode != null) chunks.push(`exitCode: ${obj.exitCode}`);
      if (typeof obj.stdout === 'string' && obj.stdout) {
        chunks.push(`--- stdout ---\n${obj.stdout}`);
      }
      if (typeof obj.stderr === 'string' && obj.stderr) {
        chunks.push(`--- stderr ---\n${obj.stderr}`);
      }
      if (typeof obj.content === 'string' && obj.content && !obj.stdout) {
        chunks.push(obj.content);
      }
      if (chunks.length > 0) {
        text = chunks.join('\n');
      } else {
        try {
          text = JSON.stringify(value, null, 2);
        } catch {
          text = String(value);
        }
      }
    } else {
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
    }
  } else {
    text = String(value);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]` : text;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const payload = String(text ?? '');
  if (!payload) return false;
  try {
    await navigator.clipboard.writeText(payload);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = payload;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Full turn text for clipboard: assistant reply + tool args, results, and errors. */
export function formatComposerMessageForClipboard(message: {
  role?: string;
  sequence?: number;
  content?: string;
  toolCalls?: any[];
}): string {
  const role = String(message.role || 'assistant').toUpperCase();
  const header =
    message.sequence != null ? `=== ${role} #${message.sequence} ===` : `=== ${role} ===`;
  const parts: string[] = [header, ''];
  const body = String(message.content ?? '').trim();
  if (body) {
    parts.push(body, '');
  }
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  toolCalls.forEach((tc, idx) => {
    const name = String(tc?.toolName || 'tool');
    const status = String(tc?.status || 'unknown');
    parts.push(`--- Tool ${idx + 1}: ${name} (${status}) ---`);
    const input = toolCallArgs(tc);
    if (Object.keys(input).length > 0) {
      parts.push('Arguments:', stringifyClipboardChunk(input, 80_000), '');
    }
    if (tc?.error) {
      parts.push('Error:', String(tc.error), '');
    }
    if (tc?.result !== undefined && tc?.result !== null) {
      parts.push('Result:', stringifyClipboardChunk(tc.result, 400_000), '');
    }
    if (typeof tc?.durationMs === 'number') {
      parts.push(`Duration: ${tc.durationMs}ms`);
    }
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatComposerSessionForClipboard(messages: any[]): string {
  const divider = `\n\n${'─'.repeat(52)}\n\n`;
  return (Array.isArray(messages) ? messages : [])
    .map((m) => formatComposerMessageForClipboard(m))
    .filter((block) => block.replace(/^===.*===\s*/m, '').trim().length > 0)
    .join(divider);
}

export function formatLiveComposerSnapshotForClipboard(
  streamingText: string,
  liveToolCalls: any[]
): string {
  const parts: string[] = ['=== LIVE OUTPUT (in progress) ===', ''];
  const stream = String(streamingText ?? '').trim();
  if (stream) {
    parts.push(stream, '');
  }
  const tools = Array.isArray(liveToolCalls) ? liveToolCalls : [];
  tools.forEach((tc, idx) => {
    parts.push(`--- Live tool ${idx + 1}: ${tc?.toolName || 'tool'} (${tc?.status || 'running'}) ---`);
    const input = toolCallArgs(tc);
    if (Object.keys(input).length > 0) {
      parts.push('Arguments:', stringifyClipboardChunk(input, 80_000), '');
    }
    if (tc?.error) {
      parts.push('Error:', String(tc.error), '');
    }
    if (tc?.result !== undefined && tc?.result !== null) {
      parts.push('Result:', stringifyClipboardChunk(tc.result, 200_000), '');
    }
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function parseDiffToSplitRows(diffText: string): SplitDiffRow[] {
  const lines = (diffText || '').split('\n');
  const rows: SplitDiffRow[] = [];
  let leftNum = 1;
  let rightNum = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      const m = line.match(/@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
      if (m) {
        leftNum = parseInt(m[1], 10);
        rightNum = parseInt(m[2], 10);
      }
      rows.push({
        leftText: line,
        leftType: 'hdr',
        rightText: line,
        rightType: 'hdr',
      });
      continue;
    }

    if (line.startsWith('-')) {
      if (i + 1 < lines.length && lines[i + 1].startsWith('+')) {
        const nextLine = lines[i + 1];
        rows.push({
          leftLine: leftNum++,
          leftText: line.slice(1),
          leftType: 'del',
          rightLine: rightNum++,
          rightText: nextLine.slice(1),
          rightType: 'add',
        });
        i++;
      } else {
        rows.push({
          leftLine: leftNum++,
          leftText: line.slice(1),
          leftType: 'del',
          rightType: 'empty',
        });
      }
    } else if (line.startsWith('+')) {
      rows.push({
        leftType: 'empty',
        rightLine: rightNum++,
        rightText: line.slice(1),
        rightType: 'add',
      });
    } else {
      const normalText = line.startsWith(' ') ? line.slice(1) : line;
      rows.push({
        leftLine: leftNum++,
        leftText: normalText,
        leftType: 'normal',
        rightLine: rightNum++,
        rightText: normalText,
        rightType: 'normal',
      });
    }
  }
  return rows;
}

export const SOURCE_FILE_EXT_PATTERN =
  /\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|hxx|py|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|md|pdf|txt|csv|sh|bash|zsh|bat|ps1|cmake|mk|go|rs|java|kt|cs|rb|php|sql|html|css|scss|less|vue|svelte|proto|gradle|xml|ini|cfg|conf)$/i;

export function parseSourceReferenceToken(
  rawToken: string,
  workspaceFiles: string[] = []
): {
  filePath: string;
  startLine?: number;
  endLine?: number;
  display: string;
} | null {
  const trimmed = String(rawToken ?? '').trim();
  if (!trimmed || trimmed.length > 220 || /\s/.test(trimmed)) return null;

  let candidate = trimmed;
  let startLine: number | undefined;
  let endLine: number | undefined;

  const hashMatch = candidate.match(/^(.*?)#L?(\d+)(?:-L?(\d+))?$/i);
  if (hashMatch) {
    candidate = hashMatch[1];
    startLine = Number(hashMatch[2]);
    if (hashMatch[3]) endLine = Number(hashMatch[3]);
  }

  const colonMatch = candidate.match(/^(.+?\.[a-zA-Z0-9_+-]+):(\d+)(?:[-:](\d+))?$/);
  if (colonMatch) {
    candidate = colonMatch[1];
    if (!startLine) startLine = Number(colonMatch[2]);
    if (!endLine && colonMatch[3]) endLine = Number(colonMatch[3]);
  }

  if (/^https?:\/\//i.test(candidate)) return null;

  const cleanCandidate = candidate.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/');
  const isKnownSpecialFile = /(?:^|\/)(?:Makefile|CMakeLists\.txt|Dockerfile)$/i.test(
    cleanCandidate
  );
  if (!SOURCE_FILE_EXT_PATTERN.test(cleanCandidate) && !isKnownSpecialFile) {
    return null;
  }

  const hasSlash = cleanCandidate.includes('/');
  const hasLine = typeof startLine === 'number' && startLine > 0;
  const matchesWorkspace =
    workspaceFiles.length > 0 &&
    workspaceFiles.some(
      (f) =>
        f.toLowerCase() === cleanCandidate.toLowerCase() ||
        f.toLowerCase().endsWith('/' + cleanCandidate.toLowerCase())
    );

  if (!hasSlash && !hasLine && !matchesWorkspace) {
    return null;
  }

  return {
    filePath: candidate,
    startLine,
    endLine,
    display: trimmed,
  };
}

export function findBestLineMatchInContent(
  contentStr: string,
  codeBody: string,
  clickedLineText?: string,
  hintStartLine?: number
): { startLine: number; endLine: number } | null {
  const fileLines = (contentStr || '').split('\n');
  if (fileLines.length === 0) return null;

  const normalizeCodeLine = (s: string) =>
    s
      .replace(/\/\/.*$/, '')
      .replace(/\/\*.*?\*\//g, '')
      .trim();

  const searchCandidates: string[] = [];
  if (clickedLineText) {
    const normClicked = normalizeCodeLine(clickedLineText);
    if (normClicked.length >= 4) {
      searchCandidates.push(normClicked);
    }
  }

  const snippetLines = (codeBody || '')
    .split('\n')
    .map((l) => normalizeCodeLine(l))
    .filter((l) => l.length >= 5 && !/^[{}()[\];]+$/.test(l));
  for (const sl of snippetLines.slice(0, 6)) {
    if (!searchCandidates.includes(sl)) {
      searchCandidates.push(sl);
    }
  }

  for (const needle of searchCandidates) {
    const matchedLineNumbers: number[] = [];
    for (let i = 0; i < fileLines.length; i++) {
      const hay = normalizeCodeLine(fileLines[i]);
      if (!hay) continue;
      if (hay === needle || (needle.length >= 10 && hay.includes(needle))) {
        matchedLineNumbers.push(i + 1);
      }
    }
    if (matchedLineNumbers.length > 0) {
      if (hintStartLine && hintStartLine > 0) {
        matchedLineNumbers.sort(
          (a, b) => Math.abs(a - hintStartLine) - Math.abs(b - hintStartLine)
        );
      }
      const bestStart = matchedLineNumbers[0];
      const span = Math.max(0, Math.min(25, snippetLines.length - 1));
      return {
        startLine: bestStart,
        endLine: clickedLineText ? bestStart : Math.min(fileLines.length, bestStart + span),
      };
    }
  }

  if (hintStartLine && hintStartLine > 0) {
    return {
      startLine: hintStartLine,
      endLine: Math.min(
        fileLines.length,
        hintStartLine + Math.max(0, Math.min(25, (codeBody || '').split('\n').length - 1))
      ),
    };
  }

  return null;
}

export function formatLatexMathText(rawExpr: string): string {
  return String(rawExpr || '')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
    .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
    .replace(/\\text\{([^{}]+)\}/g, '$1')
    .replace(/\\(?:mathbf|mathrm|mathit|mathcal)\{([^{}]+)\}/g, '$1')
    .replace(/\\alpha\b/g, 'α')
    .replace(/\\beta\b/g, 'β')
    .replace(/\\gamma\b/g, 'γ')
    .replace(/\\delta\b/g, 'δ')
    .replace(/\\epsilon\b/g, 'ε')
    .replace(/\\theta\b/g, 'θ')
    .replace(/\\lambda\b/g, 'λ')
    .replace(/\\mu\b/g, 'μ')
    .replace(/\\pi\b/g, 'π')
    .replace(/\\sigma\b/g, 'σ')
    .replace(/\\tau\b/g, 'τ')
    .replace(/\\omega\b/g, 'ω')
    .replace(/\\Delta\b/g, 'Δ')
    .replace(/\\Sigma\b/g, 'Σ')
    .replace(/\\Omega\b/g, 'Ω')
    .replace(/\\sum\b/g, '∑')
    .replace(/\\prod\b/g, '∏')
    .replace(/\\int\b/g, '∫')
    .replace(/\\infty\b/g, '∞')
    .replace(/\\approx\b/g, '≈')
    .replace(/\\neq\b/g, '≠')
    .replace(/\\leq\b|\\le\b/g, '≤')
    .replace(/\\geq\b|\\ge\b/g, '≥')
    .replace(/\\times\b/g, '×')
    .replace(/\\cdot\b/g, '·')
    .replace(/\\pm\b/g, '±')
    .replace(/\\rightarrow\b|\\to\b/g, '→')
    .replace(/\\Rightarrow\b/g, '⇒')
    .replace(/\\leftarrow\b/g, '←')
    .replace(/\\in\b/g, '∈')
    .replace(/\\forall\b/g, '∀')
    .replace(/\\exists\b/g, '∃')
    .trim();
}

export function extractLatestSourceRefFromText(
  textChunk: string,
  prevRef?: { filePath?: string; startLine?: number; endLine?: number },
  workspaceFiles: string[] = []
): { filePath?: string; startLine?: number; endLine?: number } | undefined {
  const words = String(textChunk ?? '').split(/[\s,;()[\]{}<>"'`，；。（）【】「」|]+/);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (!w || !w.includes('.')) continue;
    const parsed = parseSourceReferenceToken(w, workspaceFiles);
    if (parsed) {
      return {
        filePath: parsed.filePath,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
      };
    }
  }
  return prevRef;
}

export function extractCompactExecutiveSummary(
  cleaned: string,
  workspaceFiles: string[] = []
): {
  conclusionLines: string[];
  sourceRefs: Array<{
    filePath: string;
    startLine?: number;
    endLine?: number;
    display: string;
  }>;
  primaryCodeBlock?: {
    lang: string;
    codeBody: string;
    context?: { filePath?: string; startLine?: number; endLine?: number };
  };
} {
  const rawLines = cleaned.split('\n');
  const conclusionLines: string[] = [];

  let inConclusionSection = false;
  for (const rawLine of rawLines) {
    const t = rawLine.trim();
    if (!t || t === '---' || t.startsWith('```') || t.startsWith('|')) {
      if (inConclusionSection && conclusionLines.length >= 2) break;
      continue;
    }
    if (/^(?:#+\s*)?(?:🎯\s*)?(?:结论|核心原因|根因定位|核心结论|总结)\b/.test(t)) {
      inConclusionSection = true;
      const inlineAfterColon = t.replace(
        /^(?:#+\s*)?(?:🎯\s*)?(?:结论|核心原因|根因定位|核心结论|总结)\s*[:：]?\s*/,
        ''
      );
      if (inlineAfterColon.length >= 8) {
        conclusionLines.push(inlineAfterColon);
      }
      continue;
    }
    if (/^(?:\*\*|[-*•]\s*)?(?:决定性因素|核心修复|修改内容|验证结果)\s*[:：]/.test(t)) {
      conclusionLines.push(t.replace(/^[-*•]\s*/, ''));
      if (conclusionLines.length >= 3) break;
      continue;
    }
    if (inConclusionSection && !t.startsWith('#')) {
      conclusionLines.push(t.replace(/^[-*•]\s*/, ''));
      if (conclusionLines.length >= 3) break;
    }
  }

  if (conclusionLines.length === 0) {
    let insideFence = false;
    for (const rawLine of rawLines) {
      const t = rawLine.trim();
      if (t.startsWith('```')) {
        insideFence = !insideFence;
        continue;
      }
      if (insideFence || !t || t.startsWith('#') || t.startsWith('|') || t === '---') {
        continue;
      }
      if (t.length >= 10) {
        conclusionLines.push(t.replace(/^[-*•]\s*/, ''));
        if (conclusionLines.length >= 2) break;
      }
    }
  }

  const sourceRefs: Array<{
    filePath: string;
    startLine?: number;
    endLine?: number;
    display: string;
  }> = [];
  const seenRefKeys = new Set<string>();
  const allTokens = cleaned.split(/[\s,;()[\]{}<>"'`，；。（）【】「」|]+/);
  for (const tok of allTokens) {
    if (!tok || !tok.includes('.')) continue;
    const parsed = parseSourceReferenceToken(tok, workspaceFiles);
    if (!parsed) continue;
    const key = `${parsed.filePath}:${parsed.startLine || 0}`;
    if (seenRefKeys.has(key)) continue;
    seenRefKeys.add(key);
    sourceRefs.push(parsed);
    if (sourceRefs.length >= 6) break;
  }

  const segments = cleaned.split(/(```[\s\S]*?```)/g);
  let runningCtx: { filePath?: string; startLine?: number; endLine?: number } | undefined;
  let primaryCodeBlock:
    | {
        lang: string;
        codeBody: string;
        context?: { filePath?: string; startLine?: number; endLine?: number };
      }
    | undefined;

  for (const seg of segments) {
    if (seg.startsWith('```') && seg.endsWith('```')) {
      const lines = seg.slice(3, -3).split('\n');
      const firstLine = (lines[0] || '').trim();
      const hasLang = /^[a-zA-Z0-9_+-]+$/.test(firstLine);
      const lang = hasLang ? firstLine.toLowerCase() : 'code';
      const codeBody = (hasLang ? lines.slice(1) : lines).join('\n').trim();
      if (!codeBody) continue;
      const isSourceCodeLang = /^(c|cpp|cc|cxx|cu|h|hpp|ts|tsx|js|jsx|py|python|go|rust|java)$/.test(
        lang
      );
      if (!primaryCodeBlock || (isSourceCodeLang && primaryCodeBlock.lang === 'code')) {
        const isShellLang = /^(bash|sh|zsh|shell|cmd|powershell|ps1)$/i.test(lang);
        primaryCodeBlock = {
          lang: lang.toUpperCase(),
          codeBody,
          context: isShellLang ? undefined : runningCtx ? { ...runningCtx } : sourceRefs[0],
        };
        if (isSourceCodeLang) break;
      }
    } else {
      for (const l of seg.split('\n')) {
        runningCtx = extractLatestSourceRefFromText(l.trim(), runningCtx, workspaceFiles);
      }
    }
  }

  return { conclusionLines, sourceRefs, primaryCodeBlock };
}

export function getFileVisualMeta(filePath: string): {
  badge: string;
  color: string;
  language: string;
} {
  const clean = (filePath || '').toLowerCase();
  const ext = clean.includes('.') ? clean.split('.').pop() || '' : '';
  switch (ext) {
    case 'ts':
      return { badge: 'TS', color: '#3b82f6', language: 'TypeScript' };
    case 'tsx':
      return { badge: 'TSX', color: '#38bdf8', language: 'TypeScript React' };
    case 'js':
    case 'mjs':
    case 'cjs':
      return { badge: 'JS', color: '#eab308', language: 'JavaScript' };
    case 'jsx':
      return { badge: 'JSX', color: '#22d3ee', language: 'JavaScript React' };
    case 'html':
    case 'htm':
      return { badge: 'HTM', color: '#f97316', language: 'HTML' };
    case 'css':
    case 'scss':
    case 'less':
      return { badge: '#', color: '#06b6d4', language: 'CSS' };
    case 'json':
      return { badge: '{}', color: '#f59e0b', language: 'JSON' };
    case 'md':
    case 'mdx':
      return { badge: 'MD', color: '#a855f7', language: 'Markdown' };
    case 'py':
      return { badge: 'PY', color: '#3b82f6', language: 'Python' };
    case 'sh':
    case 'bash':
    case 'ps1':
    case 'cmd':
      return { badge: '$_', color: '#10b981', language: 'Shell' };
    case 'yml':
    case 'yaml':
      return { badge: 'YML', color: '#ec4899', language: 'YAML' };
    case 'ico':
      return { badge: 'ICO', color: '#f59e0b', language: 'Icon File' };
    case 'png':
      return { badge: 'PNG', color: '#10b981', language: 'PNG Image' };
    case 'jpg':
    case 'jpeg':
      return { badge: 'JPG', color: '#06b6d4', language: 'JPEG Image' };
    case 'gif':
      return { badge: 'GIF', color: '#ec4899', language: 'GIF Image' };
    case 'webp':
      return { badge: 'WEBP', color: '#38bdf8', language: 'WebP Image' };
    case 'svg':
      return { badge: 'SVG', color: '#f97316', language: 'SVG Vector' };
    case 'bmp':
      return { badge: 'BMP', color: '#8b5cf6', language: 'Bitmap Image' };
    default:
      return {
        badge: (ext || 'FILE').toUpperCase().slice(0, 3),
        color: '#94a3b8',
        language: ext ? ext.toUpperCase() : 'Plain Text',
      };
  }
}

export function renderSyntaxHighlightedLine(
  line: string,
  lineIdx: number,
  isActiveLine: boolean,
  diffKind?: DiffLineKind,
  ghostText?: string
): React.ReactNode {
  const diffClass =
    diffKind === 'add' ? 'diff-add' : diffKind === 'mod' ? 'diff-mod' : '';
  const trimmed = line.trim();
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('<!--')
  ) {
    return (
      <div
        key={lineIdx}
        className={`ag-code-line ${isActiveLine ? 'active' : ''} ${diffClass}`.trim()}
      >
        <span className="tok-comment">{line || ' '}</span>
      </div>
    );
  }

  const tokenRegex =
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*$|<!--[\s\S]*?-->|<\/?[a-zA-Z0-9-]+|\b(?:import|export|from|const|let|var|function|return|async|await|if|else|for|while|switch|case|break|continue|try|catch|finally|new|class|interface|type|extends|implements|true|false|null|undefined|void|typeof|in|of)\b|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms)?\b|\b[a-zA-Z_$][\w$]*(?=\s*\())/g;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let tokIdx = 0;

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }
    const token = match[0];
    let cls = 'tok-kw';
    if (token.startsWith('//') || token.startsWith('<!--')) {
      cls = 'tok-comment';
    } else if (
      token.startsWith('"') ||
      token.startsWith("'") ||
      token.startsWith('`')
    ) {
      cls = 'tok-str';
    } else if (token.startsWith('<')) {
      cls = 'tok-tag';
    } else if (/^\d/.test(token)) {
      cls = 'tok-num';
    } else if (
      /^(import|export|from|const|let|var|function|return|async|await|if|else|for|while|switch|case|break|continue|try|catch|finally|new|class|interface|type|extends|implements|true|false|null|undefined|void|typeof|in|of)$/.test(
        token
      )
    ) {
      cls = 'tok-kw';
    } else {
      cls = 'tok-fn';
    }
    parts.push(
      <span key={tokIdx++} className={cls}>
        {token}
      </span>
    );
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }

  return (
    <div
      key={lineIdx}
      className={`ag-code-line ${isActiveLine ? 'active' : ''} ${diffClass}`.trim()}
    >
      {parts.length > 0 ? parts : ' '}
      {isActiveLine && ghostText && (
        <span className="ag-ghost-text">
          {ghostText} <span className="ag-ghost-hint">Tab ⇥</span>
        </span>
      )}
    </div>
  );
}

