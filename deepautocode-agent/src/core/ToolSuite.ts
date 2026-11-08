import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  searchIndexedFiles,
  WorkspaceFileIndex,
  type WorkspaceFileIndexOptions,
} from './WorkspaceFileIndex.js';
import { evaluatePermissionRules, toolNameToAction } from './RulePermission.js';

const execAsync = promisify(exec);

export interface AgentTool<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: TArgs, context?: { signal?: AbortSignal }) => Promise<TResult>;
}

export type ToolPolicyDecision = 'allow' | 'ask' | 'deny';
export type ToolPolicyMap = Record<string, ToolPolicyDecision>;

export function createTool<TArgs = Record<string, unknown>, TResult = unknown>(
  definition: AgentTool<TArgs, TResult>
): AgentTool<TArgs, TResult> {
  return definition;
}

export function createToolPoliciesWithPreset(preset: 'yolo' | 'default' | 'plan'): ToolPolicyMap {
  if (preset === 'yolo') {
    return {
      read_files: 'allow',
      read_file: 'allow',
      outline_file: 'allow',
      list_files: 'allow',
      search_codebase: 'allow',
      explore_codebase: 'allow',
      invoke_subagent: 'allow',
      manage_todo: 'allow',
      write_artifact: 'allow',
      browser_action: 'allow',
      open_file_in_ide: 'allow',
      editor: 'allow',
      edit_file: 'allow',
      write_file: 'allow',
      apply_patch: 'allow',
      run_commands: 'allow',
      run_command: 'allow',
      connect_remote_ssh: 'allow',
      auto_build_and_test: 'allow',
    };
  }
  if (preset === 'plan') {
    return {
      read_files: 'allow',
      read_file: 'allow',
      outline_file: 'allow',
      list_files: 'allow',
      search_codebase: 'allow',
      explore_codebase: 'allow',
      invoke_subagent: 'allow',
      manage_todo: 'allow',
      write_artifact: 'allow',
      browser_action: 'allow',
      open_file_in_ide: 'allow',
      editor: 'deny',
      edit_file: 'deny',
      write_file: 'deny',
      apply_patch: 'deny',
      // Allowed for investigation; CommandGuard blocks mutating shells at policy/executor.
      run_commands: 'allow',
      run_command: 'allow',
    };
  }
  return {
    read_files: 'allow',
    read_file: 'allow',
    outline_file: 'allow',
    list_files: 'allow',
    search_codebase: 'allow',
    explore_codebase: 'allow',
    invoke_subagent: 'allow',
    manage_todo: 'allow',
    write_artifact: 'allow',
    browser_action: 'allow',
    open_file_in_ide: 'allow',
    editor: 'ask',
    edit_file: 'ask',
    write_file: 'ask',
    apply_patch: 'ask',
    run_commands: 'ask',
    run_command: 'ask',
  };
}

/**
 * Overlay hard workspace rules onto a tool policy map.
 * deny beats everything; ask upgrades allow → ask (never softens deny).
 * Resource-specific rules still enforced later at CapabilityRegistry with real paths.
 */
export function overlayToolPoliciesWithHardRules(
  base: ToolPolicyMap,
  ruleset: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }>
): ToolPolicyMap {
  if (!ruleset?.length) return { ...base };
  const MUTATORS = [
    'editor',
    'edit_file',
    'write_file',
    'apply_patch',
    'run_command',
    'run_commands',
    'auto_build_and_test',
    'connect_remote_ssh',
  ];
  const next: ToolPolicyMap = { ...base };
  for (const tool of MUTATORS) {
    const current = next[tool] || 'allow';
    if (current === 'deny') continue;
    const decision = evaluatePermissionRules(toolNameToAction(tool), '*', ruleset);
    if (decision.effect === 'deny') next[tool] = 'deny';
    else if (decision.effect === 'ask' && current === 'allow') next[tool] = 'ask';
  }
  return next;
}

export {
  extractCodeOutline,
  extractCodeOutlineForPath,
  extractCodeOutlineSymbols,
  formatOutlineSymbols,
  type OutlineSymbol,
  type OutlineSymbolKind,
  type ExtractOutlineOptions,
} from './CodeOutline.js';

export interface BuiltinToolExecutors {
  readFile?: (item: { path: string; start_line?: number; end_line?: number } | string) => Promise<string>;
  editor?: (input: {
    command?: 'view' | 'str_replace' | 'insert' | 'create';
    path?: string;
    filePath?: string;
    file_path?: string;
    old_text?: string;
    old_str?: string;
    new_text?: string;
    new_str?: string;
    file_text?: string;
    insert_line?: number;
  }) => Promise<string>;
  search?: (query: string, dirPath?: string, contextLines?: number) => Promise<string>;
  bash?: (input: string | { command?: string; cmd?: string; args?: unknown[] }) => Promise<string>;
}

export interface CreateBuiltinToolsOptions {
  cwd: string;
  shell?: string;
  enableEditor?: boolean;
  enableApplyPatch?: boolean;
  executors?: BuiltinToolExecutors;
  /** Shared workspace path index; speeds repeated search_codebase calls. */
  fileIndex?: WorkspaceFileIndex;
  fileIndexOptions?: WorkspaceFileIndexOptions;
  /** When `plan`, mutating shells are blocked even if bash fallback runs locally. */
  executionMode?: 'plan' | 'auto' | 'manual';
}

async function localSearchFallback(
  cwd: string,
  query: string,
  contextLines = 3,
  fileIndex?: WorkspaceFileIndex,
  under?: string
): Promise<string> {
  if (!query || !query.trim()) {
    return 'Empty search query.';
  }
  const index = fileIndex ?? new WorkspaceFileIndex(cwd);
  return searchIndexedFiles({
    root: cwd,
    index,
    query,
    under,
    contextLines,
  });
}

/**
 * In-tree White-Box Builtin Tools Suite (Antigravity-enhanced)
 */
export function createBuiltinTools(options: CreateBuiltinToolsOptions): AgentTool<any, any>[] {
  const { cwd, shell, enableEditor = true, executors = {}, fileIndexOptions } = options;
  const planModeShell = options.executionMode === 'plan';
  const fileIndex = options.fileIndex ?? new WorkspaceFileIndex(cwd, fileIndexOptions);
  const tools: AgentTool<any, any>[] = [];

  // 1. read_files (batch or single file reading with line range support)
  tools.push(
    createTool({
      name: 'read_files',
      description:
        'Read one or more files in the workspace with optional start_line and end_line (1-based inclusive). Can read multiple files in a single call.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'List of files to read with optional line ranges',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Workspace-relative file path' },
                start_line: { type: 'number', description: 'Optional 1-based start line' },
                end_line: { type: 'number', description: 'Optional 1-based end line' },
              },
              required: ['path'],
            },
          },
          path: {
            type: 'string',
            description: 'Single workspace-relative file path (shorthand if files array is omitted)',
          },
          start_line: { type: 'number', description: 'Optional 1-based start line' },
          end_line: { type: 'number', description: 'Optional 1-based end line' },
        },
      },
      execute: async (rawArgs: Record<string, any>) => {
        const items: Array<{ path: string; start_line?: number; end_line?: number }> = Array.isArray(
          rawArgs?.files
        )
          ? rawArgs.files
          : rawArgs?.path || rawArgs?.filePath
            ? [
                {
                  path: String(rawArgs.path || rawArgs.filePath),
                  start_line:
                    typeof rawArgs.start_line === 'number' ? rawArgs.start_line : undefined,
                  end_line: typeof rawArgs.end_line === 'number' ? rawArgs.end_line : undefined,
                },
              ]
            : [];

        if (items.length === 0) {
          return { error: 'No file path provided to read_files' };
        }

        const outputs: Array<{ path: string; content: string }> = [];
        for (const item of items) {
          if (executors.readFile) {
            const content = await executors.readFile(item);
            outputs.push({ path: item.path, content });
          } else {
            const fullPath = path.resolve(cwd, item.path);
            const raw = await fs.readFile(fullPath, 'utf-8');
            const lines = raw.split(/\r?\n/);
            const start = Math.max(1, item.start_line ?? 1);
            const end = Math.min(lines.length, item.end_line ?? lines.length);
            const numbered = lines
              .slice(start - 1, end)
              .map((line, i) => `${start + i}: ${line}`)
              .join('\n');
            outputs.push({ path: item.path, content: numbered });
          }
        }
        return outputs.length === 1 ? outputs[0] : { files: outputs };
      },
    })
  );

  // 2. search_codebase (fast text/symbol search across workspace with surrounding context lines)
  tools.push(
    createTool({
      name: 'search_codebase',
      description:
        'Search workspace source files. Modes: auto (hybrid), content (rg/text), symbol (outline), semantic (local TF-IDF / natural-language retrieval). Supports regex/glob/case flags.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Text, regex, function name, or natural-language description to search for',
          },
          path: {
            type: 'string',
            description: 'Optional relative subdirectory or file path to scope the search (e.g. "src/include")',
          },
          context_lines: {
            type: 'number',
            description: 'Number of context lines before and after each match (default 3)',
          },
          regex: {
            type: 'boolean',
            description: 'Treat query as regex (default false = fixed string)',
          },
          case_sensitive: {
            type: 'boolean',
            description: 'Case-sensitive search (default false)',
          },
          glob: {
            type: 'string',
            description: 'Optional file glob filter, e.g. "*.ts" or "*.{cc,h}"',
          },
          mode: {
            type: 'string',
            enum: ['auto', 'content', 'symbol', 'semantic'],
            description:
              'auto (default): hybrid; symbol: outline; content: text/rg; semantic: local TF-IDF ranking for NL queries',
          },
        },
        required: ['query'],
      },
      execute: async (rawArgs: Record<string, any>) => {
        const query = String(rawArgs?.query || rawArgs?.pattern || '').trim();
        const subDir = rawArgs?.path ? String(rawArgs.path).trim() : undefined;
        const contextLines =
          typeof rawArgs?.context_lines === 'number'
            ? Math.max(0, Math.min(10, rawArgs.context_lines))
            : 3;
        const regex = Boolean(rawArgs?.regex);
        const caseSensitive = Boolean(rawArgs?.case_sensitive ?? rawArgs?.caseSensitive);
        const glob = rawArgs?.glob ? String(rawArgs.glob).trim() : undefined;
        const modeRaw = String(rawArgs?.mode || 'auto').toLowerCase();
        const mode =
          modeRaw === 'symbol' || modeRaw === 'content' || modeRaw === 'semantic'
            ? (modeRaw as 'symbol' | 'content' | 'semantic')
            : 'auto';
        if (executors.search) {
          return await executors.search(query, subDir, contextLines);
        }
        const index = fileIndex ?? new WorkspaceFileIndex(cwd);
        return searchIndexedFiles({
          root: cwd,
          index,
          query,
          under: subDir,
          contextLines,
          regex,
          caseSensitive,
          glob,
          mode,
        });
      },
    })
  );

  // 3. editor (str_replace / insert / create / view)
  if (enableEditor) {
    tools.push(
      createTool({
        name: 'editor',
        description:
          'View, create, or modify a source file in the workspace by replacing old_text with new_text or inserting lines.',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              enum: ['str_replace', 'insert', 'create', 'view'],
              description: 'Editor operation (defaults to str_replace when old_text is provided)',
            },
            path: {
              type: 'string',
              description: 'Relative path to the file in the workspace',
            },
            old_text: {
              type: 'string',
              description: 'Existing text in the file to replace',
            },
            new_text: {
              type: 'string',
              description: 'Replacement text or full new file content',
            },
            insert_line: {
              type: 'number',
              description: 'Line number for insert command',
            },
          },
          required: ['path'],
        },
        execute: async (rawArgs: Record<string, any>) => {
          if (executors.editor) {
            return await executors.editor(rawArgs);
          }
          const targetPath = path.resolve(cwd, String(rawArgs.path || rawArgs.filePath || ''));
          if (rawArgs.command === 'view') {
            const raw = await fs.readFile(targetPath, 'utf-8');
            return raw.slice(0, 12000);
          }
          const oldText = rawArgs.old_text ?? rawArgs.old_str;
          const newText = rawArgs.new_text ?? rawArgs.new_str ?? rawArgs.file_text ?? '';
          if (oldText) {
            const current = await fs.readFile(targetPath, 'utf-8');
            const updated = current.replace(oldText, newText);
            await fs.writeFile(targetPath, updated, 'utf-8');
            fileIndex.invalidate();
            return `Updated ${rawArgs.path}`;
          }
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, newText, 'utf-8');
          fileIndex.invalidate();
          return `Written ${rawArgs.path}`;
        },
      })
    );
  }

  // 4. run_commands (execute shell / build / test commands)
  tools.push(
    createTool({
      name: 'run_commands',
      description: 'Execute one or more shell commands in the workspace root.',
      inputSchema: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of shell commands to execute sequentially',
          },
          command: {
            type: 'string',
            description: 'Single shell command to execute',
          },
        },
      },
      execute: async (rawArgs: Record<string, any>) => {
        const cmdList: string[] = Array.isArray(rawArgs?.commands)
          ? rawArgs.commands.map((c: unknown) => String(c))
          : rawArgs?.command
            ? [String(rawArgs.command)]
            : [];
        if (cmdList.length === 0) {
          return 'No command provided.';
        }
        const combinedCmd = cmdList.join(' && ');
        if (planModeShell) {
          const { assertCommandAllowedInPlanMode } = await import('./CommandGuard.js');
          assertCommandAllowedInPlanMode(combinedCmd);
        }
        if (executors.bash) {
          return await executors.bash({ command: combinedCmd });
        }
        const { stdout, stderr } = await execAsync(combinedCmd, {
          cwd,
          shell: shell || undefined,
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n') || 'Command completed (exit 0).';
      },
    })
  );

  return tools;
}
