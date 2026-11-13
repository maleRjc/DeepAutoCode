# DeepAutoCode × DeepSeek Harness（精简版）

**DeepSeek Harness 做内核，DeepAutoCode 做界面**。界面只保留真正每天会用的部分，其它一律去掉。


## 界面里有什么

| 功能 | 说明 |
|---|---|
| 菜单栏 | 文件（打开文件夹 / 保存 / 关闭标签 / 新会话 / 设置）、视图（深浅色 / 语言）、帮助（关于） |
| 多语言 | 简体中文 / 繁體中文 / English，右上角切换或「视图 → 语言」，选择会记住 |
| 深浅色 | 右上角 ☀/☾ 一键切换，或「视图 → 颜色深浅」，选择会记住 |
| 文件树 | 打开项目文件夹、展开、点开文件 |
| 编辑器 | 多标签、脏标记、`Ctrl+S` 保存 |
| AI 对话 | Markdown 渲染（代码块+复制）、逐字流式、思考折叠、工具卡片（状态/耗时/参数/结果、运行中计时） |
| 会话与面板 | 左侧「会话」列表（可切换/恢复）；右侧「产物与上下文」面板：Token 用量条、缓存命中、改动列表、最近工具 |
| 输入增强 | 输入框内 `@` 唤起文件联想、粘贴图片作为附件、模型下拉即时切换（自动新建会话） |
| 审批 | 内核要执行敏感操作时弹出「允许 / 拒绝」 |
| Diff | AI 改了文件自动生成 Diff，可「接受」或「拒绝并回滚」 |
| 设置 | Provider、Endpoint、**模型下拉**、API Key（含是否已配置状态） |



**已移除**（对你的使用没有价值）：SSH Remote、扩展市场/VSIX、终端面板、LSP/问题面板、
检查点、产物中心、用户指南、命令面板、Git 面板、遥测。

## 发送后没反应？根因已修复

**根因**：DeepSeek Harness 的会话事件把内容放在 `event.data` 里，最初的适配层按 `event.message`
读取，导致模型其实已经回复、但界面永远收不到文字/工具事件——表现就是"点了发送没反应"。

**现在的行为**：

- 你的消息立刻出现在右侧；
- 模型回复、思考过程、工具卡片都能实时显示；
- 内核/网络/配置错误以**红色气泡**留在对话里并说明原因；
- 整轮有超时保护（默认 15 分钟），初始化卡住也会报错并关闭内核进程；
- 顶部橙色横幅提示配置问题（Provider 不对），点「去设置」直达。



## 架构

```
DeepAutoCode 精简界面 (webview-min/, React + Vite)
        │  WS /ws + HTTP /api/bridge        │ REST /api/workspace/*
Workbench Host (src/workbench-server, 沿用 DAC)
        │  IClineCoreInstance（RuntimeFactory 一处接缝）
DSH 内核适配层 (src/kernel/dsh-runtime.ts)
        │  SDK JSON-RPC over stdio
DeepSeek Harness 运行时 dsh --profile sdk (Node ≥ 24)
```

界面与宿主之间是 DeepAutoCode 原有协议；内核通过 `RuntimeFactory.create` 整体替换为 DSH，
会话、事件、审批、Diff 都由适配层翻译。

## 运行

```powershell
cd E:\AutoCode\DeepAutoCode-New
npm install --ignore-scripts
npm run build
npm start          # http://127.0.0.1:3840
```

或双击 **`start-desktop.bat`**（自动检查构建/运行时，找不到就补，然后开桌面窗口）。

`npm start` 会自动寻找 Node ≥ 24（`DSH_KERNEL_NODE` → DeepSeek Harness 自带 Node → 当前 node），
因为 `dsh` 内核需要 24+。端口占用会自动顺延到 3841…

## 设置模型与 API Key

点右上角 **设置**（或「文件 → 设置…」）：


1. Provider 选 **DeepSeek (Default)**（内核目前只接 DeepSeek 官方路由）；
2. Endpoint 默认 `https://api.deepseek.com/v1`；
3. **模型** 用下拉选择（`deepseek-flash` / `deepseek-v4-pro` …），也可选「自定义…」手填；
4. **API Key** 右侧显示「已保存 / 未配置」，填完保存，可点「测试连通性」。

Key 加密存于 `.deepautocode-data/secrets.enc.json`，发起会话时由内核适配层注入
`DEEPSEEK_API_KEY` 给 `dsh` 子进程。留空时会复用 `~/.dsh` 里已配置的 DeepSeek 凭据，
所以已经登录过官方 DeepSeek Harness 的机器可以直接用。

## 内核支持哪些模型

- ✅ `deepseek` → `deepseek-official` 路由（`deepseek-flash` → `deepseek-v4-flash`，`pro` → `deepseek-v4-pro`）。
- ✅ **OpenAI 兼容 / GLM / 自建网关**：内核会按当前 Provider 的 Endpoint 自动生成一个 `pi-ai` 网关路由
  （`dac-gateway`，`openai-completions` 协议），Key 通过 `DAC_LLM_API_KEY` 注入。
  支持 vLLM / SGLang / Ollama / One-API / 公司网关等任何 OpenAI 兼容服务。
- ✅ **Anthropic**：同一路由机制，协议自动切到 `anthropic-messages`。
- ✅ **私有网段网关（10./192.168./172.16-31.）**：自动经 SSH 中继访问。
  中继主机取 `~/.ssh/config` 里第一个 `Host`（例如 `relay-host`），或用环境变量 `DAC_SSH_RELAY_HOST` 指定；
  内核会起一个本地端口转发（`ssh -N -L`），把网关映射到 `127.0.0.1` 再调用。强制直连可设 `DSH_KERNEL_NO_SSH_RELAY=1`。
- 设置里点「**获取模型列表**」会实时向当前 Endpoint 拉取 `/v1/models`（私有网段同样经 SSH 中继），
  下拉框直接列出网关真实提供的模型；换 Provider、改 Endpoint、选模型后**新建会话**即生效。
- 本地 vLLM / SGLang 这类不需要 Key 的网关直接留空 API Key 即可（内核会以 `EMPTY` 占位，服务端通常忽略）。

## 远程开发（SSH）

启动页点 **连接 SSH**，填主机 / 端口 / 用户名 / 认证方式（密码 / 私钥 / Agent）/ 远程目录，
先「测试连接」再「连接」。连接成功后工作区切到远程镜像，AI 在其中读写代码。
最近连接会保存在启动页，点一下即可回填表单。

## GLM / 自定义网关的性能优化

针对私有网段的 GLM 网关（vLLM），内核做了这些事（DeepSeek 路径完全不受影响）：

| 优化 | 说明 |
|---|---|
| SSH 中继 | 私有网段自动 `ssh -N -L` 到中继主机，`~/.ssh/config` 第一个 Host 或 `DAC_SSH_RELAY_HOST` |
| 网关代理 | 可注入 `chat_template_kwargs.enable_thinking=false`（`DSH_KERNEL_DISABLE_THINKING=1` 开启，默认保留思考保证质量） |
| 连接池 | 同一 Provider/模型/工作区复用一个 `dsh` 进程，省去每个会话 3–5s 启动与冷启动 |
| 容量对齐 | 路由按网关实际能力声明 `contextWindow=131072`、`maxTokens=16384` |
| 阶段提示 | 对话头部显示「启动内核 / 等待模型 / 执行工具 / 生成回答 + 秒数」 |
| 快速失败 | 发消息前探测网关，连不上直接给出可操作错误，不再静默等待 |

实测（同一台机器，your-model 经 relay-host 中继）：

- 保留思考（默认）：单轮 15s / 80s 波动（vLLM 队列与思考长度影响很大）
- 关闭思考（`DSH_KERNEL_DISABLE_THINKING=1`）：7–35s，但推理会写进正文，质量下降
- DeepSeek 直连：10–20s，未走中继/代理

> 延迟大头在模型服务端：建议在 vLLM 侧开 `--enable-prefix-caching`、限制并发、预热模型；
> 客户端侧的连接池与阶段提示已经做完。

### 流式（已实现）

网关代理位于内核与 vLLM 之间，实时解析 SSE，把 `delta.content` / `reasoning_content`
转成 `assistant.text.delta` / `assistant.thinking.delta`，界面边生成边显示（不再是"等完一次回放"）。
持久化不会重复：流式期间内核按增量累计正文，消息提交事件到达时跳过重复块。

适用范围：经 SSH 中继的自定义网关。DeepSeek 仍走官方直连（其 SDK 事件按消息提交，且本身延迟较低）。

### vLLM 服务端调参（需要模型主机权限）

relay-host 只是路由（其上容器已停用多时），模型服务在 `10.0.0.10`，本机访问不到它的管理面
（`/health`、`/metrics` 均 403）。从 usage 看 `cacheReadTokens≈8493`，说明**前缀缓存已生效**。

若还能进一步优化，需要在模型主机用类似参数重启（会中断正在进行的请求）：

```bash
--enable-prefix-caching \
--max-num-seqs 4 \
--enable-auto-tool-choice --tool-call-parser <glm 对应解析器> \
--max-model-len 131072 --gpu-memory-utilization 0.9
```

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | 内核使用的 Key（界面保存的优先） |
| `DSH_KERNEL_HOME` | `~/.dsh` | 内核 home（会话日志、凭据、profile） |
| `DSH_KERNEL_MODEL` | 按会话映射 | 强制内核模型 |
| `DSH_KERNEL_NODE` | 自动探测 | 宿主使用的 Node 24 可执行文件 |
| `DSH_KERNEL_TURN_TIMEOUT_MS` | `900000` | 单轮超时，超时会在对话里报错 |
| `DSH_KERNEL_ALLOW_ANY_PROVIDER` | 未设置 | 允许非 DeepSeek Provider（实验） |
| `DSH_KERNEL_DISABLE_THINKING` | 未设置 | 置 1 时对中继网关关闭 thinking（更快，但推理会进正文） |
| `DSH_KERNEL_NO_SSH_RELAY` | 未设置 | 置 1 时禁用 SSH 中继，强制直连 |
| `DAC_SSH_RELAY_HOST` | `~/.ssh/config` 首个 Host | 指定中继主机 |

## 验证情况

- `npm run build`：界面 172 KB JS / 10 KB CSS，宿主 `tsc` 通过。
- **端到端真实对话**（Electron 实拍，见 `docs/chat-ok.png`）：输入「只回复 OK」→ 收到 `OK`，用时约 7–20 秒（含内核冷启动）。
- 协议链路：`session.create → session.send → WebSocket 事件 → session.resume`、审批、Diff 均走通。
- 内核：`dsh --profile sdk` 真实启动，复用 `~/.dsh` 里的 DeepSeek 凭据，会话日志写入 `~/.dsh/sessions/...`。
- 错误路径：Provider 不匹配、网络不可达、整轮超时都会在对话里出现明确提示。
- 界面能力：启动页（打开项目 / SSH）、菜单栏、三语切换、深浅色切换、模型下拉与「获取模型列表」、文件树图标与新建/重命名/删除、编辑器行号均已验证（`docs/settings-models-fetch.png`）。
- 多模型：mock OpenAI 网关验证通用链路（`docs/chat-gateway.png`）；**真实 your-model** 经 SSH 中继实测返回 `OK`（`docs/chat-glm.png`），首包约 50 秒。
- SSH：表单、测试连接失败提示已验证（`docs/ssh-dialog.png` / `docs/ssh-fail.png`）；真实主机连接需要你提供可达的服务器。

## 目录

| 路径 | 说明 |
|---|---|
| `webview-min/` | **新**精简界面源码（`npm run build:ui` 构建到 `dist/webview`） |
| `webview/` | 原 DeepAutoCode 完整界面（保留作参考，`npm run build:ui-legacy`） |
| `src/kernel/` | DSH 内核适配层 |
| `src/workbench-server/` | 工作台服务（文件树/编辑/会话 REST + WS） |
| `electron/` | 桌面壳 |
| `start-desktop.bat` | 一键桌面启动（GBK 编码，别用 UTF-8 覆盖保存） |

MIT License。
