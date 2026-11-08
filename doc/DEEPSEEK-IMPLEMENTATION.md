# DeepSeek 增强实现说明（已落地）

> 本文档整理 DeepAutoCode 当前**已经实现**的 DeepSeek 增强能力，作为工程交接与验收对照。  
> 路线图与待办见 [DEEPSEEK-ENHANCEMENT-ROADMAP.md](./DEEPSEEK-ENHANCEMENT-ROADMAP.md)。  
> 产品级 P0/P1（验证门禁、evolve、熔断等）见 [PRODUCT-POSITIONING-AND-P0.md](./PRODUCT-POSITIONING-AND-P0.md)。  
> 命名空间约定：**DS-P\*** = DeepSeek 增强；**P0/P1/P2** = 产品必赢清单，二者不要混用。

---

## 1. 总览

围绕 DeepSeek 官方 V4 API（`deepseek-flash` / `deepseek-v4-pro`、1M 上下文、Thinking、FIM、峰谷定价），在现有 Code-OSS + Cline SDK 架构上**扩展**，而不是重写 Agent 循环。

| 批次 | 主题 | 状态 |
| :--- | :--- | :--- |
| Sprint 1 | DS-P0-1 Task Trace + `goal.usage` 缓存指标 + Task Detail UI | **已落地** |
| Sprint 1.1 | 模型目录迁移、Thinking 透传、路由升级、FIM 幽灵补全、峰谷/成本状态栏 | **已落地** |
| Sprint 1.2 | OpenCode 借鉴：硬 forbid/ask、Plan 硬只读、压缩阶梯 warnBudget | **已落地** |
| Sprint 1.3 | Cline 借鉴：CommandGuard、shadow-git、Mistake/Loop、provider-token 压缩 | **已落地** |
| 后续 | DS-P0-2 不可变缓存前缀、Planner/Critic JSON 等 | 未做（见路线图） |

```text
Webview (App.tsx)
  ├─ Composer / Status：model.tier + goal.usage（tok / cache / ¥ / peak）
  ├─ Task Detail 页签：trace.get / trace.updated
  └─ Ghost Text：POST /api/ai/autocomplete → FIM（失败回退启发式）
        │
Workbench Server ──► AgentClientBridge
                        ├─ SessionBridge ← RuntimeFactory events
                        ├─ ProviderManager（deepseek-flash / v4-pro）
                        └─ TaskTraceStore → .deepautocode/traces/*.jsonl
```

---

## 2. Sprint 1 — Task Trace 与缓存指标

### 2.1 目标

让每一次 Auto/会话回合可测量：LLM 轮次、工具、验证、终态，以及 DeepSeek 缓存命中 token，作为后续 Planner/Critic/缓存优化的**唯一观测面**。

### 2.2 核心模块：`TaskTraceStore`

| 项 | 说明 |
| :--- | :--- |
| 源码 | `deepautocode-agent/src/core/trace/TaskTrace.ts` |
| 导出 | `deepautocode-agent/src/core/index.ts` → `@deepautocode/agent` |
| 单例 | `globalTaskTraceStore` |
| 持久化 | `{workspaceRoot}/.deepautocode/traces/{taskId}.jsonl`（逐行 JSONL） |
| 内存 | 按 task 保留事件（上限约 500）；全局 ring 约 40 个 task |

**事件种类 (`TraceEventKind`)**

| kind | 含义 | 主要字段 |
| :--- | :--- | :--- |
| `task.start` | 回合开始 | `mode`, `promptSummary`, `modelId` |
| `llm.turn` | 一次模型调用 | `turnIndex`, `modelId`, `latencyMs`, in/out/cache tokens |
| `tool.call` | 一次工具 | `toolName`, `argDigest`, `resultBytes`, `durationMs`, `ok` |
| `verify.result` | 构建/测试门禁 | `passed`, `summary` |
| `task.end` | 终态 | `status`: `success` / `circuit` / `abort` / `error` |

**辅助函数**：`digestArgs`、`summarizePrompt`、`estimateResultBytes`。

### 2.3 Runtime 挂钩点

文件：`deepautocode-agent/src/runtime/RuntimeFactory.ts`

| 时机 | 行为 |
| :--- | :--- |
| `send()` 开始 | `startTask` → 内部事件 `trace_updated` |
| LLM usage 块 | `recordLlmTurn`（含 cache / latency） |
| `runCapabilityTool` 完成/失败 | `recordToolCall` |
| build/test `recordCommandOutcome` | `recordVerify` |
| 熔断 | `onCircuitTriggered` → 终态倾向 `circuit` |
| `send()` finally | `endTask` |

每次写入后通过 `emitTraceUpdated` 推送 `{ taskId, event, snapshot }`。

### 2.4 Bridge 协议

| 层 | 内容 |
| :--- | :--- |
| 内部 Runtime 事件 | `trace_updated`、`goal_usage`、`model_tier` … |
| 对外 Event | `trace.updated`、`goal.usage`、`model.tier`（`SessionBridge` 映射） |
| Schema | `deepautocode-agent/src/types.ts` → `EventMessageSchema` / `RequestMessageSchema` |
| Webview 类型 | `deepautocode/webview/src/bridgeClient.ts` |

**RPC**

| type | 入参 | 返回 |
| :--- | :--- | :--- |
| `trace.get` | `{ taskId? }` 或 `{ sessionId? }` | `TaskTraceSnapshot \| null` |
| `trace.list` | `{ limit? }` | `TaskTraceSnapshot[]` |

实现：`SessionBridge.getTrace` / `listTraces`；`AgentClientBridge` case 分发。

> UI 当前只用 `trace.get` + 实时 `trace.updated`，未调用 `trace.list`。

### 2.5 `goal.usage` 缓存字段

在原有 `tokensUsed` / `tokenBudget` / `remaining` 基础上，Runtime 已转发：

| 字段 | 含义 |
| :--- | :--- |
| `inputTokens` / `outputTokens` | 本轮 |
| `cacheReadTokens` / `cacheWriteTokens` | 本轮缓存命中 / miss（DeepSeek `prompt_cache_hit_tokens` 等） |
| `cacheReadTokensTotal` / `cacheWriteTokensTotal` | 本 task 累计（来自 Trace snapshot） |
| `latencyMs` / `modelId` / `taskId` / `turnIndex` | 观测元数据 |
| `thinkingEnabled` | 本轮是否思考模式（Sprint 1.1） |
| `estimatedCostCny` / `estimatedCostCnyTotal` | 本轮/累计估算费用 CNY（Sprint 1.1） |
| `peakHour` | 是否峰时计价（Sprint 1.1） |

解析来源（DeepSeek usage）：

- `prompt_cache_hit_tokens` 或 `prompt_tokens_details.cached_tokens`
- `prompt_cache_miss_tokens`

### 2.6 Task Detail UI

| 项 | 说明 |
| :--- | :--- |
| 文件 | `deepautocode/webview/src/App.tsx` |
| 页签 | AI Dock → **Task Detail**（`aiTab === 'trace'`） |
| i18n | `dock.trace` / `trace.empty` / `trace.refresh` / `trace.cache`（en / zh-CN / zh-TW） |
| 数据 | `activeTaskTrace`；`refreshTaskTrace()` → `trace.get`；事件 `trace.updated` |
| 展示 | taskId、status、prompt 摘要、turns、tok、cache；时间线（llm / tool / verify / start / end） |

Composer / 状态栏同步展示 **tok used/budget** 与 **cache hit**。

### 2.7 测试

- `deepautocode-agent/tests/task-trace.test.ts`  
  JSONL 生命周期、helpers、`goal.usage` / `trace.updated` schema。

---

## 3. Sprint 1.1 — 模型目录、Thinking、FIM、成本

### 3.1 模型目录与别名

文件：`deepautocode-agent/providers/index.ts`

| modelId | 角色 |
| :--- | :--- |
| `deepseek-flash` | **默认**；日常编码、FIM、快速工具轮 |
| `deepseek-v4-pro` | 复杂调试 / Plan / 自愈深度推理 |
| `deepseek-chat` | 遗留别名 → 按 Flash 路径路由 |
| `deepseek-reasoner` | 遗留别名 → 按 Pro + thinking 路径路由 |

上下文窗口元数据：`1_000_000`；Flash `supportsVision: true`，Pro `false`。

常量与归一化：`deepautocode-agent/src/core/DeepSeekModels.ts`

- `DEEPSEEK_FLASH` / `DEEPSEEK_V4_PRO` / `DEEPSEEK_AUTO`
- `normalizeDeepSeekApiModelId`（含 `deepseek-v4-flash` 等历史名）
- `isDeepSeekModelId` / `isLegacyReasonerAlias`

默认激活：`ProviderManager.activeModelId = 'deepseek-flash'`。  
会话恢复默认：`SessionBridge` → `deepseek-flash`。

### 3.2 Thinking / `reasoning_effort` 透传

依据官方 Thinking Mode（OpenAI 兼容）：

```json
{
  "thinking": { "type": "enabled" | "disabled" },
  "reasoning_effort": "low" | "high" | "max"
}
```

实现：

| 符号 | 文件 |
| :--- | :--- |
| `buildDeepSeekRequestControls` | `DeepSeekModels.ts` |
| `deepSeekChatBodyExtras` | 同上 |
| 请求组装 | `RuntimeFactory` `clineModelAdapter.stream` |

行为要点：

- Thinking 开启时**不传** `temperature`（官方规定无效）。
- 带 `tools` 时，历史 assistant 的 `reasoning_content` 会回传（否则 DeepSeek 400）。
- 子代理 / 分解等轻量调用固定 `deepseek-flash`。

### 3.3 路由：`resolveTieredModelForTurn`

文件：`deepautocode-agent/src/core/GoalSteering.ts`

返回：

```ts
{
  effectiveModelId: string;      // deepseek-flash | deepseek-v4-pro
  thinkingEnabled: boolean;
  reasoningEffort: 'low' | 'high' | 'max' | null;
  tier: 'fast-tool' | 'deep-reasoner' | 'default';
  reason: string;
}
```

| 场景 | 模型 | Thinking |
| :--- | :--- | :--- |
| UI Force Flash / `force-fast` | flash | 关 |
| UI Force V4-Pro / `force-reasoner` | v4-pro | 开 · high |
| Turn 1 发现（未读文件） | flash | 关 |
| 改后 verify | flash | 关 |
| Auto 日常（暖上下文） | flash | 开 · low |
| 自愈 / 构建失败 / 语义失败 / 多次 mismatch / 多文件 | v4-pro | 开 · high |
| 已读文件后的根因诊断 | v4-pro | 开 · high |

UI `routingMode` 判定（RuntimeFactory）：

- `deepseek-v4-pro` / `deepseek-reasoner` / `force-reasoner` → `force-reasoner`
- `deepseek-flash` / `deepseek-chat` / `force-fast` → `force-fast`
- `deepseek-auto` → `auto`

`model.tier` 事件额外字段：`thinkingEnabled`、`reasoningEffort`、`peakHour`。

### 3.4 峰谷与估算成本

`DeepSeekModels.ts`：

| 符号 | 说明 |
| :--- | :--- |
| `isDeepSeekPeakHour` | UTC 工作日 01:00–04:00 与 06:00–10:00（= 北京 09–12 / 14–18）；周末 off-peak |
| `DEEPSEEK_PRICE_CNY_PER_M` | Flash/Pro × peak/offPeak 的 cacheHit / cacheMiss / output（CNY / 1M） |
| `estimateDeepSeekTurnCostCny` | 按本轮 in/out/cache 估算 |
| `formatCostCny` | 展示辅助 |

注意：费用为**粗算**，以官方账单为准；未计入 Search/Fetch 等独立 API。

### 3.5 FIM 幽灵补全

| 层 | 路径 / 行为 |
| :--- | :--- |
| 客户端 | `completeDeepSeekFim` — `deepautocode-agent/src/core/DeepSeekFim.ts` |
| 默认 endpoint | `https://api.deepseek.com/beta/completions` |
| 模型 | 仅 `deepseek-flash`（非思考；官方限制） |
| Bridge RPC | `completion.fim`（`prompt`/`prefix` + `suffix` + `maxTokens`） |
| HTTP | Workbench `POST /api/ai/autocomplete` — **优先 FIM**，失败/无 Key → 原启发式 |
| UI | `App.tsx` debounce 幽灵文本；Tab 接受、Esc 拒绝；状态栏 Autocomplete ON/OFF |

响应可含 `source: 'fim' | 'heuristic'`。多行建议截断至约 8 行，避免刷屏。

> Webview **未直接**调 `completion.fim`，统一走 `/api/ai/autocomplete`。

### 3.6 UI：Composer 与状态栏仪表

文件：`deepautocode/webview/src/App.tsx`

**Composer 模型下拉**

- `deepseek-auto` — Auto Router (Flash/Pro)
- `deepseek-flash` — Force Flash
- `deepseek-v4-pro` — Force V4-Pro
- 遗留 chat / reasoner 选项保留

**徽章 / 状态栏**

- 当前路由模型 + `·think[:effort]` + `peak` / `off-peak`
- `tok used/budget` + cache + `¥…` 累计估算

设置页模型提示文案：`webview/src/i18n/settingsMessages.ts`（flash / v4-pro）。

### 3.7 测试

| 文件 | 覆盖 |
| :--- | :--- |
| `tests/deepseek-models.test.ts` | 别名归一化、thinking extras、峰时、成本、路由、FIM mock |
| `tests/agent-bridge.test.ts` | 默认 flash、thinking body、分阶段路由、reasoner 遗留别名 → pro |
| `tests/session-checkpoint.test.ts` | force-fast / force-reasoner 期望 flash / v4-pro |

---

## 4. 关键事件与 RPC 一览

### 4.1 Events（Webview ← Extension/Agent）

| type | 主要 payload |
| :--- | :--- |
| `goal.usage` | tok / cache / cost / peak / model / thinking |
| `model.tier` | configured / effective / tier / reason / thinking / peak |
| `trace.updated` | `{ taskId, event, snapshot }` |
| （既有）`circuit.breaker.triggered` / `sandbox.branch.created` / `diff.*` / … | 产品 P0，见定位文档 |

### 4.2 Requests（Webview → Agent）

| type | 用途 |
| :--- | :--- |
| `trace.get` / `trace.list` | 读 Trace |
| `completion.fim` | 直接 FIM（服务端补全亦可用 Provider Key 直连） |
| （既有）`session.*` / `provider.*` / `diff.*` / … | 会话与审批 |

---

## 5. 关键源码索引

| 领域 | 路径 |
| :--- | :--- |
| Trace | `deepautocode-agent/src/core/trace/TaskTrace.ts` |
| DeepSeek 模型/峰谷/成本 | `deepautocode-agent/src/core/DeepSeekModels.ts` |
| FIM 客户端 | `deepautocode-agent/src/core/DeepSeekFim.ts` |
| 路由 | `deepautocode-agent/src/core/GoalSteering.ts` |
| Runtime 挂钩 | `deepautocode-agent/src/runtime/RuntimeFactory.ts` |
| Provider 目录 | `deepautocode-agent/providers/index.ts` |
| Bridge | `SessionBridge.ts` / `AgentClientBridge.ts` |
| 协议 Schema | `deepautocode-agent/src/types.ts` |
| 包导出 | `deepautocode-agent/src/core/index.ts`、`src/index.ts` |
| 补全 HTTP | `deepautocode/src/workbench-server/server.ts` |
| UI | `deepautocode/webview/src/App.tsx` |
| Bridge 客户端类型 | `deepautocode/webview/src/bridgeClient.ts` |
| i18n | `webview/src/i18n/messages.ts`、`settingsMessages.ts` |

---

## 6. 验收清单（手工）

1. **模型**：新会话默认 `deepseek-flash`；Force V4-Pro 时请求体含 `model: deepseek-v4-pro` 与 `thinking.enabled`。
2. **Trace**：跑一轮 Auto 后，工作区出现 `.deepautocode/traces/trc_*.jsonl`；AI Dock → Task Detail 可见 llm/tool 时间线。
3. **Cache UI**：有缓存命中时 Composer/状态栏出现 cache 数字；`goal.usage` 含 `cacheReadTokens*`。
4. **成本 / 峰谷**：状态栏显示 `peak` 或 `off-peak` 与 `¥` 估算（有真实 usage 后）。
5. **FIM**：配置 DeepSeek API Key，编辑器停顿后幽灵文本；无 Key 或失败时仍可用启发式，不打断输入。
6. **遗留别名**：选 `deepseek-reasoner` 仍可跑，实际 API model 为 `deepseek-v4-pro` + thinking。

---

## 7. Sprint 1.2 — OpenCode 借鉴（权限 / Plan 硬只读 / 压缩阶梯）

借鉴 [opencode-dev](../../opensource/opencode-dev) 的 **allow|deny|ask** 与压缩阶梯理念，落到现有 Cline 链路上（非 Effect 整仓移植）。

### 7.1 硬规则 forbid → deny / ask（DS-P3）

| 项 | 说明 |
| :--- | :--- |
| 模块 | `deepautocode-agent/src/core/RulePermission.ts` |
| 解析 | 规则 frontmatter / 正文行：`forbid:` / `deny:` / `ask:`（及 `permissions:` 列表） |
| 策略门 | `security.evaluateToolPolicy`：**硬规则优先于 Auto allowlist** |
| Capability | `CapabilityExecutionContext.permissionRuleset`；`CapabilityRegistry.requestUserApproval` |
| AgentLoop | `toolPolicies` 的 `ask` 不再空操作，走 ApprovalBridge |
| Plan 硬只读 | `isReadOnlyTurn` 时 `policyGate.executionMode = 'plan'`；编辑工具过滤；shell 由 CommandGuard 拦截突变（Sprint 1.3） |

**规则写法示例（写入 `.agents/rules/*.md` 或 `.deepautocode/project-rules.md`）：**

```markdown
---
forbid:
  - write .env*
  - shell rm -rf*
ask:
  - shell npm publish*
---

# 工程约定（仍会软注入 prompt）
forbid: delete secrets/*
```

### 7.2 压缩阶梯 + 80% 警告（DS-P1-3）

| 项 | 说明 |
| :--- | :--- |
| 模块 | `ContextCompaction.resolveCompactionPlan` |
| 新增字段 | `stage` / `warnBudget`（≥80%）/ `perToolMaxChars` |
| 上报 | AgentLoop `context.pressure` → Runtime `goal.usage`（`contextPressure` / `fillRatio`） |

### 7.3 测试

- `tests/rule-permission.test.ts` — 解析、Auto 被 forbid 拦住、ask 强制审批、Plan 只读、warnBudget

---

## 8. Sprint 1.3 — Cline 借鉴（CommandGuard / shadow-git / Mistake·Loop / token 压缩）

借鉴 Cline 的 **command-guard**、**mistake-tracker**、**loop detection**、**shadow git checkpoints** 理念，落到现有 CapabilityRegistry / AgentLoop（非整仓移植）。

### 8.1 Plan/readonly CommandGuard

| 项 | 说明 |
| :--- | :--- |
| 模块 | `deepautocode-agent/src/core/CommandGuard.ts` |
| 策略门 | `security.evaluateToolPolicy`：Plan 下允许调查类 shell，拦截突变命令 |
| 执行器 | `CapabilityRegistry` `run-build` + `ToolSuite` `run_commands` 双重校验 |
| Plan 工具策略 | `createToolPoliciesWithPreset('plan')` 对 `run_command(s)` 为 `allow`（编辑仍 deny） |

### 8.2 Shadow-git 步进检查点（验证通过后）

| 项 | 说明 |
| :--- | :--- |
| 模块 | `ShadowGitCheckpoint.ts`（`GIT_DIR=.deepautocode/shadow-git`） |
| 触发 | `recordCommandOutcome` 判定 build/test **通过** 后 |
| 事件 | Runtime `checkpoint.created`（`kind: shadow-git`）+ Trace `agent.signal` / `checkpoint` |

### 8.3 MistakeTracker + LoopDetection

| 项 | 说明 |
| :--- | :--- |
| 模块 | `MistakeTracker.ts` / `LoopDetection.ts` |
| AgentLoop | 工具错误 / 空回复 / 同参重复工具 / 重复助手文本 |
| Runtime | Trace `agent.signal`（mistake/loop）；连续失误 ≥4 → 自愈 nudge |

### 8.4 Provider-token 压缩触发

| 项 | 说明 |
| :--- | :--- |
| `resolveCompactionPlan` | 新增 `trigger: provider_tokens \| tool_chars \| hybrid` |
| AgentLoop | stage 变化即发 `context.pressure`（不限 warnBudget） |
| Trace | `agent.signal` / `compaction` |

### 8.5 测试

- `tests/command-guard-mistake.test.ts` — CommandGuard、Plan 策略、Mistake/Loop、provider-token compaction

---

## 9. 明确未做（避免误认为已交付）

| 项 | 说明 |
| :--- | :--- |
| DS-P0-2 不可变缓存前缀 | 尚未冻结 rules/plan 字节级 system 前缀（cache affinity 未移植） |
| DS-P1 Planner / Critic | 仍用现有 planner 子代理与 heal，无结构化 Critic JSON / Goal judge |
| 高峰强制降级 | 仅展示 peak，不自动静默降级 |
| 思考摘要折叠面板 | `reasoning_content` 已在 Agent 链路中流转，Webview 尚无专用折叠 UI |
| `trace.list` / `completion.fim` 的 Webview 直连 | RPC 已实现，UI 未用 |
| 中国法定节假日 off-peak 日历 | 峰时判定未排除节假日 |
| 费用与官方账单对齐审计 | 仅为客户端粗算 |
| CodeMode / OpenCode / Cline 整仓运行时 | 明确不移植；仅抽取 guard/checkpoint/loop 能力 |

---

## 10. 相关文档

| 文档 | 用途 |
| :--- | :--- |
| [DEEPSEEK-ENHANCEMENT-ROADMAP.md](./DEEPSEEK-ENHANCEMENT-ROADMAP.md) | DS-P\* 路线与矩阵 |
| [PRODUCT-POSITIONING-AND-P0.md](./PRODUCT-POSITIONING-AND-P0.md) | 产品定位与 P0 机制 |
| [BOOTSTRAPPING-AND-SELF-EVOLUTION.md](./BOOTSTRAPPING-AND-SELF-EVOLUTION.md) | 自举与演进 |
| `deepautocode/docs/USER-GUIDE.md` | 用户向使用说明（Token / mode 等） |

---

*文档对应代码状态：Sprint 1 + 1.1 + 1.2 + 1.3（CommandGuard / shadow-git / Mistake·Loop / provider-token 压缩）已落地；后续变更请同步更新验收与「未做」列表。*
