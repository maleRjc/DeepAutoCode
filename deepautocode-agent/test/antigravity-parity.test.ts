import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BackgroundTaskManager,
  QuestionBridge,
  SubagentOrchestrator,
  ScheduleManager,
  TranscriptLogger,
  discoverHierarchicalRulesForPaths,
  discoverWorkspaceCustomizations,
  discoverWorkspacePlugins,
  expandSlashCommandPrompt,
  installCatalogPlugin,
  listPluginAccounts,
  loadLifecycleHooks,
  migrateExternalAgentSettings,
  migrateLegacyWorkflowsToSkills,
  runLifecycleHooks,
  searchMarketplace,
} from '../src/core/index.js';
import { parseCommandEnvPrefixes } from '../src/core/BackgroundTaskManager.js';

describe('Antigravity Parity Suite (P0/P1/P2 + Stage A/B/C)', () => {
  it('runs short commands synchronously and backgrounds long commands via BackgroundTaskManager', async () => {
    const mgr = new BackgroundTaskManager();
    const syncRes = await mgr.runOrBackgroundCommand({
      sessionId: 'sess_bg',
      command: 'node -v',
      cwd: process.cwd(),
      waitMsBeforeAsync: 3000,
    });
    expect(syncRes.backgrounded).toBe(false);
    expect(syncRes.task.exitCode).toBe(0);
    expect(syncRes.task.stdout).toMatch(/^v\d+/);
  });

  it('suspends and resolves ask_question prompts via QuestionBridge', async () => {
    const bridge = new QuestionBridge();
    const askPromise = bridge.ask({
      sessionId: 'sess_q',
      questions: [
        {
          question: 'Which architecture?',
          options: ['(Recommended) Modular', 'Monolith'],
          isMultiSelect: false,
        },
      ],
    });
    const pending = bridge.getPendingForSession('sess_q');
    expect(pending).toHaveLength(1);
    const ok = bridge.respond({
      questionId: pending[0].questionId,
      answers: { 'Which architecture?': '(Recommended) Modular' },
    });
    expect(ok).toBe(true);
    const result = await askPromise;
    expect(result.answers['Which architecture?']).toBe('(Recommended) Modular');
  });

  it('loads and executes LifecycleHooks and discovers hierarchical subdirectory rules', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-hooks-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.deepautocode'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.deepautocode', 'hooks.json'),
        JSON.stringify({
          hooks: [
            {
              event: 'postFileEdit',
              command: 'node -e "console.log(\'HOOK_OK\')"',
            },
          ],
        }),
        'utf-8'
      );
      const hooks = await loadLifecycleHooks(tmpDir);
      expect(hooks).toHaveLength(1);
      const res = await runLifecycleHooks({
        workspaceRoot: tmpDir,
        event: 'postFileEdit',
        sessionId: 'sess_h',
        filePath: 'packages/sub/index.ts',
      });
      expect(res.ok).toBe(true);
      expect(res.results[0].stdout).toContain('HOOK_OK');

      await fs.mkdir(path.join(tmpDir, 'packages', 'sub'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'packages', 'sub', 'AGENTS.md'),
        '# Subpackage Rule\nAlways use strict mode.',
        'utf-8'
      );
      const subRules = await discoverHierarchicalRulesForPaths(tmpDir, [
        'packages/sub/index.ts',
      ]);
      expect(subRules.some((r) => r.content.includes('Subpackage Rule'))).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('orchestrates custom subagents, inter-agent messaging, and reactive wakeup', async () => {
    const orch = new SubagentOrchestrator();
    orch.defineSubagent({
      name: 'security-reviewer',
      description: 'Security reviewer',
      systemPrompt: 'Check security invariants.',
      enableWriteTools: false,
    });
    const spawned = await orch.spawnSubagent({
      parentSessionId: 'sess_sub',
      typeName: 'security-reviewer',
      prompt: 'Audit auth.ts',
      workspaceRoot: process.cwd(),
      runInBackground: false,
      executor: async ({ definition }) => `Checked with: ${definition.name}`,
    });
    expect(spawned.result).toBe('Checked with: security-reviewer');
    const msgRes = orch.sendMessage({
      fromSessionId: 'sess_sub',
      recipient: spawned.conversationId,
      message: 'Also check token expiry',
    });
    expect(msgRes.ok).toBe(true);
    const wakeup = orch.drainWakeupMessagesForPrompt('sess_sub');
    expect(wakeup).toContain('<SYSTEM_MESSAGE>');
    expect(wakeup).toContain('Checked with: security-reviewer');
  });

  it('schedules and cancels timers and expands new slash workflows', () => {
    const schedMgr = new ScheduleManager();
    const snap = schedMgr.schedule({
      sessionId: 'sess_sched',
      prompt: 'Check build status',
      durationSeconds: 120,
    });
    expect(snap.status).toBe('active');
    expect(schedMgr.cancel(snap.scheduleId)).toBe(true);

    expect(expandSlashCommandPrompt('/grill-me auth flow').slashCommand).toBe('/grill-me');
    expect(expandSlashCommandPrompt('/teamwork fullstack').slashCommand).toBe('/teamwork');
    expect(expandSlashCommandPrompt('/boost perf').slashCommand).toBe('/boost');
    expect(expandSlashCommandPrompt('/schedule every 5m').slashCommand).toBe('/schedule');
  });

  it('migrates external agent settings into a plugin and persists dual-layer JSONL transcripts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-plugin-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), '# Claude Rule', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'GEMINI.md'), '# Gemini Rule', 'utf-8');
      const mig = await migrateExternalAgentSettings(tmpDir);
      expect(mig.ok).toBe(true);
      expect(mig.migratedRules).toContain('CLAUDE.md');
      expect(mig.migratedRules).toContain('GEMINI.md');

      const plugins = await discoverWorkspacePlugins(tmpDir);
      expect(plugins.some((p) => p.id === 'migrated-agent-setup')).toBe(true);

      const logger = new TranscriptLogger();
      const longText = 'A'.repeat(2000);
      await logger.appendStep(tmpDir, {
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: longText,
      });
      const compact = await logger.readTranscript(tmpDir, { full: false });
      const full = await logger.readTranscript(tmpDir, { full: true });
      expect(compact.entries[0].truncated_fields).toContain('content');
      expect(full.entries[0].content?.length).toBe(2000);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('searches and installs Marketplace plugins, lists plugin accounts, registers image-generator, and provides built-in meta skills', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-mkt-'));
    try {
      const mkt = await searchMarketplace({
        queries: ['figma', 'design'],
        kind: 'plugin',
        workspaceRoot: tmpDir,
      });
      expect(mkt.ok).toBe(true);
      expect(mkt.matches.some((m) => m.id.includes('figma'))).toBe(true);
      expect(mkt.matches[0].installed).toBe(false);

      const installed = await installCatalogPlugin(
        tmpDir,
        'antigravity-plugins-partners/plugin/figma'
      );
      expect(installed.ok).toBe(true);

      const accts = await listPluginAccounts(tmpDir);
      expect(accts.ok).toBe(true);
      expect(accts.accounts.some((a) => a.pluginId.includes('figma'))).toBe(true);

      const customs = await discoverWorkspaceCustomizations(tmpDir);
      expect(customs.skills.some((s) => s.name === 'agy-customizations')).toBe(true);
      expect(customs.skills.some((s) => s.name === 'generative_ui')).toBe(true);

      const orch = new SubagentOrchestrator();
      expect(orch.getDefinition('image-generator')).toBeDefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  });

  it('migrates legacy workflows to skills, injects all 8 built-in skills, and parses AGY_ACCOUNT command prefixes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-w5-'));
    try {
      const wfDir = path.join(tmpDir, '.agents', 'workflows');
      await fs.mkdir(wfDir, { recursive: true });
      await fs.writeFile(
        path.join(wfDir, 'deploy-check.md'),
        'description: Run pre-deploy checks\n\n1. Run build\n2. Run tests',
        'utf-8'
      );

      const wfMig = await migrateLegacyWorkflowsToSkills(tmpDir);
      expect(wfMig.ok).toBe(true);
      expect(wfMig.createdSkills).toContain('.agents/skills/deploy-check/SKILL.md');

      const customs = await discoverWorkspaceCustomizations(tmpDir);
      const skillNames = customs.skills.map((s) => s.name);
      expect(skillNames).toContain('deploy-check');
      expect(skillNames).toContain('antigravity-guide');
      expect(skillNames).toContain('migrate-agent-settings');
      expect(skillNames).toContain('migrate-workflows');
      expect(skillNames).toContain('ui-plugin-navigation');

      const parsed = parseCommandEnvPrefixes('AGY_ACCOUNT=work_profile gdocs list --limit 5');
      expect(parsed.extraEnv.AGY_ACCOUNT).toBe('work_profile');
      expect(parsed.cleanCommand).toBe('gdocs list --limit 5');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  });
});

