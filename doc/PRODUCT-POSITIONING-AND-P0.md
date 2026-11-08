# DeepAutoCode 产品定位与 P0 必赢清单

## 定位

DeepAutoCode 是 **Agent-first 自动编码工作台**，不是完整 Cursor / VS Code 替代品。

> DeepSeek 增强路线图使用独立命名空间 **DS-P0…DS-P4**（Trace / 缓存 / Planner / Critic 等），
> 与本文 **P0/P1/P2** 产品必赢清单含义不同。详见
> [DEEPSEEK-ENHANCEMENT-ROADMAP.md](./DEEPSEEK-ENHANCEMENT-ROADMAP.md)；
> 已落地代码说明见 [DEEPSEEK-IMPLEMENTATION.md](./DEEPSEEK-IMPLEMENTATION.md)。

必赢场景：

1. 远端/本地仓库自主修编译与测试失败  
2. `/goal` 类端到端小需求落地并验证  
3. Plan → 确认执行，失败可回滚  

## P0 机制（已落地）

| 项 | 说明 |
|---|---|
| 可配置验证门禁 | 工作区 `.deepautocode/verify.json`；设置中心写入会同步该文件 |
| evolve 沙箱 | Auto 首次写入前创建 `evolve/auto-*` 分支，并推送 `sandbox.branch.created` |
| 熔断回滚 | 自愈 ≥5 次仍失败 → 回滚会话改动，推送 `circuit.breaker.triggered`（与 verify 催促计数独立） |
| Diff 先提案 | 先 `diff.proposed`，再审批/写入；Manual 拒绝审批则 Diff 标 rejected |
| SSH 强同步 | 打开强制 pull；镜像占位为 stub marker，不可当作真实远端内容 |
| 宿主收敛 | 承认 Agent IDE 壳路线；完整 Code-OSS Fork 非当前 P0 |

## verify.json 示例

```json
{
  "buildCommand": "npm run build",
  "testCommand": "npm test",
  "combinedCommand": "npm run build && npm test",
  "sourceGlobs": ["**/*.{ts,tsx,js,jsx}"],
  "enableEvolveSandbox": true
}
```

设置中心保存时还会写出 `.deepautocode/project-rules.md`，Agent 每轮自动注入 system prompt（P1 Rules）。

## P1（已落地）

| 项 | 说明 |
|---|---|
| Rules 注入 | `.agents/rules` + `.deepautocode/project-rules.md` |
| 工作区文件索引 | `WorkspaceFileIndex` 缓存路径，加速本地 `search_codebase` / `explore_codebase`；写文件后失效 |
| Ctrl+I 同链 | Inline Command / CodeLens 走同一 `session.send` Agent 工具链；附带选区范围 + `INLINE_EDIT`/`INLINE_QUERY` 工具提示 |
| 轻量符号大纲 | `outline_file`：TS/JS 用 TypeScript AST，C/C++/其他用增强启发式；输出 `Lstart-Lend: kind name` |

## P2（已落地；Fork 明确不做）

| 项 | 说明 |
|---|---|
| Problems 面板 | Terminal/build 输出解析进 Problems；点击跳转；`@problems` 注入 Agent |
| Go to Symbol | `Ctrl+Shift+O` → `/api/workspace/outline`（CodeOutline） |
| Go to Definition | `F12` → 优先 `/api/lsp/definition`，失败回退启发式搜索 |
| 真语言智能 | TS/JS：进程内 TypeScript Language Service；C/C++：可选 clangd stdio |
| LSP 推荐包 | Open VSX 一键安装 clangd 等 VSIX 到目录 |
| 行级 Diff 高亮 | pending Diff 在编辑器 gutter/行背景标记 add/mod |
| SSH 打磨 | 脏文件保护、Reconnect、Conflict Check / Take Remote |
| Code-OSS Fork | **明确不做**（定位为 Agent IDE 壳，非 VS Code 替代） |

## Cursor 对齐增强（阶段 A/B/C 已落地）

| 项 | 说明 |
|---|---|
| Changes 面板 | 多文件 Diff 清单；Accept / Reject / Revise；Accept All / Reject All |
| Stop 保留 Diff | 中止 Agent 后 pending Diff 保留供审阅 |
| 上下文芯片 | `@git/@terminal/@rules/@problems/@code/@tabs/@folder` + 可移除 chips |
| 检查点 | 改文件后自动 checkpoint；History 可 Restore |
| 模型路由 UI | Auto / Force Fast / Force Reasoner + 当轮 tier 徽章 |
| Ghost 补全 | AbortController 取消过期请求 + 服务端 LRU 缓存 |
| 多语言 UI | 简体中文 / 繁體中文 / English；设置 `ui.locale` 持久化；Guide 与菜单/Composer 同步 |

## Agent 编程能力（持续加强；非 Code-OSS Fork）

| 项 | 说明 |
|---|---|
| 工程级编辑后诊断 | TS/JS：读最近 `tsconfig.json`；C/C++：可选 `clangd --check` / clang；Python：`py_compile`；错误进工具结果并自愈 |
| Problems 自动注入 | 自愈轮自动加载 `.deepautocode/problems.json`，无需用户 `@problems` |
| 独立自愈预算 | verify 催促 ≤4；build/test/语义自愈 ≤5；耗尽后熔断回滚 |
| 增强搜索 | `search_codebase`：`rg` 优先；`regex`/`glob`/`case_sensitive`；`mode=symbol\|content\|auto` |
| 多 hunk / apply_patch | `edit_file.hunks`；`apply_patch` 统一 diff（多文件），失败给最近片段提示 |
| 复杂编辑升档 | 自愈 / 语义失败 / 连续 mismatch / 多文件 pending → reasoner |
| verifier 子代理 | `invoke_subagent(role=verifier)`：诊断 + verify 命令，返回 PASS/FAIL |
| research/planner 子代理 | 多轮 search→outline→read 证据报告（无需嵌套 LLM）；planner 产出步骤 |
| Session Todos | `manage_todo` 清单；自愈续跑注入未完成项；verify 通过可自动勾选 |
| 工具结果摘要压缩 | 上下文过大时对旧 tool 输出做结构化摘要（路径/错误/exit），非硬截断 |
| research 导向再探 | 第 4 轮按任务意图（调用方/测试/报错/导入）生成 follow-up 搜索 |
| Token 分级压缩 | 按工具输出体量 / Goal tokenBudget 提升压缩强度（保留最近 N 条） |
| research 问题拆解 | 启发式拆问 + 可选短 LLM JSON 细化 searchQueries（失败回退启发式） |
| Goal 默认 tokenBudget | 默认 180k；超预算触发 `budget_limit` 续跑总结，并驱动分级压缩 |
| Artifacts 自动呈现 | research/planner/todo/`write_artifact` 写入 Artifacts，并推送 `artifact.created` 刷新 IDE |
| Plan 一键执行 | Artifacts 对 plan/task_list/report 注入 `[FORCE_AUTO_ACTION]` + manage_todo/apply_patch 落地 |
| Token 用量 UI | `goal.usage` / `model.tier` 携带 used/budget；Composer 与状态栏实时显示 |
| MCP 运行时 | `.deepautocode/mcp.json` + Settings；stdio / SSE / Streamable HTTP + Headers/Bearer；tools + resources/prompts |
| Live 诊断 / Diff Jump | 边打字 debounce LSP→Problems→gutter；聊天工具卡 ↗ Jump Diff hunk |
| 语义检索 / ignore | 本地 TF-IDF `mode=semantic` + `@codebase`；`.cursorignore` / `.deepautocodeignore` |
| Agent 浏览器 | CDP 优先（click/type/screenshot），HTTP snapshot 回退 |
| 并行 worktree | ∥ Parallel → `.deepautocode/worktrees/<session>` 隔离工作树 |
| apply_patch 加固 | 首处匹配（非全局替换）、Add/Delete、多文件内存应用失败回滚；扩测 |
| Skills / .cursor/rules | SKILL.md 正文注入；扫描 `.cursor/rules/**` |
| 编辑失败恢复提示 | edit mismatch ≥2 强制 re-read 后再试 |
| Composer 队列 | 运行中 Send 入队 follow-up（最多 5） |
| Hunk Accept | Changes 按 hunk Accept/Reject；`diff.updateProposed` 重建 proposed |
| @ picker 增强 | ↑↓ Enter Esc；最近标签 + 更多文件 |
| Checkpoint 时间线 | Composer 顶部 Preview/Restore |
| Problems 诊断桥 | 编辑后合并 `.deepautocode/problems.json` 中该文件问题进工具结果/自愈 |
| 嵌套 LLM research | `invoke_subagent` research/planner：预算制 synthesize（失败回退启发式） |

## UI 事件

- `sandbox.branch.created`：状态栏 + 日志显示 evolve 分支  
- `circuit.breaker.triggered`：提示已回滚文件数并刷新树/Git  
- `artifact.created`：Artifacts 面板刷新；plan/research 自动切到 Artifacts  
- `goal.usage`：Goal token used/budget/remaining 实时刷新 Composer/状态栏  

