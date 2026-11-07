# Support & Troubleshooting (SUPPORT.md)

## Exporting Redacted Diagnostics

When reporting an issue, click **Export Redacted Diagnostics** in the DeepAutoCode AI panel (`diagnostics.export`). This exports:
- Runtime Backend Mode & Fallback state (`local` / `auto` / `hub` / `remote`)
- `@cline/sdk` version & Node engine compatibility report
- Active Provider metadata (with API keys automatically redacted)
- Capability audit log (`open-file`, `reveal-diff`, `run-build`, `read-file`, `write-file`)

