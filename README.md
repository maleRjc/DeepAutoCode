# DeepAutoCode — 开源 AI 自动编码 IDE (v1.1)

**产品定位（P0-6）**：DeepAutoCode 是 **Agent-first 自动编码工作台**（Electron + React Workbench + `@deepautocode/agent`），不是完整 VS Code / Cursor 克隆。  
优先打赢的场景是：**远端/本地仓库里自主改代码 → 可配置验证门禁 → Diff/审批/熔断可回滚**；语言服务、扩展生态、幽灵补全等 IDE 深度能力按需增强，不以「功能全集对齐 Cursor」为目标。

## 仓库结构

- [`deepautocode/`](./deepautocode)：IDE 工作台、Electron 桌面端、React + Vite Webview UI、SSH Remote、扩展矩阵
- [`deepautocode-agent/`](./deepautocode-agent)：Agent 运行时、Capability/审批/会话桥、Provider 适配
- [`doc/`](./doc)：架构与自举进化文档
- [`scripts/`](./scripts)：初始化与辅助构建脚本

## 核心特性

- **多模型 Provider**：默认 DeepSeek，可切换 OpenAI-Compatible / Anthropic
- **Auto / Plan / Manual**：检索、读写、命令执行、Diff 审阅；Auto 首次写入前创建 `evolve/*` 沙箱分支；自愈失败触发熔断回滚
- **可配置验证门禁**：工作区 `.deepautocode/verify.json`（或设置中心）指定 build/test；Agent 改后按门禁续跑
- **Remote SSH**：镜像树 + 打开强制 pull + 写入 push；占位 stub 不再伪装成已同步内容
- **安全基线**：路径边界、审批卡、CSP、加密凭据存储

## 安装包下载 (Signed Release v1.1.0)

- **Windows 安装包 (EV/OV 数字签名 · 武汉定点网络技术有限责任公司)**：
  - [GitHub Releases (`DeepAutoCode-Setup-v1.1.0.exe`)](https://github.com/maleRjc/DeepAutoCode/releases/latest)
  - [官方镜像直链 (`DeepAutoCode-Setup-v1.1.0.exe`)](https://www.aireadcode.com/downloads/DeepAutoCode-Setup-v1.1.0.exe)

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

### 3. 打包、数字签名与发布
```bash
cd deepautocode
npm run build:win      # Windows 编译、组装、NSIS 打包与 signtool 数字签名
npm run publish:win    # 上传签名安装包至 GitHub Releases 与官方下载服务器
```

## 许可证

MIT License

