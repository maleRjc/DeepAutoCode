/**
 * Plan/readonly shell command blacklist (adapted from Cline command-guard).
 * Blocks common file-mutating shells while allowing investigation commands.
 * Not a full shell interpreter — easy to extend.
 */

const BLOCKED_COMMANDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'mv',
  'cp',
  'dd',
  'touch',
  'mkdir',
  'ln',
  'link',
  'chmod',
  'chown',
  'chgrp',
  'truncate',
  'shred',
  'install',
  'patch',
  'rsync',
  'mkfifo',
  'mknod',
  'del',
  'erase',
  'move',
  'ren',
  'rename',
  'md',
  'rd',
  'mklink',
  'copy',
  'xcopy',
  'robocopy',
  'new-item',
  'ni',
  'remove-item',
  'move-item',
  'copy-item',
  'rename-item',
  'set-content',
  'add-content',
  'clear-content',
  'out-file',
  'mi',
  'ri',
  'cpi',
  'rni',
  'ac',
  'clc',
  'tee-object',
]);

const GIT_MUTATING = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'init',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'submodule',
  'switch',
  'worktree',
]);

const PM_MUTATING = new Set([
  'install',
  'i',
  'ci',
  'add',
  'remove',
  'rm',
  'uninstall',
  'unlink',
  'link',
  'update',
  'up',
  'upgrade',
  'dedupe',
  'prune',
  'publish',
  'require',
]);

const BLOCKED_SUBCOMMANDS: Record<string, Set<string>> = {
  git: GIT_MUTATING,
  npm: PM_MUTATING,
  pnpm: PM_MUTATING,
  yarn: PM_MUTATING,
  bun: PM_MUTATING,
  pip: new Set(['install', 'uninstall', 'add', 'remove']),
  pip3: new Set(['install', 'uninstall', 'add', 'remove']),
  cargo: new Set(['add', 'remove', 'rm', 'install', 'uninstall', 'update', 'new', 'init', 'publish']),
  apt: PM_MUTATING,
  'apt-get': PM_MUTATING,
  brew: PM_MUTATING,
  winget: new Set(['install', 'uninstall', 'upgrade']),
};

const READ_ONLY_GIT_FORMS: Record<string, Set<string>> = {
  stash: new Set(['list', 'show']),
  worktree: new Set(['list']),
  submodule: new Set(['status', 'summary']),
};

const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'builtin',
  'nohup',
  'time',
  'nice',
  'timeout',
  'xargs',
]);

const RESERVED_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'do',
  'done',
  'for',
  'case',
  'esac',
  '!',
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

function normalizeCommandName(word: string): string {
  const base = word.replace(/["']/g, '').split(/[/\\]/).pop() ?? word;
  return base.toLowerCase().replace(/\.exe$/, '');
}

function maskNonCommandText(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  let heredocDelimiter: string | undefined;
  for (const line of lines) {
    if (heredocDelimiter !== undefined) {
      if (line.replace(/^\t+/, '') === heredocDelimiter) heredocDelimiter = undefined;
      continue;
    }
    kept.push(line);
    const heredoc = line.match(/(?<![<])<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+))/);
    if (heredoc) heredocDelimiter = heredoc[1] ?? heredoc[2] ?? heredoc[3];
  }
  return kept
    .join('\n')
    .replace(/\$\(\([\s\S]*?\)\)/g, '_')
    .replace(/\\./g, '_')
    .replace(/"[^"]*"|'[^']*'/g, (span) => span.replace(/[\s<>|;&$()`#\\]/g, '_'))
    .replace(/(?:^|\s)#.*$/gm, ' ');
}

function normalizeRedirectTarget(rawTarget: string): string {
  return rawTarget
    .replace(/["']/g, '')
    .replace(/[)\]}>,;]+$/g, '')
    .trim();
}

function isAllowedRedirectTarget(rawTarget: string): boolean {
  const target = normalizeRedirectTarget(rawTarget);
  if (/^(\/dev\/(null|stdout|stderr|tty)|nul:?)$/i.test(target)) return true;
  if (target.includes('..')) return false;
  return (
    target.startsWith('/tmp/') ||
    target.startsWith('/var/tmp/') ||
    target.startsWith('$TMPDIR') ||
    /^%te?mp%/i.test(target) ||
    /^\$env:te?mp/i.test(target)
  );
}

function checkTokens(tokens: string[]): string | undefined {
  let index = 0;
  while (
    index < tokens.length &&
    (ENV_ASSIGNMENT.test(tokens[index]) || RESERVED_WORDS.has(tokens[index]))
  ) {
    index += 1;
  }
  while (index < tokens.length && WRAPPERS.has(normalizeCommandName(tokens[index]))) {
    index += 1;
    while (
      index < tokens.length &&
      (tokens[index].startsWith('-') ||
        tokens[index] === '{}' ||
        ENV_ASSIGNMENT.test(tokens[index]) ||
        /^\d+[smhd]?$/.test(tokens[index]))
    ) {
      index += 1;
    }
  }
  if (index >= tokens.length) return undefined;

  const cmd = normalizeCommandName(tokens[index]);
  if (BLOCKED_COMMANDS.has(cmd)) {
    return `blocked command '${cmd}'`;
  }

  const subcommands = BLOCKED_SUBCOMMANDS[cmd];
  if (subcommands) {
    let subIndex = index + 1;
    while (subIndex < tokens.length && tokens[subIndex].startsWith('-')) subIndex += 1;
    const sub = (tokens[subIndex] || '').toLowerCase();
    if (sub && subcommands.has(sub)) {
      const readonlyForm = READ_ONLY_GIT_FORMS[sub];
      const next = (tokens[subIndex + 1] || '').toLowerCase();
      if (readonlyForm && readonlyForm.has(next)) {
        return undefined;
      }
      return `blocked '${cmd} ${sub}'`;
    }
  }

  // sed -i / perl -i / powershell Set-* already covered; catch common in-place editors
  if ((cmd === 'sed' || cmd === 'perl') && tokens.slice(index).some((t) => /^-i/.test(t))) {
    return `blocked in-place edit via '${cmd} -i'`;
  }

  return undefined;
}

/**
 * If the command looks like a file-mutating shell invocation, return a reason string.
 * Otherwise return undefined (allowed).
 */
export function findFileEditingCommand(command: string): string | undefined {
  const masked = maskNonCommandText(String(command || ''));
  if (!masked.trim()) return undefined;

  // File redirects (except /dev/null and temp)
  const redirectRe = /(?:^|[\s;&|])(?:\d*)>{1,2}\s*([^\s|&;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirectRe.exec(masked))) {
    if (!isAllowedRedirectTarget(m[1])) {
      return `blocked file redirect to '${m[1]}'`;
    }
  }

  const parts = masked.split(/(?:&&|\|\||;|\n|\|(?!\|))/);
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const hit = checkTokens(tokens);
    if (hit) return hit;
  }
  return undefined;
}

export function formatPlanModeBlockedCommandError(reason: string): string {
  return (
    `PLAN_MODE_COMMAND_BLOCKED: ${reason}. ` +
    `Plan/read-only mode allows investigation shells (ls/cat/git status/npm test) but not file mutations. ` +
    `Switch to Auto/Manual, or use edit_file / apply_patch after leaving Plan.`
  );
}

/** Cap shell churn in Plan/read-only turns (stops 50+ rg/grep loops with no deliverable). */
export const PLAN_MODE_MAX_SHELL_CALLS_PER_TURN = 14;

export function planModeShellBudgetExceeded(
  isPlanOrReadOnly: boolean,
  shellCallCount: number
): string | undefined {
  if (!isPlanOrReadOnly) return undefined;
  if (shellCallCount <= PLAN_MODE_MAX_SHELL_CALLS_PER_TURN) return undefined;
  return (
    `PLAN_SHELL_BUDGET_EXCEEDED: Plan/read-only allows at most ${PLAN_MODE_MAX_SHELL_CALLS_PER_TURN} ` +
    `shell commands per user message (current: ${shellCallCount}). ` +
    `Use search_codebase / read_file with line ranges instead of more grep loops. ` +
    `To generate PDF/Markdown in the workspace, switch Composer to Auto (not Plan).`
  );
}

export function assertCommandAllowedInPlanMode(command: string): void {
  const reason = findFileEditingCommand(command);
  if (reason) {
    throw new Error(formatPlanModeBlockedCommandError(reason));
  }
}
