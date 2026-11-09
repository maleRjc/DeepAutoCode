import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceRule } from './PromptBuilder.js';
import type { SubagentDefinition } from './SubagentOrchestrator.js';

export interface AgentPluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  rootDir: string;
  skills: Array<{ name: string; qualifiedName: string; description: string; path: string; content?: string }>;
  rules: WorkspaceRule[];
  subagents: SubagentDefinition[];
  mcpServersCount: number;
  hooksCount: number;
}

/**
 * Antigravity-style Plugin Packaging & Migration Manager.
 * Discovers namespaced plugin bundles under `.agents/plugins/<id>/plugin.json`
 * and `.deepautocode/plugins/<id>/plugin.json`, and supports migrating external
 * agent configurations (Cursor, Claude Code, Codex, Gemini CLI) into a unified plugin.
 */
export async function discoverWorkspacePlugins(
  workspaceRoot: string
): Promise<AgentPluginManifest[]> {
  const plugins: AgentPluginManifest[] = [];
  const pluginRoots = [
    path.join(workspaceRoot, '.agents', 'plugins'),
    path.join(workspaceRoot, '.deepautocode', 'plugins'),
  ];

  for (const baseDir of pluginRoots) {
    try {
      const dirs = await fs.readdir(baseDir, { withFileTypes: true });
      for (const dirEntry of dirs) {
        if (!dirEntry.isDirectory()) continue;
        const pluginDir = path.join(baseDir, dirEntry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');
        let meta: Record<string, any> = {
          id: dirEntry.name,
          name: dirEntry.name,
          version: '1.0.0',
          description: `Workspace plugin ${dirEntry.name}`,
          enabled: true,
        };
        try {
          const rawJson = await fs.readFile(manifestPath, 'utf-8');
          meta = { ...meta, ...JSON.parse(rawJson) };
        } catch {
          // allow directory-convention plugin even without plugin.json
        }
        if (meta.enabled === false) continue;

        const pluginId = String(meta.id || dirEntry.name);
        const skills: AgentPluginManifest['skills'] = [];
        const rules: WorkspaceRule[] = [];
        const subagents: SubagentDefinition[] = [];

        // 1. Load plugin skills/<skill>/SKILL.md
        try {
          const skillsDir = path.join(pluginDir, 'skills');
          const skillEntries = await fs.readdir(skillsDir, { withFileTypes: true });
          for (const sEntry of skillEntries) {
            if (!sEntry.isDirectory()) continue;
            const skillMdPath = path.join(skillsDir, sEntry.name, 'SKILL.md');
            try {
              const content = await fs.readFile(skillMdPath, 'utf-8');
              const descMatch = content.match(/description:\s*(.+)/i);
              skills.push({
                name: sEntry.name,
                qualifiedName: `${pluginId}:${sEntry.name}`,
                description: descMatch
                  ? descMatch[1].trim().replace(/^["']|["']$/g, '')
                  : `Skill from plugin ${pluginId}`,
                path: path.relative(workspaceRoot, skillMdPath).replace(/\\/g, '/'),
                content,
              });
            } catch {
              // ignore
            }
          }
        } catch {
          // no skills dir
        }

        // 2. Load plugin rules/*.md
        try {
          const rulesDir = path.join(pluginDir, 'rules');
          const ruleEntries = await fs.readdir(rulesDir, { withFileTypes: true });
          for (const rEntry of ruleEntries) {
            if (!rEntry.isFile() || !/\.(md|mdc)$/i.test(rEntry.name)) continue;
            const rPath = path.join(rulesDir, rEntry.name);
            const content = await fs.readFile(rPath, 'utf-8');
            rules.push({
              name: `${pluginId}:${rEntry.name.replace(/\.(md|mdc)$/i, '')}`,
              path: path.relative(workspaceRoot, rPath).replace(/\\/g, '/'),
              content,
              alwaysApply: true,
            });
          }
        } catch {
          // no rules dir
        }

        // 3. Load plugin agents/*.md
        try {
          const agentsDir = path.join(pluginDir, 'agents');
          const agentEntries = await fs.readdir(agentsDir, { withFileTypes: true });
          for (const aEntry of agentEntries) {
            if (!aEntry.isFile() || !/\.(md|json)$/i.test(aEntry.name)) continue;
            const aPath = path.join(agentsDir, aEntry.name);
            const raw = await fs.readFile(aPath, 'utf-8');
            const baseName = aEntry.name.replace(/\.(md|json)$/i, '');
            subagents.push({
              name: `${pluginId}:${baseName}`,
              description: `Plugin ${pluginId} subagent ${baseName}`,
              systemPrompt: raw.trim(),
              enableWriteTools: true,
              source: 'plugin',
            });
          }
        } catch {
          // no agents dir
        }

        plugins.push({
          id: pluginId,
          name: String(meta.name || pluginId),
          version: String(meta.version || '1.0.0'),
          description: String(meta.description || ''),
          enabled: true,
          rootDir: path.relative(workspaceRoot, pluginDir).replace(/\\/g, '/'),
          skills,
          rules,
          subagents,
          mcpServersCount: Array.isArray(meta.mcpServers) ? meta.mcpServers.length : 0,
          hooksCount: Array.isArray(meta.hooks) ? meta.hooks.length : 0,
        });
      }
    } catch {
      // ignore missing plugin root
    }
  }

  return plugins;
}

/**
 * Antigravity `/migrate-agent-settings` implementation:
 * Scans `.cursor/`, `.claude/`, `CLAUDE.md`, `.codex/`, `.gemini/` in the workspace
 * and packages them into `.agents/plugins/migrated-agent-setup/`.
 */
export async function migrateExternalAgentSettings(workspaceRoot: string): Promise<{
  ok: boolean;
  pluginDir: string;
  migratedRules: string[];
  migratedSkills: string[];
  migratedAgents: string[];
}> {
  const targetPluginDir = path.join(workspaceRoot, '.agents', 'plugins', 'migrated-agent-setup');
  const rulesOutDir = path.join(targetPluginDir, 'rules');
  const skillsOutDir = path.join(targetPluginDir, 'skills');
  const agentsOutDir = path.join(targetPluginDir, 'agents');

  await fs.mkdir(rulesOutDir, { recursive: true });
  await fs.mkdir(skillsOutDir, { recursive: true });
  await fs.mkdir(agentsOutDir, { recursive: true });

  const migratedRules: string[] = [];
  const migratedSkills: string[] = [];
  const migratedAgents: string[] = [];

  const rootRuleCandidates = [
    { file: 'CLAUDE.md', outName: 'claude-root.md' },
    { file: '.cursorrules', outName: 'cursorrules-root.md' },
    { file: 'GEMINI.md', outName: 'gemini-root.md' },
    { file: '.github/copilot-instructions.md', outName: 'copilot-instructions.md' },
  ];

  for (const cand of rootRuleCandidates) {
    try {
      const srcPath = path.join(workspaceRoot, cand.file);
      const content = await fs.readFile(srcPath, 'utf-8');
      if (content.trim()) {
        await fs.writeFile(path.join(rulesOutDir, cand.outName), content, 'utf-8');
        migratedRules.push(cand.file);
      }
    } catch {
      // ignore
    }
  }

  // Scan .cursor/rules
  try {
    const cursorRulesDir = path.join(workspaceRoot, '.cursor', 'rules');
    const entries = await fs.readdir(cursorRulesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !/\.(md|mdc)$/i.test(e.name)) continue;
      const content = await fs.readFile(path.join(cursorRulesDir, e.name), 'utf-8');
      const outName = `cursor-${e.name.replace(/\.mdc$/i, '.md')}`;
      await fs.writeFile(path.join(rulesOutDir, outName), content, 'utf-8');
      migratedRules.push(`.cursor/rules/${e.name}`);
    }
  } catch {
    // ignore
  }

  // Scan .claude/commands -> skills
  try {
    const claudeCmdDir = path.join(workspaceRoot, '.claude', 'commands');
    const entries = await fs.readdir(claudeCmdDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      const skillName = e.name.replace(/\.md$/i, '');
      const content = await fs.readFile(path.join(claudeCmdDir, e.name), 'utf-8');
      const sDir = path.join(skillsOutDir, skillName);
      await fs.mkdir(sDir, { recursive: true });
      const wrapped = content.startsWith('---')
        ? content
        : `---\nname: ${skillName}\ndescription: Migrated Claude Code command ${skillName}\n---\n\n${content}`;
      await fs.writeFile(path.join(sDir, 'SKILL.md'), wrapped, 'utf-8');
      migratedSkills.push(`.claude/commands/${e.name}`);
    }
  } catch {
    // ignore
  }

  // Scan .claude/agents -> agents
  try {
    const claudeAgentsDir = path.join(workspaceRoot, '.claude', 'agents');
    const entries = await fs.readdir(claudeAgentsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      const content = await fs.readFile(path.join(claudeAgentsDir, e.name), 'utf-8');
      await fs.writeFile(path.join(agentsOutDir, e.name), content, 'utf-8');
      migratedAgents.push(`.claude/agents/${e.name}`);
    }
  } catch {
    // ignore
  }

  const pluginJson = {
    id: 'migrated-agent-setup',
    name: 'Migrated Agent Setup',
    version: '1.0.0',
    description:
      'Automatically migrated rules, skills, and subagents from Claude Code / Cursor / Gemini CLI',
    enabled: true,
    migratedAt: new Date().toISOString(),
    migratedRules,
    migratedSkills,
    migratedAgents,
  };
  await fs.writeFile(
    path.join(targetPluginDir, 'plugin.json'),
    JSON.stringify(pluginJson, null, 2),
    'utf-8'
  );

  return {
    ok: true,
    pluginDir: path.relative(workspaceRoot, targetPluginDir).replace(/\\/g, '/'),
    migratedRules,
    migratedSkills,
    migratedAgents,
  };
}

/**
 * Antigravity `migrate-workflows` implementation:
 * Scans legacy `.agents/workflows/*.md` and `.deepautocode/workflows/*.md`,
 * converts them into `.agents/skills/<name>/SKILL.md` with YAML frontmatter,
 * and archives the original workflow files under `.agents/workflows/.archived/`.
 */
export async function migrateLegacyWorkflowsToSkills(workspaceRoot: string): Promise<{
  ok: boolean;
  migratedWorkflows: string[];
  createdSkills: string[];
  archiveDir: string;
}> {
  const wfDirs = [
    path.join(workspaceRoot, '.agents', 'workflows'),
    path.join(workspaceRoot, '.deepautocode', 'workflows'),
  ];
  const skillsOutRoot = path.join(workspaceRoot, '.agents', 'skills');
  const archiveDir = path.join(workspaceRoot, '.agents', 'workflows', '.archived');
  const migratedWorkflows: string[] = [];
  const createdSkills: string[] = [];

  for (const wfDir of wfDirs) {
    try {
      const entries = await fs.readdir(wfDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
        const srcPath = path.join(wfDir, e.name);
        const raw = await fs.readFile(srcPath, 'utf-8');
        const skillName = e.name.replace(/\.md$/i, '');
        const descMatch = raw.match(/description:\s*([^\r\n]+)/i);
        const description = descMatch?.[1]?.trim() || `Migrated workflow ${skillName}`;
        const targetSkillDir = path.join(skillsOutRoot, skillName);
        await fs.mkdir(targetSkillDir, { recursive: true });
        const skillMd = raw.startsWith('---')
          ? raw
          : `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${raw}`;
        const targetSkillFile = path.join(targetSkillDir, 'SKILL.md');
        await fs.writeFile(targetSkillFile, skillMd, 'utf-8');

        await fs.mkdir(archiveDir, { recursive: true });
        await fs.rename(srcPath, path.join(archiveDir, e.name));

        migratedWorkflows.push(path.relative(workspaceRoot, srcPath).replace(/\\/g, '/'));
        createdSkills.push(path.relative(workspaceRoot, targetSkillFile).replace(/\\/g, '/'));
      }
    } catch {
      // ignore missing workflow dir
    }
  }

  return {
    ok: true,
    migratedWorkflows,
    createdSkills,
    archiveDir: path.relative(workspaceRoot, archiveDir).replace(/\\/g, '/'),
  };
}

export interface MarketplaceCatalogEntry {
  id: string;
  name: string;
  kind: 'plugin' | 'skill';
  shelf: string;
  description: string;
  keywords: string[];
  authProvider?: string;
  cliNames?: string[];
  installed?: boolean;
}

export const BUILTIN_MARKETPLACE_CATALOG: MarketplaceCatalogEntry[] = [
  {
    id: 'antigravity-plugins-official/plugin/gdocs',
    name: 'Google Docs',
    kind: 'plugin',
    shelf: 'Google Workspace',
    description: 'Read, draft, and edit Google Docs documents directly from your agent.',
    keywords: ['google docs', 'gdocs', 'docs', 'document', 'workspace'],
    authProvider: 'google-workspace',
    cliNames: ['gdocs'],
  },
  {
    id: 'antigravity-plugins-official/plugin/gsheets',
    name: 'Google Sheets',
    kind: 'plugin',
    shelf: 'Google Workspace',
    description: 'Read, write, and format Google Sheets spreadsheets.',
    keywords: ['google sheets', 'gsheets', 'sheets', 'spreadsheet', 'csv'],
    authProvider: 'google-workspace',
    cliNames: ['gsheets'],
  },
  {
    id: 'antigravity-plugins-official/plugin/gemini-api',
    name: 'Gemini API',
    kind: 'plugin',
    shelf: 'Build with Google',
    description:
      'Build applications with the Gemini Interactions API and Live API, including text, image, video, and speech generation.',
    keywords: ['gemini', 'gemini api', 'google ai', 'live api', 'multimodal'],
    authProvider: 'google-cloud',
    cliNames: ['gemini'],
  },
  {
    id: 'antigravity-plugins-official/plugin/chrome-devtools-plugin',
    name: 'Chrome DevTools',
    kind: 'plugin',
    shelf: 'Build with Google',
    description:
      'Reliable automation, in-depth debugging, and performance analysis in Chrome using Chrome DevTools and Puppeteer.',
    keywords: ['chrome', 'devtools', 'puppeteer', 'browser', 'lighthouse', 'performance'],
    cliNames: ['chrome-devtools'],
  },
  {
    id: 'antigravity-plugins-partners/plugin/figma',
    name: 'Figma',
    kind: 'plugin',
    shelf: 'Design, Creative & Media',
    description:
      'Turn Figma designs into production code, map components with Code Connect, and inspect design tokens.',
    keywords: ['figma', 'design', 'ui', 'ux', 'code connect'],
    authProvider: 'figma-oauth',
    cliNames: ['figma'],
  },
  {
    id: 'antigravity-plugins-partners/plugin/linear',
    name: 'Linear',
    kind: 'plugin',
    shelf: 'Productivity & Project Management',
    description: 'The product development system for teams and agents: issues, cycles, and roadmaps.',
    keywords: ['linear', 'issues', 'project management', 'tickets', 'roadmap'],
    authProvider: 'linear-oauth',
    cliNames: ['linear'],
  },
  {
    id: 'antigravity-plugins-partners/plugin/atlassian-twg-cli',
    name: 'Atlassian Teamwork Graph CLI',
    kind: 'plugin',
    shelf: 'Productivity & Project Management',
    description:
      'Agent-first interface to Jira issues, Confluence pages, and Bitbucket PRs via Teamwork Graph.',
    keywords: ['jira', 'confluence', 'bitbucket', 'atlassian', 'twg'],
    authProvider: 'atlassian-oauth',
    cliNames: ['twg'],
  },
  {
    id: 'antigravity-plugins-partners/plugin/netlify',
    name: 'Netlify',
    kind: 'plugin',
    shelf: 'Cloud Hosting & Deployment',
    description:
      'Build and deploy on Netlify: functions, edge functions, blobs, database, and Netlify MCP server.',
    keywords: ['netlify', 'deploy', 'hosting', 'edge functions', 'serverless'],
    authProvider: 'netlify-oauth',
    cliNames: ['netlify'],
  },
  {
    id: 'antigravity-plugins-partners/plugin/railway',
    name: 'Railway',
    kind: 'plugin',
    shelf: 'Cloud Hosting & Deployment',
    description:
      'Deploy, configure, monitor, and troubleshoot apps, databases, and infrastructure on Railway.',
    keywords: ['railway', 'deploy', 'cloud', 'postgres', 'docker'],
    authProvider: 'railway-token',
    cliNames: ['railway'],
  },
  {
    id: 'antigravity-plugins-partners/plugin/auth0',
    name: 'Auth0',
    kind: 'plugin',
    shelf: 'Developer Tools',
    description:
      'Add Auth0 authentication to any app: login, MFA, SSO, Organizations, RBAC, and custom domains.',
    keywords: ['auth0', 'auth', 'oauth', 'sso', 'mfa', 'rbac', 'login'],
    authProvider: 'auth0-cli',
    cliNames: ['auth0'],
  },
  {
    id: 'antigravity-plugins-partners/plugin/databricks',
    name: 'Databricks',
    kind: 'plugin',
    shelf: 'Business',
    description:
      'Databricks skills for the CLI, Apps, Lakebase, Model Serving, Lakeflow Jobs, and Spark pipelines.',
    keywords: ['databricks', 'spark', 'lakehouse', 'mlops', 'data'],
    authProvider: 'databricks-pat',
    cliNames: ['databricks'],
  },
  {
    id: 'antigravity-builtin/skill/generative_ui',
    name: 'Generative UI',
    kind: 'skill',
    shelf: 'Built-in Skills',
    description:
      'Render rich interactive HTML widgets, charts, diagrams, and educational walkthroughs inline in chat or as artifacts.',
    keywords: ['generative ui', 'html widget', 'chart', 'interactive', 'visualization'],
  },
  {
    id: 'antigravity-builtin/skill/automation',
    name: 'Scheduled Automation',
    kind: 'skill',
    shelf: 'Built-in Skills',
    description:
      'Interactive guide to design and create recurring cron jobs and background scheduled automations.',
    keywords: ['automation', 'schedule', 'cron', 'recurring', 'timer'],
  },
];

export async function searchMarketplace(params: {
  queries: string[];
  kind?: 'plugin' | 'skill' | 'all';
  limit?: number;
  workspaceRoot?: string;
}): Promise<{
  ok: boolean;
  matches: MarketplaceCatalogEntry[];
  cardRenderingHint: string;
}> {
  const kindFilter = params.kind || 'plugin';
  const limit = Math.max(1, Math.min(15, Number(params.limit || 5)));
  const normalizedQueries = (params.queries || [])
    .slice(0, 3)
    .map((q) => String(q || '').trim().toLowerCase())
    .filter(Boolean);

  const installedIds = new Set<string>();
  if (params.workspaceRoot) {
    const installed = await discoverWorkspacePlugins(params.workspaceRoot);
    for (const p of installed) {
      installedIds.add(p.id.toLowerCase());
      installedIds.add(p.name.toLowerCase());
    }
  }

  const scored = BUILTIN_MARKETPLACE_CATALOG.filter((item) => {
    if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
    return true;
  })
    .map((item) => {
      const slug = item.id.split('/').pop()?.toLowerCase() || '';
      const isInstalled =
        installedIds.has(item.id.toLowerCase()) ||
        installedIds.has(slug) ||
        installedIds.has(item.name.toLowerCase()) ||
        item.kind === 'skill';
      const haystack = `${item.id} ${item.name} ${item.shelf} ${item.description} ${item.keywords.join(' ')}`.toLowerCase();
      let score = 0;
      if (normalizedQueries.length === 0) {
        score = 1;
      } else {
        for (const q of normalizedQueries) {
          if (item.name.toLowerCase() === q || slug === q) score += 10;
          else if (item.keywords.some((k) => k.toLowerCase().includes(q))) score += 6;
          else if (haystack.includes(q)) score += 3;
        }
      }
      return {
        entry: {
          ...item,
          installed: isInstalled,
        },
        score,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.entry);

  return {
    ok: true,
    matches: scored,
    cardRenderingHint:
      'To suggest an uninstalled plugin to the user in your response, place <plugin-card catalog-id="<id>"></plugin-card> on its own line.',
  };
}

export async function installCatalogPlugin(
  workspaceRoot: string,
  catalogId: string
): Promise<{
  ok: boolean;
  pluginId: string;
  pluginDir: string;
  entry?: MarketplaceCatalogEntry;
}> {
  const entry = BUILTIN_MARKETPLACE_CATALOG.find(
    (c) =>
      c.id.toLowerCase() === catalogId.toLowerCase() ||
      c.id.split('/').pop()?.toLowerCase() === catalogId.toLowerCase()
  );
  const slug = (entry ? entry.id.split('/').pop() : catalogId.replace(/[^a-zA-Z0-9_-]/g, '-')) || 'custom-plugin';
  const pluginDir = path.join(workspaceRoot, '.agents', 'plugins', slug);
  const skillDir = path.join(pluginDir, 'skills', slug);
  await fs.mkdir(skillDir, { recursive: true });

  const manifest = {
    id: entry?.id || catalogId,
    name: entry?.name || slug,
    version: '1.0.0',
    description: entry?.description || `Installed Marketplace plugin ${catalogId}`,
    enabled: true,
    installedAt: new Date().toISOString(),
    authProvider: entry?.authProvider,
    cliNames: entry?.cliNames || [],
  };
  await fs.writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  const skillMd = `---\nname: ${slug}\ndescription: ${manifest.description}\n---\n\n# ${manifest.name} Plugin Skill\n\n${manifest.description}\n\n- Catalog ID: \`${manifest.id}\`\n- CLI / Auth Provider: \`${manifest.authProvider || 'none'}\`\n`;
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

  return {
    ok: true,
    pluginId: manifest.id,
    pluginDir: path.relative(workspaceRoot, pluginDir).replace(/\\/g, '/'),
    entry,
  };
}

export interface PluginAccountStatus {
  pluginId: string;
  pluginName: string;
  provider: string;
  signedIn: boolean;
  accounts: Array<{
    accountName: string;
    label: string;
    identity: string;
    isDefault: boolean;
    envPrefix: string;
  }>;
  poweredClis: string[];
}

export async function listPluginAccounts(workspaceRoot: string): Promise<{
  ok: boolean;
  accounts: PluginAccountStatus[];
  usageHint: string;
}> {
  const installed = await discoverWorkspacePlugins(workspaceRoot);
  const customAccountsFile = path.join(workspaceRoot, '.deepautocode', 'plugin-accounts.json');
  let savedAccounts: PluginAccountStatus[] = [];
  try {
    const raw = await fs.readFile(customAccountsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) savedAccounts = parsed;
  } catch {
    // no custom accounts file yet
  }

  const results: PluginAccountStatus[] = [...savedAccounts];
  for (const p of installed) {
    if (results.some((r) => r.pluginId === p.id)) continue;
    const cat = BUILTIN_MARKETPLACE_CATALOG.find(
      (c) => c.id === p.id || c.id.endsWith(`/${p.id}`)
    );
    const acctName = `${p.id.replace(/[^a-z0-9]/gi, '_')}_default`;
    results.push({
      pluginId: p.id,
      pluginName: p.name,
      provider: cat?.authProvider || 'workspace-local',
      signedIn: true,
      accounts: [
        {
          accountName: acctName,
          label: 'default',
          identity: 'workspace-user@local',
          isDefault: true,
          envPrefix: `AGY_ACCOUNT=${acctName}`,
        },
      ],
      poweredClis: cat?.cliNames || [p.id],
    });
  }

  return {
    ok: true,
    accounts: results,
    usageHint:
      'When a provider has multiple accounts connected, select one for a CLI command by prefixing the command with AGY_ACCOUNT=<accountName>.',
  };
}


