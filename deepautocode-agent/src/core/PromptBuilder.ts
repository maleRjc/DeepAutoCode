import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface WorkspaceRule {
  name: string;
  path: string;
  content: string;
  // Cursor-style path globs (e.g. ** / *.ts). Empty + alwaysApply=false → always include for compat.
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
}

export interface WorkspaceCustomizations {
  rules: WorkspaceRule[];
  skills: Array<{ name: string; description: string; path: string; content?: string }>;
  workflows: Array<{ name: string; description: string; path: string }>;
}

/** Parse Cursor .mdc / markdown frontmatter (globs, alwaysApply, description). */
export function parseRuleFrontmatter(raw: string): {
  body: string;
  globs: string[];
  alwaysApply: boolean;
  description?: string;
} {
  const text = String(raw || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { body: text, globs: [], alwaysApply: true };
  }
  const fm = match[1];
  const body = match[2] || '';
  const globs: string[] = [];
  let alwaysApply = false;
  let description: string | undefined;
  const alwaysMatch = fm.match(/^\s*alwaysApply:\s*(true|false)\s*$/im);
  if (alwaysMatch) alwaysApply = alwaysMatch[1].toLowerCase() === 'true';
  const descMatch = fm.match(/^\s*description:\s*(.+)\s*$/im);
  if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
  const globsLine = fm.match(/^\s*globs:\s*(.+)\s*$/im);
  if (globsLine) {
    const rawGlobs = globsLine[1].trim();
    if (rawGlobs.startsWith('[')) {
      try {
        const arr = JSON.parse(rawGlobs.replace(/'/g, '"'));
        if (Array.isArray(arr)) globs.push(...arr.map((g) => String(g).trim()).filter(Boolean));
      } catch {
        // fall through
      }
    } else {
      globs.push(
        ...rawGlobs
          .split(/[,]+/)
          .map((g) => g.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
      );
    }
  }
  // Multi-line YAML list: globs:\n  - **/*.ts
  const listBlock = fm.match(/^\s*globs:\s*\r?\n((?:\s*-\s*.+\r?\n?)+)/im);
  if (listBlock) {
    for (const line of listBlock[1].split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*(.+)\s*$/);
      if (m) globs.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  // No globs and no alwaysApply key → treat as always (legacy .md rules)
  if (globs.length === 0 && !/^\s*alwaysApply:/im.test(fm)) {
    alwaysApply = true;
  }
  return { body, globs: [...new Set(globs)], alwaysApply, description };
}

/** Convert a simple glob (**, *, ?) to RegExp matching posix-relative paths. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').trim();
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i += 1;
      if (g[i + 1] === '/') i += 1; // absorb **/
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      continue;
    }
    if ('+|()[]{}^$.\\'.includes(c)) {
      re += `\\${c}`;
      continue;
    }
    re += c;
  }
  return new RegExp(`^${re}$`, 'i');
}

export function pathMatchesGlobs(relPath: string, globs: string[]): boolean {
  if (!globs.length) return true;
  const norm = relPath.replace(/\\/g, '/').replace(/^\.?\//, '');
  return globs.some((g) => globToRegExp(g).test(norm));
}

/**
 * Filter rules for the current turn:
 * - alwaysApply / no-globs → always
 * - globbed rules → only when an active path matches
 * - Stage S: when path context exists, unmatched globbed rules are dropped
 * - when no path context: keep alwaysApply + unglobbed only (strict; avoids injecting all globs blindly)
 */
export function filterRulesForPaths(
  rules: WorkspaceRule[],
  activePaths: string[] = []
): WorkspaceRule[] {
  const paths = activePaths.map((p) => p.replace(/\\/g, '/').replace(/^\.?\//, ''));
  return rules.filter((r) => {
    if (r.alwaysApply || !r.globs || r.globs.length === 0) return true;
    if (paths.length === 0) return false;
    return paths.some((p) => pathMatchesGlobs(p, r.globs || []));
  });
}

/**
 * Stage S: catalog-only by default; expand full SKILL.md when mentioned / relevant.
 */
export function selectSkillsForPrompt(
  skills: Array<{ name: string; description: string; path: string; content?: string }>,
  options?: { prompt?: string; expandNames?: string[] }
): Array<{ name: string; description: string; path: string; content?: string; expanded: boolean }> {
  const prompt = String(options?.prompt || '');
  const expand = new Set(
    (options?.expandNames || []).map((n) => n.toLowerCase()).filter(Boolean)
  );
  // @skill or @skill:name or bare skill name after @skill
  const skillMentions = [
    ...prompt.matchAll(/(?:^|\s)@skill(?::([A-Za-z0-9_.-]+))?\b/gi),
  ];
  for (const m of skillMentions) {
    if (m[1]) expand.add(m[1].toLowerCase());
    else {
      // bare @skill → expand all when few skills; otherwise leave catalog
      if (skills.length <= 3) skills.forEach((s) => expand.add(s.name.toLowerCase()));
    }
  }
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const s of skills) {
    if (new RegExp(`(?:^|\\s)@${escapeRe(s.name)}\\b`, 'i').test(prompt)) {
      expand.add(s.name.toLowerCase());
    }
    // Soft relevance: skill name appears as whole word in prompt
    if (
      expand.size < 2 &&
      s.name.length >= 3 &&
      new RegExp(`\\b${escapeRe(s.name)}\\b`, 'i').test(prompt)
    ) {
      expand.add(s.name.toLowerCase());
    }
  }
  return skills.map((s) => ({
    ...s,
    // Only attach body when expanded — catalog stays name/description
    content: expand.has(s.name.toLowerCase()) ? s.content : undefined,
    expanded: expand.has(s.name.toLowerCase()),
  }));
}

export interface WorkspaceInfo {
  rootPath: string;
  workspaceRoot?: string;
  hint?: string;
  topEntries?: string[];
  buildProfileHint?: string;
  platform?: string;
  planModeSwitchTool?: boolean;
  customizations?: WorkspaceCustomizations;
}

export async function discoverWorkspaceCustomizations(
  workspaceRoot: string
): Promise<WorkspaceCustomizations> {
  const resolved = path.resolve(workspaceRoot);
  const rules: WorkspaceRule[] = [];
  const skills: Array<{ name: string; description: string; path: string; content?: string }> =
    [];
  const workflows: Array<{ name: string; description: string; path: string }> = [];

  const pushRule = (name: string, relPath: string, raw: string) => {
    const parsed = parseRuleFrontmatter(raw);
    const body = parsed.body.trim() ? parsed.body : raw;
    if (!body.trim()) return;
    rules.push({
      name,
      path: relPath.replace(/\\/g, '/'),
      content: body.slice(0, 6000),
      globs: parsed.globs,
      alwaysApply: parsed.alwaysApply,
      description: parsed.description,
    });
  };

  // 1. Discover top-level AGENTS.md / CLAUDE.md / .cursorrules
  for (const rootRuleFile of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    try {
      const fullPath = path.join(resolved, rootRuleFile);
      const raw = await fs.readFile(fullPath, 'utf-8');
      if (raw.trim()) {
        pushRule(rootRuleFile, rootRuleFile, raw);
      }
    } catch {
      // ignore missing file
    }
  }

  // 2. Discover .agents/rules/*.md
  try {
    const rulesDir = path.join(resolved, '.agents', 'rules');
    const entries = await fs.readdir(rulesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.(?:md|txt|mdc)$/i.test(entry.name)) {
        try {
          const fullPath = path.join(rulesDir, entry.name);
          const raw = await fs.readFile(fullPath, 'utf-8');
          pushRule(
            entry.name.replace(/\.(?:md|txt|mdc)$/i, ''),
            `.agents/rules/${entry.name}`,
            raw
          );
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore missing .agents/rules
  }

  // 2a. Discover .cursor/rules/** (Cursor parity — globs / alwaysApply)
  try {
    const cursorRulesDir = path.join(resolved, '.cursor', 'rules');
    const walk = async (dir: string, relBase: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = path.posix.join(relBase, entry.name);
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, rel);
        } else if (entry.isFile() && /\.(?:md|mdc|txt)$/i.test(entry.name)) {
          try {
            const raw = await fs.readFile(full, 'utf-8');
            if (raw.trim()) {
              pushRule(
                entry.name.replace(/\.(?:md|mdc|txt)$/i, ''),
                rel.replace(/\\/g, '/'),
                raw
              );
            }
          } catch {
            // ignore
          }
        }
      }
    };
    await walk(cursorRulesDir, '.cursor/rules');
  } catch {
    // ignore missing .cursor/rules
  }

  // 2b. IDE Settings — User Rules (always apply) + Project Rules
  try {
    const userRulesPath = path.join(resolved, '.deepautocode', 'user-rules.md');
    const raw = await fs.readFile(userRulesPath, 'utf-8');
    if (raw.trim()) {
      const parsed = parseRuleFrontmatter(raw);
      rules.push({
        name: 'user-rules',
        path: '.deepautocode/user-rules.md',
        content: (parsed.body.trim() ? parsed.body : raw).slice(0, 6000),
        globs: [],
        alwaysApply: true,
        description: 'User Rules (global)',
      });
    }
  } catch {
    // ignore
  }
  try {
    const ideRulesPath = path.join(resolved, '.deepautocode', 'project-rules.md');
    const raw = await fs.readFile(ideRulesPath, 'utf-8');
    if (raw.trim()) {
      pushRule('ide-project-rules', '.deepautocode/project-rules.md', raw);
    }
  } catch {
    // ignore missing IDE project rules
  }

  // 3. Discover .agents/skills/<skill>/SKILL.md
  try {
    const skillsDir = path.join(resolved, '.agents', 'skills');
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdRel = `.agents/skills/${entry.name}/SKILL.md`;
        try {
          const raw = await fs.readFile(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf-8');
          const descMatch = raw.match(/description:\s*([^\r\n]+)/i);
          skills.push({
            name: entry.name,
            description: descMatch?.[1]?.trim() || `Workspace skill (${entry.name})`,
            path: skillMdRel,
            content: raw.slice(0, 8000),
          });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore missing .agents/skills
  }

  // 4. Discover .agents/workflows/*.md
  try {
    const wfDir = path.join(resolved, '.agents', 'workflows');
    const entries = await fs.readdir(wfDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          const raw = await fs.readFile(path.join(wfDir, entry.name), 'utf-8');
          const descMatch = raw.match(/description:\s*([^\r\n]+)/i);
          workflows.push({
            name: `/${entry.name.replace(/\.md$/i, '')}`,
            description: descMatch?.[1]?.trim() || `Custom workflow (${entry.name})`,
            path: `.agents/workflows/${entry.name}`,
          });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  return { rules, skills, workflows };
}

export async function generateWorkspaceInfo(workspaceRoot: string): Promise<WorkspaceInfo> {
  const resolved = path.resolve(workspaceRoot);
  let topEntries: string[] = [];
  const buildFiles: string[] = [];

  const buildMarkers = [
    'Makefile',
    'makefile',
    'CMakeLists.txt',
    'package.json',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
  ];

  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    topEntries = entries
      .filter((e) => !['node_modules', '.git', 'dist', '.deepautocode-data'].includes(e.name))
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

    for (const marker of buildMarkers) {
      if (entries.some((e) => e.isFile() && e.name === marker)) {
        buildFiles.push(marker);
      }
    }

    // Check 1-level subdirectories for subproject Makefiles / package.json (e.g. nccl-test/Makefile)
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !['node_modules', '.git', 'dist', 'build', '.deepautocode-data'].includes(entry.name)
      ) {
        try {
          const subEntries = await fs.readdir(path.join(resolved, entry.name));
          for (const marker of buildMarkers) {
            if (subEntries.includes(marker)) {
              buildFiles.push(`${entry.name}/${marker}`);
            }
          }
        } catch {
          // ignore unreadable subdir
        }
      }
    }
  } catch {
    topEntries = [];
  }

  const customizations = await discoverWorkspaceCustomizations(resolved).catch(() => ({
    rules: [],
    skills: [],
    workflows: [],
  }));

  return {
    rootPath: resolved,
    workspaceRoot: resolved,
    hint: path.basename(resolved),
    topEntries,
    buildProfileHint: buildFiles.length > 0 ? buildFiles.join(', ') : undefined,
    platform: process.platform,
    customizations,
  };
}

export function expandSlashCommandPrompt(rawPrompt: string): {
  expandedPrompt: string;
  slashCommand?: string;
  suggestedMode?: 'plan' | 'auto';
} {
  const trimmed = rawPrompt.trim();
  const match = trimmed.match(/^\/(plan|goal|fix|review|test|compact|learn|browser)\b\s*([\s\S]*)$/i);
  if (!match) {
    return { expandedPrompt: rawPrompt };
  }
  const cmd = match[1].toLowerCase();
  const rest = match[2].trim();

  switch (cmd) {
    case 'plan':
      return {
        slashCommand: '/plan',
        suggestedMode: 'plan',
        expandedPrompt:
          `[Antigravity /plan Workflow — Architectural & Step-by-Step Implementation Plan]\n` +
          `User Request: ${rest || 'Analyze the current workspace and create an implementation plan.'}\n\n` +
          `Instructions:\n` +
          `1. Inspect relevant workspace files using read_file / outline_file / search_codebase.\n` +
          `2. Call 'write_artifact' with artifactType="plan" and title="Implementation Plan" to persist a structured step-by-step plan (including target files, root-cause/design analysis, and verification steps).\n` +
          `3. Summarize the plan clearly so the user can click "Proceed & Execute Plan".`,
      };
    case 'goal':
      return {
        slashCommand: '/goal',
        suggestedMode: 'auto',
        expandedPrompt:
          `[FORCE_AUTO_ACTION] [Antigravity /goal Autonomous Loop]\n` +
          `Goal: ${rest || 'Complete the engineering goal end-to-end and verify with build & tests.'}\n` +
          `Do not stop until all required code changes are applied via edit_file/write_file, the project compiles with 0 errors, and verification tests pass. Also record progress using 'write_artifact' (artifactType="task_list").`,
      };
    case 'fix':
      return {
        slashCommand: '/fix',
        suggestedMode: 'auto',
        expandedPrompt:
          `[FORCE_AUTO_ACTION] [Antigravity /fix Diagnostic Auto-Repair]\n` +
          `${rest || 'Inspect all compiler errors, failing tests, and code defects in the workspace, apply fixes directly via edit_file, and run build & verification tests until all checks pass.'}`,
      };
    case 'review':
      return {
        slashCommand: '/review',
        suggestedMode: 'plan',
        expandedPrompt:
          `[READ_ONLY_ANALYSIS] [Antigravity /review Code & Security Audit]\n` +
          `${rest || 'Review the active file and recent git diff for bugs, boundary conditions, concurrency hazards, and security issues. Provide exact file:line citations.'}`,
      };
    case 'test':
      return {
        slashCommand: '/test',
        suggestedMode: 'auto',
        expandedPrompt:
          `[FORCE_AUTO_ACTION] [Antigravity /test Verification & Test Suite]\n` +
          `${rest || 'Run the workspace test suite or generate verification tests for the active module, and fix any failures found.'}`,
      };
    case 'learn':
      return {
        slashCommand: '/learn',
        suggestedMode: 'auto',
        expandedPrompt:
          `[FORCE_AUTO_ACTION] [Antigravity /learn Workspace Rule & Skill Persistence]\n` +
          `Persist the following engineering rule/convention into '.agents/rules/project-conventions.md' using write_file:\n` +
          `${rest || 'Summarize the key architectural rules, build commands, and coding conventions of this repository into .agents/rules/project-conventions.md.'}`,
      };
    case 'compact':
      return {
        slashCommand: '/compact',
        suggestedMode: 'plan',
        expandedPrompt:
          `[READ_ONLY_ANALYSIS] Summarize our current session progress, modified files, and remaining tasks concisely so context stays compact. ${rest}`,
      };
    case 'browser':
      return {
        slashCommand: '/browser',
        suggestedMode: 'auto',
        expandedPrompt:
          `[Antigravity /browser Autonomous Web Inspection]\n` +
          `Target: ${rest || 'http://localhost:3000/'}\n\n` +
          `Instructions:\n` +
          `1. Call 'browser_action' with action="navigate" or "get_html" (target url "${rest || 'http://localhost:3000/'}") to inspect the page DOM, status, and interactive buttons.\n` +
          `2. Inspect any elements, links, or issues reported.\n` +
          `3. Report findings and suggest fixes for any frontend/API discrepancies found.`,
      };
    default:
      return { expandedPrompt: rawPrompt };
  }
}

/**
 * Load persisted IDE Problems (`.deepautocode/problems.json`) as prompt text.
 * Used by @problems mentions and automatic self-heal injection.
 */
export async function loadWorkspaceProblemsText(
  workspaceRoot: string,
  limit = 40
): Promise<string> {
  const candidates = [
    path.join(workspaceRoot, '.deepautocode', 'problems.json'),
    path.join(workspaceRoot, '.deepautocode-data', 'problems.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf-8');
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : parsed?.problems;
      if (Array.isArray(items) && items.length > 0) {
        return items
          .slice(0, limit)
          .map((d: any) => {
            const sev = String(d.severity || 'error').toUpperCase();
            const loc = `${d.file || '?'}:${d.line || 1}${d.column ? `:${d.column}` : ''}`;
            return `${sev} ${loc} [${d.source || 'build'}] ${d.message || ''}`;
          })
          .join('\n');
      }
    } catch {
      // try next
    }
  }
  return '';
}

export async function enrichPromptWithMentions(
  prompt: string,
  workspaceRoot: string,
  options?: {
    maxFiles?: number;
    maxFileBytes?: number;
    /** Current editor selection for @code */
    selectionSnippet?: string;
    selectionFile?: string;
    /** Open editor tabs for @tabs */
    openTabs?: Array<{ path: string; content?: string }>;
    /** Recent terminal digest for @terminal */
    terminalRecent?: string;
  }
): Promise<{ prompt: string; mentionedFiles: string[] }> {
  const maxFiles = options?.maxFiles ?? 5;
  const maxFileBytes = options?.maxFileBytes ?? 32000;
  const contextBlocks: string[] = [];
  const mentionedFiles: string[] = [];

  // 1. Check built-in Antigravity @git, @rules, @problems mentions
  if (/(?:^|\s)@git\b/i.test(prompt)) {
    try {
      const { stdout: statusOut } = await execAsync('git status -s', { cwd: workspaceRoot });
      const { stdout: diffOut } = await execAsync('git diff --stat', { cwd: workspaceRoot });
      contextBlocks.push(
        `\n<mentioned_git_context>\nGit Status:\n${statusOut.trim() || '(clean working tree)'}\n\nGit Diff Stat:\n${diffOut.trim() || '(no unstaged diff)'}\n</mentioned_git_context>`
      );
    } catch {
      // ignore if not a git repo
    }
  }

  if (/(?:^|\s)@rules\b/i.test(prompt)) {
    try {
      const cust = await discoverWorkspaceCustomizations(workspaceRoot);
      if (cust.rules.length > 0) {
        const rulesText = cust.rules
          .map((r) => `### ${r.name} (${r.path})\n${r.content}`)
          .join('\n\n');
        contextBlocks.push(`\n<mentioned_workspace_rules>\n${rulesText}\n</mentioned_workspace_rules>`);
      }
    } catch {
      // ignore
    }
  }

  // Stage W: @codebase → hybrid semantic + content retrieval for the free-text query
  if (/(?:^|\s)@codebase\b/i.test(prompt)) {
    try {
      const { WorkspaceFileIndex, searchIndexedFiles } = await import('./WorkspaceFileIndex.js');
      const q = prompt
        .replace(/(?:^|\s)@[a-zA-Z][\w:-]*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      if (q.length >= 2) {
        const index = new WorkspaceFileIndex(workspaceRoot, { ttlMs: 60_000, maxFiles: 8_000 });
        const sem = await searchIndexedFiles({
          root: workspaceRoot,
          index,
          query: q,
          mode: 'semantic',
          maxMatches: 12,
          contextLines: 1,
        });
        contextBlocks.push(
          `\n<mentioned_codebase_context query="${q.replace(/"/g, "'")}">\n${sem}\n</mentioned_codebase_context>`
        );
      }
    } catch {
      // ignore retrieval failures
    }
  }

  // Stage T: @docs → README / docs / USER-GUIDE style workspace docs
  if (/(?:^|\s)@docs\b/i.test(prompt)) {
    const docCandidates = [
      'README.md',
      'readme.md',
      'docs/USER-GUIDE.md',
      'docs/README.md',
      'AGENTS.md',
      'CONTRIBUTING.md',
    ];
    const docBlocks: string[] = [];
    for (const rel of docCandidates) {
      if (docBlocks.length >= 4) break;
      try {
        const full = path.join(workspaceRoot, rel);
        const raw = await fs.readFile(full, 'utf-8');
        if (raw.trim()) {
          docBlocks.push(`### ${rel}\n${raw.slice(0, 5000)}`);
          mentionedFiles.push(rel.replace(/\\/g, '/'));
        }
      } catch {
        // skip missing
      }
    }
    // Also pick up to 2 markdown files under docs/
    try {
      const docsDir = path.join(workspaceRoot, 'docs');
      const entries = await fs.readdir(docsDir);
      for (const name of entries) {
        if (docBlocks.length >= 5) break;
        if (!/\.md$/i.test(name)) continue;
        const rel = `docs/${name}`;
        if (mentionedFiles.includes(rel)) continue;
        try {
          const raw = await fs.readFile(path.join(docsDir, name), 'utf-8');
          if (raw.trim()) {
            docBlocks.push(`### ${rel}\n${raw.slice(0, 3500)}`);
            mentionedFiles.push(rel);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // no docs/
    }
    contextBlocks.push(
      `\n<mentioned_docs>\n${
        docBlocks.join('\n\n') || '(no README/docs markdown found)'
      }\n</mentioned_docs>`
    );
  }

  // Stage T: @web / @web:https://… → fetch public text (capped)
  const webMatches = [
    ...prompt.matchAll(/(?:^|\s)@web(?::|\s+)(https?:\/\/[^\s]+)/gi),
  ];
  if (webMatches.length > 0 || /(?:^|\s)@web\b/i.test(prompt)) {
    const urls = webMatches.map((m) => m[1].replace(/[)>,.\]]+$/, '')).slice(0, 2);
    const fetched: string[] = [];
    for (const url of urls) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const resp = await fetch(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'DeepAutoCode-Agent/1.0', Accept: 'text/*,application/json' },
        });
        clearTimeout(timer);
        const text = await resp.text();
        const clipped = text
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 6000);
        fetched.push(`### ${url}\nHTTP ${resp.status}\n${clipped || '(empty body)'}`);
      } catch (err) {
        fetched.push(`### ${url}\n(fetch failed: ${(err as Error).message})`);
      }
    }
    if (fetched.length === 0) {
      fetched.push(
        '(no URL provided — use @web https://example.com or @web:https://example.com)'
      );
    }
    contextBlocks.push(`\n<mentioned_web>\n${fetched.join('\n\n')}\n</mentioned_web>`);
  }

  // Stage S: @skill / @skill:name → inject full SKILL.md bodies on demand
  if (/(?:^|\s)@skill\b/i.test(prompt)) {
    try {
      const cust = await discoverWorkspaceCustomizations(workspaceRoot);
      const selected = selectSkillsForPrompt(cust.skills, { prompt });
      const expanded = selected.filter((s) => s.expanded && s.content?.trim());
      if (expanded.length > 0) {
        contextBlocks.push(
          `\n<mentioned_skills>\n${expanded
            .map((s) => `### ${s.name} (${s.path})\n${s.content!.slice(0, 6000)}`)
            .join('\n\n')}\n</mentioned_skills>`
        );
      } else if (cust.skills.length > 0) {
        contextBlocks.push(
          `\n<mentioned_skills_catalog>\n${cust.skills
            .map((s) => `- ${s.name}: ${s.description}`)
            .join('\n')}\n</mentioned_skills_catalog>`
        );
      }
    } catch {
      // ignore
    }
  }

  if (/(?:^|\s)@problems\b/i.test(prompt)) {
    const problemsText = await loadWorkspaceProblemsText(workspaceRoot, 40);
    contextBlocks.push(
      `\n<mentioned_workspace_problems>\n${
        problemsText || '(no persisted Problems panel diagnostics)'
      }\n</mentioned_workspace_problems>`
    );
  }

  if (/(?:^|\s)@terminal\b/i.test(prompt) && options?.terminalRecent) {
    contextBlocks.push(
      `\n<mentioned_terminal_output>\n${options.terminalRecent.slice(0, 6000)}\n</mentioned_terminal_output>`
    );
  }

  if (/(?:^|\s)@code\b/i.test(prompt) && options?.selectionSnippet) {
    contextBlocks.push(
      `\n<mentioned_code_selection file="${options.selectionFile || ''}">\n${options.selectionSnippet.slice(0, 4000)}\n</mentioned_code_selection>`
    );
  }

  if (/(?:^|\s)@tabs\b/i.test(prompt) && Array.isArray(options?.openTabs)) {
    const tabDigest = options!.openTabs!
      .slice(0, 8)
      .map((t) => {
        const body = (t.content || '').slice(0, 1800);
        return `### ${t.path}\n${body}`;
      })
      .join('\n\n');
    contextBlocks.push(`\n<mentioned_open_tabs>\n${tabDigest || '(no open tabs)'}\n</mentioned_open_tabs>`);
  }

  // @folder/path — attach directory listing (and shallow file previews)
  const folderMatches = Array.from(prompt.matchAll(/(?:^|\s)@folder\/([a-zA-Z0-9_./\\-]+)/gi));
  for (const m of folderMatches.slice(0, 3)) {
    const relDir = m[1].replace(/\\/g, '/').replace(/\/+$/, '');
    const absDir = path.resolve(workspaceRoot, relDir || '.');
    if (!absDir.startsWith(path.resolve(workspaceRoot))) continue;
    try {
      const entries = await fs.readdir(absDir, { withFileTypes: true });
      const listing = entries
        .filter((e) => !['node_modules', '.git', 'dist', 'build'].includes(e.name))
        .slice(0, 80)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n');
      contextBlocks.push(
        `\n<mentioned_folder path="${relDir || '.'}">\n${listing}\n</mentioned_folder>`
      );
    } catch {
      // ignore
    }
  }

  // 2. Check @file mentions
  const mentionRegex = /@([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)/g;
  const matches = Array.from(prompt.matchAll(mentionRegex));

  for (const m of matches) {
    if (mentionedFiles.length >= maxFiles) break;
    const relPath = m[1].replace(/\\/g, '/');
    if (mentionedFiles.includes(relPath)) continue;
    const absPath = path.resolve(workspaceRoot, relPath);
    if (!absPath.startsWith(path.resolve(workspaceRoot))) continue;
    try {
      const content = await fs.readFile(absPath, 'utf-8');
      mentionedFiles.push(relPath);
      contextBlocks.push(
        `\n<mentioned_file path="${relPath}">\n${content.slice(0, maxFileBytes)}\n</mentioned_file>`
      );
    } catch {
      // ignore missing file mention
    }
  }

  if (contextBlocks.length === 0) {
    return { prompt, mentionedFiles: [] };
  }

  return {
    prompt: `${prompt}\n${contextBlocks.join('\n')}`,
    mentionedFiles,
  };
}

/**
 * In-tree White-Box System Prompt Builder with Antigravity 4-Phase Scientific Debugging Protocol
 */
export function getClineDefaultSystemPrompt(
  info: WorkspaceInfo,
  options?: { activePaths?: string[]; prompt?: string; expandSkillNames?: string[] }
): string {
  const root = info.workspaceRoot || info.rootPath || '.';
  const entriesList =
    Array.isArray(info.topEntries) && info.topEntries.length > 0
      ? info.topEntries.join(', ')
      : info.hint || '';

  const activeRules = filterRulesForPaths(
    info.customizations?.rules || [],
    options?.activePaths || []
  );
  const customRulesSection =
    activeRules.length > 0
      ? `\n## Active Workspace Rules (.agents/rules, .cursor/rules, AGENTS.md, User/Project)\n` +
        activeRules
          .map((r) => {
            const meta = [
              r.alwaysApply ? 'alwaysApply' : null,
              r.globs?.length ? `globs: ${r.globs.join(', ')}` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return `### ${r.name} (${r.path}${meta ? ` · ${meta}` : ''})\n${r.content.slice(0, 2000)}`;
          })
          .join('\n\n')
      : '';

  // Stage S: catalog by default; expand bodies only when @skill / name match
  const selectedSkills = selectSkillsForPrompt(info.customizations?.skills || [], {
    prompt: options?.prompt,
    expandNames: options?.expandSkillNames,
  });
  const customSkillsSection =
    selectedSkills.length > 0
      ? `\n## Available Workspace Skills (.agents/skills)\n` +
        `Catalog only unless a skill is mentioned (@skill / @skill:name) or clearly relevant — then FOLLOW its SKILL.md steps exactly.\n` +
        selectedSkills
          .map((s) => {
            const body =
              s.expanded && s.content?.trim()
                ? `\n<details><summary>SKILL.md (expanded)</summary>\n\n${s.content.slice(0, 4000)}\n\n</details>`
                : ' _(catalog — mention @skill:' + s.name + ' to expand)_';
            return `- **${s.name}** (\`${s.path}\`): ${s.description}${body}`;
          })
          .join('\n')
      : '';

  return [
    `You are DeepAutoCode Agent (powered by the Antigravity Scientific Debugging & Engineering Engine).`,
    `Workspace Root: ${root}`,
    entriesList ? `Top-Level Workspace Contents: ${entriesList}` : '',
    info.buildProfileHint ? `Detected Build Configurations: ${info.buildProfileHint}` : '',
    customRulesSection,
    customSkillsSection,
    ``,
    `## Antigravity Agentic Capabilities (Artifacts, Subagents & Workflows)`,
    `- **Structured Artifacts ('write_artifact')**: When asked to create a plan ('/plan'), architectural walkthrough, or track a multi-step task checklist, call 'write_artifact' ({ artifactType: 'plan' | 'task_list' | 'walkthrough' | 'report', title, content }) so the IDE Artifacts Pane renders it with an interactive execution button.`,
    `- **Subagent Delegation ('invoke_subagent')**: For broad read-only codebase research or multi-file symbol exploration, call 'invoke_subagent' ({ role: 'research' | 'planner' | 'verifier' | 'editor', task, files, queries }). research/planner run a multi-round search→outline→read loop and return a capped evidence report; verifier runs diagnostics + verify; editor applies a budgeted isolated edit (max files/edits, rollback on diagnose fail).`,
    `- **Session Todos ('manage_todo')**: For multi-step goals, maintain a checklist via manage_todo ({ action: 'set'|'add'|'complete'|'list', items?/id?/content? }). Incomplete todos are re-injected on self-heal continuations.`,
    ``,
    `## Antigravity 4-Phase Scientific Problem-Solving Protocol`,
    `1. **Phase 1 — Batch Parallel Evidence Gathering & Function-Completeness Rule (并发精准取证与函数完整性铁律)**:`,
    `   - When investigating a bug, call multiple read-only tools IN PARALLEL in a single turn (e.g. combine 'search_codebase', 'outline_file', and 'read_file' with 'start_line'/'end_line' in one tool_calls array) rather than issuing 20 sequential single-line grep commands.`,
    `   - For large files (>400 lines, e.g. 'src/enqueue.cc'), use 'outline_file' or the automatic [文件符号大纲导航] from 'read_file'. Outline entries use 'Lstart-Lend: kind name' — pass those bounds directly to 'read_file({ filePath, start_line, end_line })'.`,
    `   - **FUNCTION-COMPLETENESS RULE (严禁函数读一半停下)**: When inspecting a suspect function (such as 'reduceCopy' in 'src/device/common_kernel.h', 'runSend'/'runRecv' in 'src/device/sendrecv.h', or 'scheduleP2pTasksToPlan' in 'src/enqueue.cc'), you MUST read the ENTIRE function from its signature all the way down to its closing brace '}'. NEVER stop at an early 'if (nBytesAhead == 0) return;' or mid-function line — always inspect the tail-handling branches, '#if 0 ... #endif' disabled code blocks, and 'FIXME' comments at the bottom of the function!`,
    `   - NEVER guess struct member names or helper function signatures, and NEVER ask the user to confirm them — call 'search_codebase' (which includes surrounding context lines) or 'read_file' on the header file to verify immediately.`,
    `2. **Phase 2 — Boundary-Value Math & Root-Cause Convergence (边界值数学推演与唯一根因收敛)**:`,
    `   - **BOUNDARY-VALUE & PACK-SIZE MATH**: When a test fails for specific sizes (e.g. 4B and 8B fail with '#wrong > 0', whereas 16B and 32B pass with '#wrong = 0'), immediately deduce the mathematical threshold (16 bytes = BigPackSize)! Trace what happens when 'nBytesAhead < 16': the 16-byte pack loop copies 0 packs ('nBytesAhead' remains 4 or 8), so execution MUST fall through to the tail loop ('BytePerPack = sizeof(T)') at the end of the function. Check immediately whether that tail loop is disabled by '#if 0' or skipped!`,
    `   - **INVARIANT CHECK BEFORE SKIPPING CALLS**: Before adding a 'continue' or early return in a scheduler loop (like 'scheduleP2pTasksToPlan'), check caller invariants (such as 'ncclLaunchPrepare' checking 'if (nWorkBudget == nWorkBudgetOld) return ncclInvalidUsage;').`,
    `   - Converge on the single best engineering fix backed by exact file & line evidence. Do NOT stop to present "Plan A / Plan B / Plan C" for the user to choose.`,
    `3. **Phase 3 — Surgical In-Place Code Modification (最小侵入式原地修改)**:`,
    `   - Immediately apply the fix in-place using 'edit_file' ({ filePath, oldText, newText }) or 'write_file' ({ filePath, content }).`,
    `4. **Phase 4 — Mandatory Build & Compiler-Driven Self-Healing (改后必编译验证与报错自愈)**:`,
    `   - Every code modification MUST be followed immediately by 'run_command' to compile (e.g. 'make -j16') and run the verification test suite.`,
    `   - If compilation or testing returns a non-zero exit code or '#wrong != 0', DO NOT stop or report failure to the user — read the compiler/test error output, fix the code via 'edit_file', and re-run 'run_command' in a self-healing loop until compilation succeeds and tests pass!`,
  ]
    .filter(Boolean)
    .join('\n');
}
