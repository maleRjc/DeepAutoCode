/**
 * Shared tool registry helpers — keep RuntimeFactory + ToolSuite naming aligned.
 */
import type { AgentTool } from './ToolSuite.js';

/** Canonical aliases the model may call interchangeably. */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  // search
  search_codebase: 'search_codebase',
  grep: 'search_codebase',
  codebase_search: 'search_codebase',
  // explore batch
  explore_codebase: 'explore_codebase',
  explore: 'explore_codebase',
  // codemode
  execute_code_mode: 'execute_code_mode',
  code_mode: 'execute_code_mode',
  // reads
  read_file: 'read_file',
  read_files: 'read_files',
  // edits
  edit_file: 'edit_file',
  apply_patch: 'apply_patch',
  // shell
  run_command: 'run_command',
  run_commands: 'run_commands',
};

/**
 * Duplicate a tool under an alias name if the canonical tool exists and alias is missing.
 */
export function withToolAlias(
  tools: AgentTool<any, any>[],
  canonicalName: string,
  aliasName: string,
  descriptionPrefix?: string
): AgentTool<any, any>[] {
  if (tools.some((t) => t.name === aliasName)) return tools;
  const canonical = tools.find((t) => t.name === canonicalName);
  if (!canonical) return tools;
  return [
    ...tools,
    {
      ...canonical,
      name: aliasName,
      description: descriptionPrefix
        ? `${descriptionPrefix}${canonical.description}`
        : `Alias of '${canonicalName}'. ${canonical.description}`,
    },
  ];
}

/**
 * Apply standard DeepAutoCode aliases so prompts/model don't miss tools.
 */
export function applyStandardToolAliases(
  tools: AgentTool<any, any>[]
): AgentTool<any, any>[] {
  let next = tools;
  // Prefer search_codebase as the primary search; alias common synonyms onto it
  next = withToolAlias(next, 'search_codebase', 'grep', "Alias of 'search_codebase'. ");
  next = withToolAlias(
    next,
    'search_codebase',
    'codebase_search',
    "Alias of 'search_codebase'. "
  );
  // If only explore exists, also expose search_codebase pointing at a thin wrapper is harder —
  // ensure explore is discoverable under a short name.
  next = withToolAlias(next, 'explore_codebase', 'explore', "Alias of 'explore_codebase'. ");
  next = withToolAlias(next, 'execute_code_mode', 'code_mode', "Alias of 'execute_code_mode'. ");
  next = withToolAlias(next, 'edit_file', 'str_replace', "Alias of 'edit_file'. ");
  // If search_codebase missing but explore exists, still expose search_codebase as explore-compatible
  // only when search_codebase absent (builtin path usually provides it).
  if (!next.some((t) => t.name === 'search_codebase') && next.some((t) => t.name === 'explore_codebase')) {
    next = withToolAlias(
      next,
      'explore_codebase',
      'search_codebase',
      "Alias of 'explore_codebase' (pass queries: [pattern]). "
    );
  }
  return next;
}

export function listRegisteredToolNames(tools: AgentTool<any, any>[]): string[] {
  return tools.map((t) => t.name).sort();
}
