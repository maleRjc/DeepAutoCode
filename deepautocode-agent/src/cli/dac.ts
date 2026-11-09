#!/usr/bin/env node
import path from 'node:path';
import {
  discoverWorkspaceCustomizations,
  discoverWorkspacePlugins,
  loadLifecycleHooks,
  loadVerifyConfig,
  migrateExternalAgentSettings,
  globalSubagentOrchestrator,
} from '../core/index.js';
import { CapabilityRegistry } from '../capabilities/CapabilityRegistry.js';
import { EncryptedFileSecretStorage, ProviderManager } from '../../providers/index.js';
import { BackendManager } from '../runtime/BackendManager.js';
import { RuntimeFactory, type ClineRuntimeEvent } from '../runtime/RuntimeFactory.js';

function printHelp(): void {
  console.log(`DeepAutoCode CLI (dac / agy) v1.1.0 — Antigravity Headless & Terminal Runner

Usage:
  dac run "<prompt>" [--workspace <dir>] [--mode auto|plan]
  dac plan "<prompt>" [--workspace <dir>]
  dac status [--workspace <dir>]
  dac migrate [--workspace <dir>]
  dac help
`);
}

function parseFlags(argv: string[]): {
  command: string;
  prompt: string;
  workspace: string;
  mode: 'auto' | 'plan' | 'manual';
} {
  const args = [...argv];
  const command = (args.shift() || 'help').toLowerCase();
  let workspace = process.cwd();
  let mode: 'auto' | 'plan' | 'manual' = command === 'plan' ? 'plan' : 'auto';
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--workspace' || a === '-w') && args[i + 1]) {
      workspace = path.resolve(args[++i]);
    } else if ((a === '--mode' || a === '-m') && args[i + 1]) {
      const m = args[++i].toLowerCase();
      if (m === 'plan' || m === 'auto' || m === 'manual') mode = m;
    } else {
      promptParts.push(a);
    }
  }

  return {
    command,
    prompt: promptParts.join(' ').trim(),
    workspace,
    mode,
  };
}

export async function runDacCli(argv = process.argv.slice(2)): Promise<number> {
  const { command, prompt, workspace, mode } = parseFlags(argv);

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  if (command === 'status') {
    const [customs, plugins, hooks, verifyCfg, subagents] = await Promise.all([
      discoverWorkspaceCustomizations(workspace),
      discoverWorkspacePlugins(workspace),
      loadLifecycleHooks(workspace),
      loadVerifyConfig(workspace),
      globalSubagentOrchestrator.loadWorkspaceSubagents(workspace),
    ]);
    console.log(
      JSON.stringify(
        {
          workspace,
          verifyConfig: verifyCfg,
          rulesCount: customs.rules.length,
          skillsCount: customs.skills.length,
          workflowsCount: customs.workflows.length,
          plugins: plugins.map((p) => ({ id: p.id, name: p.name, skills: p.skills.length, rules: p.rules.length })),
          lifecycleHooksCount: hooks.length,
          subagents: globalSubagentOrchestrator.listDefinitions().map((d) => d.name),
          workspaceSubagentsLoaded: subagents.length,
        },
        null,
        2
      )
    );
    return 0;
  }

  if (command === 'migrate') {
    const res = await migrateExternalAgentSettings(workspace);
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }

  if (command === 'run' || command === 'plan') {
    if (!prompt) {
      console.error('Error: prompt is required for `dac run` or `dac plan`.');
      printHelp();
      return 1;
    }
    const dataDir = path.join(workspace, '.deepautocode-data');
    const secretStorage = new EncryptedFileSecretStorage(path.join(dataDir, 'secrets.enc'));
    const providerManager = new ProviderManager(secretStorage);
    const capabilityRegistry = new CapabilityRegistry();
    const backendManager = new BackendManager({ initialMode: 'local' });
    const runtime = await RuntimeFactory.create({
      storageDir: dataDir,
      backendManager,
      capabilityRegistry,
      providerManager,
    });

    runtime.subscribe((ev: ClineRuntimeEvent) => {
      if (ev.type === 'text_delta' && ev.payload?.delta) {
        process.stdout.write(String(ev.payload.delta));
      } else if (ev.type === 'tool_call_started') {
        console.error(`\n[Tool] ▶ ${ev.payload.toolName}`);
      }
    });

    const effectivePrompt = command === 'plan' && !prompt.startsWith('/plan') ? `/plan ${prompt}` : prompt;
    const started = await runtime.start({
      title: `CLI: ${effectivePrompt.slice(0, 36)}`,
      config: {
        cwd: workspace,
        workspaceRoot: workspace,
        providerId: 'deepseek',
        modelId: 'deepseek-auto',
        executionMode: mode,
      },
    });
    await runtime.send({
      sessionId: started.sessionId,
      prompt: effectivePrompt,
      workspaceRoot: workspace,
      executionMode: mode,
    });
    process.stdout.write('\n');
    return 0;
  }

  printHelp();
  return 1;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('dac.js') || process.argv[1]?.endsWith('dac.ts')) {
  void runDacCli().then((code) => {
    process.exitCode = code;
  });
}
