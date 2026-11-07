# DeepAutoCode 架构决策记录 (ADR-001 至 ADR-010) 及 Phase 0 PoC 实测报告

## 1. 架构决策记录 (ADR 001–010)

| ADR 编号 | 决策主题 | 最终结论与工程落地位置 |
| :--- | :--- | :--- |
| **ADR-001** | IDE 编辑器底座 | 采用 **Code - OSS** 作为 IDE 宿主底座，独立品牌配置位于 `deepautocode/product/product.json`，控制 Fork 差异以降低上游合并冲突成本。 |
| **ADR-002** | 仓库拓扑收敛 | 收敛为 `deepautocode`（IDE/UI/Docs）与 `deepautocode-agent`（Runtime Bridge/Providers）**双仓库**；原 Models 并入 `deepautocode-agent/providers/`，原 Docs 并入 `deepautocode/docs/`；`scripts/create-repos.sh` 已移除冗余仓库。 |
| **ADR-003** | Agent 运行时复用 | 锁定并集成 `@cline/sdk@0.2.0` (`@cline/core@0.2.0`)，复用其会话与运行时概念，不重复造第二套 Agent 平台。 |
| **ADR-004** | Webview 与消息桥接 | AI 面板采用 **React 18 + Vite 5** 构建 (`deepautocode/webview/`)，通过受 CSP Nonce 保护的 `postMessage / onDidReceiveMessage` 与 Extension Host 通信，Webview 零依赖 `@cline/sdk` 内部类型。 |
| **ADR-005** | 默认模型与解耦 | **DeepSeek (`deepseek-chat` / `deepseek-reasoner`)** 作为默认开箱即用 Provider，同时内置 `OpenAI-Compatible`（Ollama / vLLM / 企业网关）与 `Anthropic` 热切换能力，密钥仅存入 OS 凭据存储 (`SecretStorage`)。 |
| **ADR-006** | 运行时后端基线 | 首期以 `local`（进程内执行 + 本地持久化）作为基准模式，同时支持 `auto`（本地 Hub 探测与自动回退 `local`）、`hub` 与 `remote` 模式。 |
| **ADR-007** | 扩展市场 P0 策略 | 默认绑定 **Open VSX** 注册表，在 `product/extensions-matrix.json` 中维护 16 个核心扩展兼容性矩阵（如使用 `BasedPyright` 替代闭源 Pylance，使用 `open-remote-ssh` 替代 Remote-SSH，使用 `clangd` 替代 cpptools），并提供带法律授权确认的本地 VSIX 安装流程。 |
| **ADR-008** | 安全、权限与 Diff | 在 `src/security.ts` 与 `ApprovalBridge.ts` 中强制执行路径规范化（防 `..` 与符号链接逃逸）、`Plan` 模式严格只读、`Auto` 模式安全白名单、高危命令/写入显式审批、日志密钥脱敏与 Diff 审阅闭环。 |
| **ADR-009** | `local` 持久化与恢复分离 | 将 `local` 验证拆分为 **PoC-L1（落盘写入）** 与 **PoC-L2（跨实例发现与恢复）**；在 `PersistentClineCoreRuntime` 与 `SessionBridge` 中提供 `session-index.json` 与 `sessions/<id>/{manifest,messages,diffs}.json` 跨进程恢复保障。 |
| **ADR-010** | Capability 映射实测 | 在 `CapabilityRegistry.ts` 与 `extensions/deepautocode-ai/src/extension.ts` 中完成 5 项核心 Capability 到 `vscode.*` API 的端到端映射、Zod 参数校验、超时取消与审计记录。 |

---

## 2. Phase 0 PoC 核验记录 (附录 A 实测结论)

1. **`@cline/sdk` 锁版与环境兼容核验**：
   * 包名与精确版本：`@cline/sdk@0.2.0` / `@cline/core@0.2.0`（许可证：`Apache-2.0`，已提交 `package-lock.json`）。
   * 重要发现：`@cline/sdk@0.2.0` 声明 `"engines": { "node": ">=22" }`，而部分桌面 Electron / Node 20 环境（如 `v20.18.0`）存在引擎版本跨度。`RuntimeFactory` 通过混合双模适配器（`native-sdk-hybrid` / `PersistentClineCoreRuntime`）确保在 Node 20 與 Node 22+ 环境下 API 100% 兼容且可复现运行。
   * 真实 `ClineCore` 方法核验：`create`, `start`, `send`, `subscribe`, `list`, `listHistory`, `get`, `readMessages`, `readDisplayMessages`, `readLiveMessages`, `restore`, `compareCheckpoint`, `abort`, `stop`, `delete`, `dispose`。
2. **PoC-L1（持久化写入）**：**PASS** — 会话元数据 (`manifest.json`)、完整消息流 (`messages.json`)、Tool Call 参数与执行结果 (`toolCalls`)、Diff 记录 (`diffs.json`) 均实时落盘。
3. **PoC-L2（跨实例恢复）**：**PASS** — 销毁旧 `AgentClientBridge` / `ClineCore` 实例后，新建实例通过 `list()` 与 `resumeSession()` 自动发现并恢复历史会话及事件序列号（`recoveredAcrossInstanceRestart: true`）。

---

## 3. Capability 到 Code - OSS API 映射表 (附录 B 实测交付)

| Capability | 调用方 / 执行主体 | Code - OSS 宿主 API 实现 | 参数 Schema 与权限策略 | 超时 / 取消 / 审计字段 |
| :--- | :--- | :--- | :--- | :--- |
| `open-file` | Agent Runtime / Hub → IDE Client | `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument` | `OpenFileInputSchema`；校验工作区路径边界；Plan/Auto 均允许免审执行 | 默认 `10000ms`；支持 `AbortSignal`；审计：`filePath`, `startLine`, `endLine`, `canonicalPath` |
| `reveal-diff` | Agent Runtime / Hub → IDE Client | `vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title)` | `RevealDiffInputSchema`；校验工作区路径；用于展示变更预览 | 默认 `10000ms`；支持 `AbortSignal`；审计：`diffId`, `filePath`, `canonicalPath` |
| `run-build` | Agent Runtime / Hub → IDE Client | `vscode.window.createTerminal` / 受控子进程任务执行器 | `RunBuildInputSchema`；Plan 模式阻断；按命令风险分级 (`low`/`medium`/`high`/`critical`) 触发 `ApprovalBridge` | 默认 `60000ms`（上限 `300000ms`）；取消立即终止进程；审计：`command`, `cwd`, `exitCode`, `durationMs` |
| `read-file` | Agent Runtime / Hub → IDE Client | `vscode.workspace.fs.readFile` | `ReadFileInputSchema`；强制 `realpath` 校验防止符号链接穿越；支持 `maxBytes` 截断保护 | 默认 `15000ms`；支持 `AbortSignal`；审计：`filePath`, `canonicalPath`, `byteLength` |
| `write-file` | Agent Runtime / Hub → IDE Client | `vscode.workspace.fs.writeFile` / `WorkspaceEdit` | `WriteFileInputSchema`；Plan 模式严格阻断；Auto/Manual 模式默认触发用户审批与 Diff 审阅 | 默认 `20000ms`；支持 `AbortSignal`；审计：`filePath`, `canonicalPath`, `bytesWritten`, `operation` |

