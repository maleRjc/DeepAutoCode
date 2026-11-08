import { describe, expect, it } from 'vitest';
import {
  compileRulesFromDocuments,
  evaluatePermissionRules,
  evaluateToolPolicy,
} from '../src/index.js';
import { overlayToolPoliciesWithHardRules, createToolPoliciesWithPreset } from '../src/core/ToolSuite.js';
import { resolveCompactionPlan } from '../src/core/ContextCompaction.js';

describe('RulePermission hard forbid/ask', () => {
  it('parses frontmatter permissions and body forbid lines', () => {
    const rules = compileRulesFromDocuments([
      {
        path: '.agents/rules/security.md',
        raw: `---
forbid:
  - write **/.env*
  - shell rm -rf*
ask:
  - shell npm publish*
---

# Notes
forbid: delete secrets/**
`,
      },
    ]);
    expect(rules.length).toBeGreaterThanOrEqual(3);

    const envDeny = evaluatePermissionRules('write', 'apps/.env.local', rules);
    expect(envDeny.effect).toBe('deny');

    const publishAsk = evaluatePermissionRules('shell', 'npm publish', rules);
    expect(publishAsk.effect).toBe('ask');

    const normal = evaluatePermissionRules('write', 'src/app.ts', rules);
    expect(normal.effect).toBe('allow');
  });

  it('beats Auto allowlist in evaluateToolPolicy', () => {
    const ruleset = compileRulesFromDocuments([
      {
        path: 'project-rules.md',
        raw: 'forbid: write **/*.pem\nask: shell curl *\n',
      },
    ]);

    const denied = evaluateToolPolicy({
      toolName: 'write-file',
      executionMode: 'auto',
      isReadOnlyTool: false,
      targetPath: 'certs/prod.pem',
      workspaceRoot: process.cwd(),
      permissionRuleset: ruleset,
    });
    expect(denied.allowedToProceed).toBe(false);
    expect(denied.reason).toMatch(/RULE_FORBID/);

    const asked = evaluateToolPolicy({
      toolName: 'run-build',
      executionMode: 'auto',
      isReadOnlyTool: false,
      command: 'curl https://example.com',
      workspaceRoot: process.cwd(),
      permissionRuleset: ruleset,
    });
    expect(asked.allowedToProceed).toBe(true);
    expect(asked.requiresApproval).toBe(true);
    expect(asked.ruleEffect).toBe('ask');
  });

  it('overlays yolo policies to deny/ask', () => {
    const yolo = createToolPoliciesWithPreset('yolo');
    expect(yolo.write_file).toBe('allow');
    const ruleset = compileRulesFromDocuments([
      { path: 'r.md', raw: 'forbid: write *\nask: shell *\n' },
    ]);
    const overlaid = overlayToolPoliciesWithHardRules(yolo, ruleset);
    expect(overlaid.write_file).toBe('deny');
    expect(overlaid.run_command).toBe('ask');
  });
});

describe('Plan hard readonly policy', () => {
  it('blocks mutating capabilities in plan mode', () => {
    const blocked = evaluateToolPolicy({
      toolName: 'write-file',
      executionMode: 'plan',
      isReadOnlyTool: false,
      targetPath: 'src/a.ts',
      workspaceRoot: process.cwd(),
    });
    expect(blocked.allowedToProceed).toBe(false);
    expect(blocked.reason).toMatch(/read-only/i);
  });
});

describe('Compaction ladder warnBudget', () => {
  it('flags 80% warning and stages', () => {
    const mid = resolveCompactionPlan({
      toolResultChars: 40_000,
      tokenBudget: 100_000,
      tokensUsed: 82_000,
    });
    expect(mid.warnBudget).toBe(true);
    expect(mid.shouldCompact).toBe(true);
    expect(mid.stage).not.toBe('none');
    expect(mid.perToolMaxChars).toBeGreaterThan(0);

    const low = resolveCompactionPlan({ toolResultChars: 1_000, tokenBudget: 100_000, tokensUsed: 1_000 });
    expect(low.warnBudget).toBe(false);
    expect(low.stage).toBe('none');
  });
});
