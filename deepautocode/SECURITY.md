# Security Policy (SECURITY.md)

## Reporting a Vulnerability (私下报告渠道)

**请勿通过公开 GitHub Issue 报告安全漏洞**（如路径穿越、符号链接逃逸、Webview CSP 绕过、未授权命令执行或密钥泄漏）。

请通过以下私下渠道提交漏洞详情：
1. **GitHub Private Vulnerability Reporting**：在仓库的 `Security -> Advisories -> Report a vulnerability` 提交私密报告。
2. **安全响应邮箱**：`security@deepautocode.org`（请在邮件中包含复现步骤、受影响版本与 PoC 说明）。

我们将在 48 小时内确认收到报告，并在修复补丁发布后再公开披露技术细节。

## Security Baseline (Section 9)

- **API Key 存储**：所有模型密钥仅写入操作系统凭据管理器 (`SecretStorage`)，禁止明文写入配置文件或日志。
- **路径边界与防逃逸**：所有文件读写调用均经过 `validateWorkspacePath` 规范化与 `fs.realpathSync` 符号链接越界检查。
- **高危操作审批**：`Plan` 模式强制只读；`Auto` 模式仅放行安全白名单操作；文件修改与高危命令默认经 `ApprovalBridge` 弹窗由用户显式批准。
- **日志与诊断脱敏**：导出诊断信息前均经 `sanitizeObjectForLog` 与 `redactSensitiveText` 自动脱敏。

