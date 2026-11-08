# DeepSeek Enhancement Roadmap (DS-P*)

> Namespace **DS-P0…DS-P4** is distinct from product **P0/P1/P2** in
> [PRODUCT-POSITIONING-AND-P0.md](./PRODUCT-POSITIONING-AND-P0.md).
>
> **已落地实现明细**（文件索引、事件/RPC、验收清单）见
> [DEEPSEEK-IMPLEMENTATION.md](./DEEPSEEK-IMPLEMENTATION.md)。

This roadmap aligns the DeepAutoCode + DeepSeek six-phase plan with code that
already ships. Most items **extend existing hooks**; Trace is the measurement
foundation before Planner/Critic upgrades.

## Dependency graph

```text
DS-P0-1 Trace ──┬──> DS-P0-2 Cache prefix ──> DS-P1-1 Planner ──> DS-P1-2 Critic
                │                                              └──> DS-P2 Edit/FIM
                └──> DS-P1-3 Budget ──> DS-P2-2 Lint gate
DS-P3-1 Rules ──> DS-P3-2 Risk ──> DS-P3-3 Step checkpoints
DS-P4-* after DS-P1/P3
```

## Already / Gap / Hook matrix

| Item | Already have | Gap | Hook files |
| :--- | :--- | :--- | :--- |
| DS-P0-1 Trace | Event bridge + `goal.usage` + session messages | Durable `.deepautocode/traces/*.jsonl` + Task Detail UI | `core/trace/`, `RuntimeFactory`, `SessionBridge` |
| DS-P0-2 Cache | Static system-first assembly; parse `prompt_cache_hit_tokens` | Immutable plan/rules prefix; cache in UI | `RuntimeFactory`, `PromptBuilder`, `providers/` |
| DS-P1-1 Planner | `invoke_subagent(planner)`, Artifacts, `FORCE_AUTO_ACTION` | Pre-Auto JSON plan as immutable context | `ResearchSubagent`, `RuntimeFactory`, `App.tsx` |
| DS-P1-2 Critic | Verifier + heal budgets + circuit breaker | Structured failure taxonomy + typed retry | `RuntimeFactory` finish/heal, `VerifyConfig` |
| DS-P1-3 Budget | Goal 180k + graded compaction + **80% warnBudget / stages** + **provider-token trigger** (Sprint 1.3) | Tighter per-tool live caps in executors | `GoalSteering`, `ContextCompaction`, `AgentLoop` |
| DS-P2 Edit/FIM | Surgical `apply_patch` / `edit_file` | Optional FIM for insert-only | `ApplyPatch`, `RuntimeFactory` |
| DS-P3 Rules/risk/ckpt | Soft inject + hard forbid/ask; **CommandGuard**; **shadow-git after verify**; Mistake/Loop → Trace | Richer once/always approval saves | `CommandGuard`, `ShadowGitCheckpoint`, `MistakeTracker`, `LoopDetection`, `RulePermission` |
| DS-P4 RAG/routing | Tier router Flash/Pro × thinking | History RAG + finer routing knobs | later |


## Sprint 1.1 — Model catalog + thinking + FIM (landed after Trace)

- Provider default: `deepseek-flash` / `deepseek-v4-pro` (legacy `deepseek-chat` / `deepseek-reasoner` aliases kept).
- Router: Flash/Pro × thinking on/off + `reasoning_effort` via `GoalSteering` + `RuntimeFactory` body extras.
- Ghost autocomplete: DeepSeek FIM `/beta/completions` with heuristic fallback.
- Status: model badge, peak/off-peak, estimated CNY cost on `goal.usage`.

## Sprint 1.2 — OpenCode-inspired policy + compaction (landed)

- Hard `forbid` / `ask` rules beat Auto allowlists (`RulePermission` + `evaluateToolPolicy`).
- Plan / read-only turns force `executionMode=plan` at CapabilityRegistry + filter shell mutators.
- Compaction ladder gains `warnBudget` (≥80%), `stage`, `perToolMaxChars`; pressure surfaced on `goal.usage`.
- Details: [DEEPSEEK-IMPLEMENTATION.md](./DEEPSEEK-IMPLEMENTATION.md) §7.

## Sprint 1.3 — Cline-inspired guard / checkpoint / loop (landed)

- **CommandGuard**: Plan/readonly allows investigation shells; blocks `rm`/`git commit`/`npm install`/file redirects.
- **Shadow-git**: after verify pass, commit into `.deepautocode/shadow-git` (does not touch user HEAD).
- **MistakeTracker + LoopDetection**: consecutive tool/content loops → Trace `agent.signal` + self-heal nudge.
- **Compaction**: provider `tokensUsed` alone can raise stage (`trigger: provider_tokens`); stage changes → Trace.
- Details: [DEEPSEEK-IMPLEMENTATION.md](./DEEPSEEK-IMPLEMENTATION.md) §8.

## Sprint 1 (landed)

1. **DS-P0-1 Task Trace** — JSONL under `.deepautocode/traces/`, bridge `trace.*`, Task Detail panel.
2. **Cache metrics** — forward `cacheReadTokens` / `cacheWriteTokens` on `goal.usage` into Composer/status.

## Later sprints

- **DS-P0-2:** freeze rules + plan JSON as byte-stable system prefix.
- **DS-P1-1:** Auto preflight JSON planner → immutable artifact.
- **DS-P1-2:** Critic JSON on gate fail; environment = no retry.
- **DS-P1-3 / DS-P2 / DS-P3 / DS-P4:** measured via Trace.

## Constraints

- Cache prefix immutability once emitted.
- Critic hard caps; environment failures do not retry.
- Checkpoints only after verify pass.
- Rules forbid beats Auto allowlist.
- Trace is the source of truth for optimization claims.

