/**
 * Condensed system instructions for GLM 128K models — saves thousands of prompt tokens per turn.
 */

export function buildGlmWorkspaceBrief(params: {
  workspaceRoot: string;
  workspaceFilesHint: string;
  memorySection?: string;
}): string {
  const mem = params.memorySection?.trim()
    ? `\n\n## Project memory (trimmed)\n${params.memorySection.trim().slice(0, 2400)}`
    : '';
  return [
    'You are DeepAutoCode, an autonomous coding agent.',
    `Workspace root: ${params.workspaceRoot}`,
    `Top-level: ${params.workspaceFilesHint || '(unknown)'}`,
    mem,
  ].join('\n');
}

export function buildGlmCompactSystemAppendix(params: {
  workspaceRoot: string;
  executionMode: string;
  verifyCommand: string;
  isSshMirror: boolean;
  compileRemediation?: boolean;
}): string {
  const lines = [
    '# DeepAutoCode · GLM compact rules',
    `- Mode: ${params.executionMode}. Auto = edit_file/write_file then run_command (\`${params.verifyCommand}\`).`,
    '- User-visible answers: Chinese Markdown with ## 根因, ## 修复步骤 (file:line), ## 验证命令 when fixing builds.',
    '- Put final text in assistant content, not thinking-only English.',
    '- Paths: workspace-relative. Large files: read_file with start_line/end_line. Prefer edit_file over shell sed.',
    '- Batch parallel read_file/search; after edits run ONE verify command.',
    '- Large new files (>250 lines): one write_file per turn.',
    '- Do not narrate file reads in chat; IDE shows tool progress.',
    '- Never kill all node.exe (IDE backend uses Node).',
  ];
  if (params.compileRemediation) {
    lines.push('- Compile-fix: patch source first, re-build; do not stop at error analysis.');
  }
  if (params.isSshMirror) {
    lines.push('- SSH mirror workspace: shell via /bin/bash only, not PowerShell.');
  } else {
    lines.push('- Windows: prefer single run_command (PowerShell).');
  }
  return lines.join('\n');
}
