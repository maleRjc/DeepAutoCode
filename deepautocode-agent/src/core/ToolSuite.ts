import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

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
      write_artifact: 'allow',
      browser_action: 'allow',
      open_file_in_ide: 'allow',
      editor: 'allow',
      edit_file: 'allow',
      write_file: 'allow',
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
      write_artifact: 'allow',
      browser_action: 'allow',
      open_file_in_ide: 'allow',
      editor: 'deny',
      edit_file: 'deny',
      write_file: 'deny',
      run_commands: 'deny',
      run_command: 'deny',
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
    write_artifact: 'allow',
    browser_action: 'allow',
    open_file_in_ide: 'allow',
    editor: 'ask',
    edit_file: 'ask',
    write_file: 'ask',
    run_commands: 'ask',
    run_command: 'ask',
  };
}

/**
 * Extracts a concise symbol/function/struct outline with 1-based line numbers
 * for C/C++/CUDA/HIP, TypeScript/JavaScript, Python, Go, and Rust files.
 */
export function extractCodeOutline(content: string, maxEntries = 120): string[] {
  const lines = content.split(/\r?\n/);
  const outline: string[] = [];
  const symbolPatterns = [
    // C / C++ / CUDA / HIP structs, classes, enums, functions, macros
    /^\s*(?:struct|class|enum|union|namespace)\s+[A-Za-z_]\w*\s*(?:[:{]|$)/,
    /^\s*(?:static\s+|inline\s+|__forceinline__\s+|__device__\s+|__global__\s+|__host__\s+|extern\s+)*(?:[A-Za-z_][\w:<>*&\s]{1,48})\s+([A-Za-z_]\w*)\s*\([^;]*$/,
    /^\s*#\s*define\s+([A-Za-z_]\w*)\s*\(/,
    // TS / JS / Python / Go / Rust
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+[A-Za-z_]\w*/,
    /^\s*(?:public|private|protected|static|async)\s+[A-Za-z_]\w*\s*\(/,
    /^\s*(?:def|class|fn|pub\s+fn|func|pub\s+struct)\s+[A-Za-z_]\w*/,
  ];

  const controlKeywords = new Set([
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }
    for (const pat of symbolPatterns) {
      const m = line.match(pat);
      if (m) {
        const fnCandidate = m[1];
        if (fnCandidate && controlKeywords.has(fnCandidate)) {
          break;
        }
        outline.push(`L${i + 1}: ${trimmed.slice(0, 120)}`);
        break;
      }
    }
    if (outline.length >= maxEntries) {
      break;
    }
  }
  return outline;
}

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
}

async function localSearchFallback(
  cwd: string,
  query: string,
  contextLines = 3
): Promise<string> {
  if (!query || !query.trim()) {
    return 'Empty search query.';
  }
  const results: string[] = [];
  const maxMatches = 50;
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.deepautocode-data']);

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxMatches) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxMatches) break;
      if (ignoreDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > 768 * 1024) continue;
          const content = await fs.readFile(fullPath, 'utf-8');
          if (!content.includes(query)) continue;
          const relPath = path.relative(cwd, fullPath).replace(/\\/g, '/');
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(query)) {
              const startCtx = Math.max(0, i - contextLines);
              const endCtx = Math.min(lines.length - 1, i + contextLines);
              const snippet: string[] = [];
              for (let k = startCtx; k <= endCtx; k++) {
                const marker = k === i ? '>' : ' ';
                snippet.push(`${marker} ${relPath}:${k + 1}: ${lines[k].slice(0, 200)}`);
              }
              results.push(snippet.join('\n'));
              i = endCtx; // skip overlapping context lines
              if (results.length >= maxMatches) break;
            }
          }
        } catch {
          // ignore binary or unreadable file
        }
      }
    }
  }

  await walk(cwd);
  return results.length > 0 ? results.join('\n--\n') : 'No matches found.';
}

/**
 * In-tree White-Box Builtin Tools Suite (Antigravity-enhanced)
 */
export function createBuiltinTools(options: CreateBuiltinToolsOptions): AgentTool<any, any>[] {
  const { cwd, shell, enableEditor = true, executors = {} } = options;
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
        'Search for a keyword, identifier, function name, or struct field across workspace source files. Automatically returns surrounding context lines so you can inspect struct fields and function signatures immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Exact text, function name, or struct identifier to search for',
          },
          path: {
            type: 'string',
            description: 'Optional relative subdirectory or file path to scope the search (e.g. "src/include")',
          },
          context_lines: {
            type: 'number',
            description: 'Number of context lines before and after each match (default 3)',
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
        if (executors.search) {
          return await executors.search(query, subDir, contextLines);
        }
        const targetDir = subDir ? path.resolve(cwd, subDir) : cwd;
        return await localSearchFallback(targetDir, query, contextLines);
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
            return `Updated ${rawArgs.path}`;
          }
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, newText, 'utf-8');
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
