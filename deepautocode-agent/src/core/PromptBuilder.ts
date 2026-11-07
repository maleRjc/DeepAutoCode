import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface WorkspaceCustomizations {
  rules: Array<{ name: string; path: string; content: string }>;
  skills: Array<{ name: string; description: string; path: string }>;
  workflows: Array<{ name: string; description: string; path: string }>;
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
  const rules: Array<{ name: string; path: string; content: string }> = [];
  const skills: Array<{ name: string; description: string; path: string }> = [];
  const workflows: Array<{ name: string; description: string; path: string }> = [];

  // 1. Discover top-level AGENTS.md / CLAUDE.md / .cursorrules
  for (const rootRuleFile of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    try {
      const fullPath = path.join(resolved, rootRuleFile);
      const raw = await fs.readFile(fullPath, 'utf-8');
      if (raw.trim()) {
        rules.push({
          name: rootRuleFile,
          path: rootRuleFile,
          content: raw.slice(0, 6000),
        });
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
      if (entry.isFile() && /\.(?:md|txt)$/i.test(entry.name)) {
        try {
          const fullPath = path.join(rulesDir, entry.name);
          const raw = await fs.readFile(fullPath, 'utf-8');
          rules.push({
            name: entry.name.replace(/\.(?:md|txt)$/i, ''),
            path: `.agents/rules/${entry.name}`,
            content: raw.slice(0, 6000),
          });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore missing .agents/rules
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

export async function enrichPromptWithMentions(
  prompt: string,
  workspaceRoot: string,
  options?: { maxFiles?: number; maxFileBytes?: number }
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
export function getClineDefaultSystemPrompt(info: WorkspaceInfo): string {
  const root = info.workspaceRoot || info.rootPath || '.';
  const entriesList =
    Array.isArray(info.topEntries) && info.topEntries.length > 0
      ? info.topEntries.join(', ')
      : info.hint || '';

  const customRulesSection =
    info.customizations?.rules && info.customizations.rules.length > 0
      ? `\n## Active Workspace Rules (.agents/rules & AGENTS.md)\n` +
        info.customizations.rules
          .map((r) => `### ${r.name} (${r.path})\n${r.content.slice(0, 2000)}`)
          .join('\n\n')
      : '';

  const customSkillsSection =
    info.customizations?.skills && info.customizations.skills.length > 0
      ? `\n## Available Workspace Skills (.agents/skills)\n` +
        info.customizations.skills
          .map((s) => `- **${s.name}** (\`${s.path}\`): ${s.description}`)
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
    `- **Subagent Delegation ('invoke_subagent')**: For broad read-only codebase research or multi-file symbol exploration, you can call 'invoke_subagent' ({ role: 'research' | 'planner' | 'verifier', task, files, queries }) or 'explore_codebase' to gather evidence in parallel without cluttering context.`,
    ``,
    `## Antigravity 4-Phase Scientific Problem-Solving Protocol`,
    `1. **Phase 1 — Batch Parallel Evidence Gathering & Function-Completeness Rule (并发精准取证与函数完整性铁律)**:`,
    `   - When investigating a bug, call multiple read-only tools IN PARALLEL in a single turn (e.g. combine 'search_codebase', 'outline_file', and 'read_file' with 'start_line'/'end_line' in one tool_calls array) rather than issuing 20 sequential single-line grep commands.`,
    `   - For large files (>400 lines, e.g. 'src/enqueue.cc'), use 'outline_file' or the automatic [文件符号大纲导航] appended to 'read_file' to jump directly to the exact function line range via 'read_file({ filePath, start_line, end_line })'.`,
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
