# DeepAutoCode — 开源 AI IDE (v1.1)

基于 **Code - OSS** 与 **Cline SDK (`@cline/sdk@0.2.0`)** 构建的开源 AI 编程 IDE。

## 仓库结构

- [`deepautocode/`](./deepautocode)：IDE 工作台、Electron 桌面端、React + Vite Webview UI、SSH Remote 远程开发管理器与内置扩展集
- [`deepautocode-agent/`](./deepautocode-agent)：基于 `@cline/sdk` 的 Agent 运行时 (`RuntimeFactory`)、宿主能力桥接 (`CapabilityRegistry` / `AgentClientBridge`) 与多模型 Provider 适配层 (`DeepSeek` / `OpenAI-Compatible` / `Anthropic`)
- [`doc/`](./doc)：项目架构与工程规划文档
- [`scripts/`](./scripts)：初始化与辅助构建脚本

## 核心特性

- **多模型 Provider 支持**：默认集成 `DeepSeek` (`deepseek-chat` / `deepseek-reasoner`)，支持一键切换 `OpenAI-Compatible`（Ollama / vLLM / 企业内网网关）与 `Anthropic`
- **端到端自主编码与调试 (`Auto` / `Plan` / `Manual` 模式)**：支持代码库检索 (`search_codebase`)、分段文件读写 (`read_file` / `edit_file` / `write_file`)、自动编译与测试验证 (`run_command`) 及 Diff 审阅闭环
- **Remote - SSH 远程开发**：支持连接远程 Linux 服务器、远程目录懒加载浏览、双向文件镜像同步与远端命令执行
- **安全与权限基线**：Extension Host 边界隔离、Webview CSP Nonce 管控、工作区路径边界校验、`ApprovalBridge` 人工审批与凭据加密存储 (`EncryptedFileSecretStorage`)

## 快速开始

### 1. 构建并测试 `deepautocode-agent`
```bash
cd deepautocode-agent
npm install
npm run build
npm test
```

### 2. 构建并启动 `deepautocode` 桌面端 / 工作台
```bash
cd ../deepautocode
npm install
npm run build
npm run desktop        # 启动 Electron 桌面端 IDE
# 或启动 Web 工作台 (默认 http://127.0.0.1:3840)
npm run dev:workbench
```

## 许可证

MIT License

