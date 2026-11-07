# DeepAutoCode — 开源 AI IDE (v1.1)

基于 **Code - OSS** 与 **Cline SDK (`@cline/sdk@0.2.0`)** 的双仓库开源 AI IDE 实现。

- **许可证**：MIT（纯开源免费）
- **默认模型 Provider**：DeepSeek (`deepseek-chat` / `deepseek-reasoner`)，支持一键切换 `OpenAI-Compatible`（Ollama / vLLM / 企业内网网关）与 `Anthropic`
- **安全与权限基线**：Extension Host 可信边界隔离、Webview CSP Nonce 管控、工作区路径规范化（防符号链接逃逸）、`Plan` 只读模式 / `Auto` 白名单模式 / 高危操作人工审批 (`ApprovalBridge`)、Diff 审阅闭环与 OS 凭据存储 (`SecretStorage`)

## 快速开始

### 1. 验证并测试 `deepautocode-agent` 运行时与 PoC 套件
```bash
cd deepautocode-agent
npm install
npm run build
npm run test:poc     # 运行阶段 0 架构 PoC（PoC-L1 持久化写入、PoC-L2 跨实例恢复、auto 回退、Hub 路由）
npm run test:smoke   # 运行 DeepSeek 与 OpenAI-Compatible Provider Smoke Test
npm test             # 运行全部单元与集成测试
```

### 2. 构建并启动 `deepautocode` IDE 工作台
```bash
cd ../deepautocode
npm install
npm run build        # 构建 React + Vite Webview 与 Extension Host 集成层
npm test             # 运行 IDE 端到端测试（CSP、扩展矩阵、Extension Host API 映射、跨重启恢复）
npm run dev:workbench # 启动可交互的 DeepAutoCode AI IDE 工作台 (默认 http://127.0.0.1:3840)
```

