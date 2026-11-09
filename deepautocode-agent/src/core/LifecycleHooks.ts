import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { globToRegExp } from './PromptBuilder.js';

export type LifecycleHookEvent =
  | 'preToolUse'
  | 'postToolUse'
  | 'postFileEdit'
  | 'preVerify'
  | 'onSessionComplete';

export interface LifecycleHookRule {
  id?: string;
  event: LifecycleHookEvent;
  /** Optional regex/glob matching toolName (for *ToolUse) or filePath (for postFileEdit) */
  matcher?: string;
  /** Shell command to execute. Supports {{file}}, {{tool}}, {{sessionId}} placeholders. */
  command: string;
  /** When true, non-zero exit code blocks the action or injects a mandatory fix hint */
  blockOnFailure?: boolean;
  timeoutMs?: number;
  description?: string;
}

export interface LifecycleHooksConfig {
  hooks: LifecycleHookRule[];
}

export interface HookExecutionItemResult {
  id: string;
  event: LifecycleHookEvent;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  blocked: boolean;
}

export interface RunLifecycleHooksResult {
  ok: boolean;
  blocked: boolean;
  results: HookExecutionItemResult[];
  feedbackMessage?: string;
}

/**
 * Load `.deepautocode/hooks.json` or `.agents/hooks.json` from workspaceRoot.
 */
export async function loadLifecycleHooks(workspaceRoot: string): Promise<LifecycleHookRule[]> {
  const root = path.resolve(workspaceRoot);
  const candidates = [
    path.join(root, '.deepautocode', 'hooks.json'),
    path.join(root, '.agents', 'hooks.json'),
    path.join(root, '.agent', 'hooks.json'),
  ];

  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.hooks) ? parsed.hooks : [];
      const rules: LifecycleHookRule[] = [];
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const event = String(item.event || '').trim() as LifecycleHookEvent;
        const command = String(item.command || '').trim();
        if (!event || !command) continue;
        rules.push({
          id: item.id ? String(item.id) : `${event}:${command.slice(0, 32)}`,
          event,
          matcher: item.matcher ? String(item.matcher).trim() : undefined,
          command,
          blockOnFailure: Boolean(item.blockOnFailure),
          timeoutMs: typeof item.timeoutMs === 'number' ? item.timeoutMs : 15_000,
          description: item.description ? String(item.description) : undefined,
        });
      }
      return rules;
    } catch {
      // try next candidate
    }
  }
  return [];
}

function matchesHookTarget(matcher: string | undefined, target: string | undefined): boolean {
  if (!matcher || matcher === '*') return true;
  if (!target) return false;
  const normTarget = target.replace(/\\/g, '/');
  if (matcher.includes('*') || matcher.includes('?')) {
    return globToRegExp(matcher).test(normTarget);
  }
  try {
    return new RegExp(matcher, 'i').test(normTarget);
  } catch {
    return normTarget.toLowerCase().includes(matcher.toLowerCase());
  }
}

function executeSingleHookCommand(params: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawn(params.command, {
      cwd: params.cwd,
      env: params.env,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - start,
      });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        // ignore
      }
      stderr += `\nHook timed out after ${params.timeoutMs}ms`;
      finish(124);
    }, params.timeoutMs);

    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < 32 * 1024) stdout += c.toString('utf-8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 32 * 1024) stderr += c.toString('utf-8');
    });
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(1);
    });
    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : 0);
    });
  });
}

export async function runLifecycleHooks(params: {
  workspaceRoot: string;
  event: LifecycleHookEvent;
  sessionId?: string;
  toolName?: string;
  filePath?: string;
  command?: string;
}): Promise<RunLifecycleHooksResult> {
  const rules = await loadLifecycleHooks(params.workspaceRoot);
  if (rules.length === 0) {
    return { ok: true, blocked: false, results: [] };
  }

  const target =
    params.event === 'postFileEdit'
      ? params.filePath
      : params.toolName || params.filePath || params.command;

  const matching = rules.filter(
    (r) => r.event === params.event && matchesHookTarget(r.matcher, target)
  );
  if (matching.length === 0) {
    return { ok: true, blocked: false, results: [] };
  }

  const results: HookExecutionItemResult[] = [];
  let blocked = false;
  const feedbackLines: string[] = [];

  for (const rule of matching) {
    const expandedCmd = rule.command
      .replace(/\{\{\s*file\s*\}\}/g, params.filePath || '')
      .replace(/\{\{\s*tool\s*\}\}/g, params.toolName || '')
      .replace(/\{\{\s*sessionId\s*\}\}/g, params.sessionId || '');

    const execRes = await executeSingleHookCommand({
      command: expandedCmd,
      cwd: params.workspaceRoot,
      env: {
        ...process.env,
        DAC_HOOK_EVENT: params.event,
        DAC_HOOK_FILE: params.filePath || '',
        DAC_HOOK_TOOL: params.toolName || '',
        DAC_HOOK_SESSION_ID: params.sessionId || '',
      },
      timeoutMs: rule.timeoutMs ?? 15_000,
    });

    const failed = execRes.exitCode !== 0;
    const itemBlocked = failed && Boolean(rule.blockOnFailure);
    if (itemBlocked) blocked = true;

    results.push({
      id: rule.id || rule.event,
      event: rule.event,
      command: expandedCmd,
      exitCode: execRes.exitCode,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
      durationMs: execRes.durationMs,
      blocked: itemBlocked,
    });

    if (failed) {
      feedbackLines.push(
        `[Lifecycle Hook ${rule.event} (${rule.id}) exit=${execRes.exitCode}]: ${(
          execRes.stderr || execRes.stdout
        ).slice(0, 800)}`
      );
    }
  }

  return {
    ok: !results.some((r) => r.exitCode !== 0),
    blocked,
    results,
    feedbackMessage: feedbackLines.length > 0 ? feedbackLines.join('\n') : undefined,
  };
}

