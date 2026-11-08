/**
 * Hard permission rules inspired by OpenCode's allow|deny|ask model.
 * Soft markdown rules remain prompt-only; structured forbid/ask directives
 * here beat Auto allowlists at the policy gate.
 */

export type PermissionEffect = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  /** Tool/capability action pattern (glob-ish). Examples: write, edit, shell, delete, star */
  action: string;
  /** Path or command resource pattern. Examples: ".env*", "rm -rf*", or star for any */
  resource: string;
  effect: PermissionEffect;
  /** Origin rule file for audit / UI */
  source?: string;
  reason?: string;
}

export type PermissionRuleset = PermissionRule[];

export interface PermissionDecision {
  effect: PermissionEffect;
  matched?: PermissionRule;
  reason: string;
}

const ACTION_ALIASES: Record<string, string[]> = {
  write: ['write', 'write_file', 'write-file', 'editor'],
  edit: ['edit', 'edit_file', 'apply_patch', 'editor'],
  delete: ['delete', 'delete_file', 'rm'],
  shell: ['shell', 'run_command', 'run_commands', 'run-build', 'auto_build_and_test'],
  read: ['read', 'read_file', 'read_files', 'outline_file', 'list_files', 'search_codebase', 'explore_codebase'],
};

/**
 * Convert simple glob (* / **) to RegExp.
 * Both * and ** match across path segments and spaces (command + path friendly).
 */
export function globToRegExp(pattern: string): RegExp {
  const src = String(pattern || '*').trim() || '*';
  let out = '^';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '*' && src[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out, 'i');
}

export function matchGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(String(value || ''));
}

function expandAction(action: string): string[] {
  const key = String(action || '').trim().toLowerCase();
  if (!key || key === '*') return ['*'];
  return ACTION_ALIASES[key] ?? [key];
}

export function actionMatches(ruleAction: string, toolAction: string): boolean {
  const tool = String(toolAction || '').trim().toLowerCase();
  for (const cand of expandAction(ruleAction)) {
    if (cand === '*' || matchGlob(cand, tool)) return true;
  }
  return false;
}

/**
 * Last matching rule wins (OpenCode-style).
 */
export function evaluatePermissionRules(
  action: string,
  resource: string,
  ruleset: PermissionRuleset
): PermissionDecision {
  const rules = Array.isArray(ruleset) ? ruleset : [];
  let matched: PermissionRule | undefined;
  for (const rule of rules) {
    if (!actionMatches(rule.action, action)) continue;
    if (!matchGlob(rule.resource || '*', resource || '*')) continue;
    matched = rule;
  }
  if (!matched) {
    return {
      effect: 'allow',
      reason: 'no matching hard rule',
    };
  }
  return {
    effect: matched.effect,
    matched,
    reason:
      matched.reason ||
      `rule ${matched.effect}: ${matched.action} ${matched.resource}` +
        (matched.source ? ` (${matched.source})` : ''),
  };
}

function pushRule(
  out: PermissionRuleset,
  partial: Omit<PermissionRule, 'effect'> & { effect?: PermissionEffect },
  defaultEffect: PermissionEffect
): void {
  const action = String(partial.action || '').trim();
  const resource = String(partial.resource || '*').trim() || '*';
  if (!action) return;
  out.push({
    action,
    resource,
    effect: partial.effect || defaultEffect,
    source: partial.source,
    reason: partial.reason,
  });
}

/**
 * Parse YAML-ish frontmatter permission blocks:
 *
 * permissions:
 *   - action: write
 *     resource: ".env*"
 *     effect: deny
 * forbid:
 *   - write secrets/*
 *   - shell rm -rf*
 * ask:
 *   - shell npm publish*
 */
export function parsePermissionFrontmatter(
  frontmatter: string,
  source?: string
): PermissionRuleset {
  const fm = String(frontmatter || '');
  const out: PermissionRuleset = [];

  // Block form: permissions: / forbid: / ask:
  const blockRe =
    /^(permissions|forbid|deny|ask)\s*:\s*\n((?:[ \t]+-[^\n]*\n?|[ \t]+(?:action|resource|effect)\s*:[^\n]*\n?)*)/gim;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(fm))) {
    const kind = blockMatch[1].toLowerCase();
    const body = blockMatch[2] || '';
    const defaultEffect: PermissionEffect =
      kind === 'ask' ? 'ask' : kind === 'permissions' ? 'deny' : 'deny';

    // Nested object items
    const itemChunks = body.split(/^[ \t]+-\s+/m).filter((s) => s.trim());
    for (const chunk of itemChunks) {
      const actionMatch = chunk.match(/action\s*:\s*["']?([^\n"']+)/i);
      const resourceMatch = chunk.match(/resource\s*:\s*["']?([^\n"']+)/i);
      const effectMatch = chunk.match(/effect\s*:\s*["']?(allow|deny|ask)/i);
      if (actionMatch) {
        pushRule(
          out,
          {
            action: actionMatch[1].trim(),
            resource: resourceMatch?.[1]?.trim() || '*',
            effect: (effectMatch?.[1]?.toLowerCase() as PermissionEffect) || defaultEffect,
            source,
          },
          defaultEffect
        );
        continue;
      }
      // Shorthand list item: "- write .env*" or "- shell rm -rf*"
      const line = chunk.split(/\n/)[0]?.trim() || '';
      const shorthand = parseShorthandDirective(line, defaultEffect, source);
      if (shorthand) out.push(shorthand);
    }
  }

  // Inline lines anywhere in frontmatter: forbid: write x / ask: shell y
  for (const rawLine of fm.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = /^(forbid|deny|ask)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    if (m[2].startsWith('-') || m[2] === '') continue; // block header already handled
    const effect: PermissionEffect = m[1].toLowerCase() === 'ask' ? 'ask' : 'deny';
    const shorthand = parseShorthandDirective(m[2], effect, source);
    if (shorthand) out.push(shorthand);
  }

  return out;
}

function parseShorthandDirective(
  text: string,
  effect: PermissionEffect,
  source?: string
): PermissionRule | null {
  const cleaned = String(text || '')
    .replace(/^-\s*/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/\s+/);
  const action = parts[0] || '*';
  const resource = parts.slice(1).join(' ').trim() || '*';
  return { action, resource, effect, source };
}

/**
 * Extract hard rules from free-form rule markdown body (lines starting with forbid:/ask:/deny:).
 */
export function parsePermissionBodyLines(
  body: string,
  source?: string
): PermissionRuleset {
  const out: PermissionRuleset = [];
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = /^(?:[-*]\s*)?(forbid|deny|ask)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const effect: PermissionEffect = m[1].toLowerCase() === 'ask' ? 'ask' : 'deny';
    const shorthand = parseShorthandDirective(m[2], effect, source);
    if (shorthand) out.push(shorthand);
  }
  return out;
}

export function compileRulesFromDocuments(
  docs: Array<{ path?: string; raw?: string; content?: string; name?: string }>
): PermissionRuleset {
  const out: PermissionRuleset = [];
  for (const doc of docs) {
    const raw = String(doc.raw ?? doc.content ?? '');
    const source = doc.path || doc.name || 'rule';
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fmMatch) {
      out.push(...parsePermissionFrontmatter(fmMatch[1], source));
      out.push(...parsePermissionBodyLines(raw.slice(fmMatch[0].length), source));
    } else {
      out.push(...parsePermissionBodyLines(raw, source));
    }
  }
  return out;
}

/** Map high-level tool / capability names to permission action buckets. */
export function toolNameToAction(toolName: string): string {
  const n = String(toolName || '').toLowerCase();
  if (/write|create/.test(n)) return 'write';
  if (/edit|patch|editor/.test(n)) return 'edit';
  if (/delete|unlink|rm\b/.test(n)) return 'delete';
  if (/run|shell|build|test|command|ssh/.test(n)) return 'shell';
  if (/read|outline|list|search|explore|open/.test(n)) return 'read';
  return n || '*';
}

export function resolveToolResource(params: {
  toolName: string;
  targetPath?: string;
  command?: string;
  args?: Record<string, unknown>;
}): string {
  if (params.targetPath) return params.targetPath.replace(/\\/g, '/');
  if (params.command) return params.command;
  const args = params.args || {};
  const filePath = args.filePath || args.path || args.target;
  if (typeof filePath === 'string' && filePath.trim()) {
    return filePath.replace(/\\/g, '/');
  }
  if (typeof args.command === 'string') return args.command;
  return '*';
}
