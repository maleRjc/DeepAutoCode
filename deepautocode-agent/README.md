# `@deepautocode/agent` — Cline SDK Runtime Integration & Client Bridge (v1.1)

本仓库是 DeepAutoCode 双仓库架构中的 **Agent 运行时桥接层**（对应工程方案第 3.3、4、5、7、9 节）。

## 核心职责

- **`RuntimeFactory`**：锁定 `@cline/sdk@0.2.0` (`@cline/core@0.2.0`)，管理 `ClineCore` 实例初始化、Node 20/22+ 兼容适配与本地会话持久化。
- **`BackendManager`**：支持 `local`（首期基准）、`auto`（自动探测本地 Hub 并在不可达时回退 `local`）、`hub` 与 `remote` 模式，以及用于拓扑验证的 `MinimalHubServer`。
- **`CapabilityRegistry`**：注册并校验 `open-file`、`reveal-diff`、`run-build`、`read-file`、`write-file` 5 项宿主能力，强制执行工作区路径规范化（防符号链接逃逸）、`Plan` 只读策略、超时/取消与审计日志。
- **`EventBridge` / `ApprovalBridge` / `SessionBridge` / `AgentClientBridge`**：提供可序列化的 UI 消息协议 (`request` / `response` / `event` / `cancel` / `resume`)、高危操作人工审批、Diff 审阅闭环及跨实例重启会话恢复（PoC-L1 & PoC-L2）。
- **`ProviderManager`**：默认集成 **DeepSeek (`deepseek-chat` / `deepseek-reasoner`)**，支持热切换 `OpenAI-Compatible` 与 `Anthropic`，密钥通过 `SecretStorageAdapter` 写入系统凭据存储。

