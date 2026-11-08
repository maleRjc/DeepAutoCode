# DeepAutoCode Complete User Guide / 完整使用说明

Welcome to **DeepAutoCode Desktop IDE (v1.1.0)** — an **Agent-first** coding workbench (Antigravity-aligned shell on Electron + `@cline/sdk`). It prioritizes autonomous implement → verify → self-heal loops over being a full VS Code / Cursor replacement.

---

## 1. Quick Start & Project Setup (快速开始与项目打开)

1. **First Launch (首次启动)**:
   - DeepAutoCode opens the **Welcome Screen** without pre-loading a project.
   - Click **📂 Open Folder** (`Ctrl+O`), **🌐 Connect to SSH** (`Ctrl+Alt+O`), or **✨ New File** (`Ctrl+N`) to enter the 4-pane workbench.
2. **Choose UI language (界面语言 / 介面語言)**:
   - Supported: **简体中文 (zh-CN)** · **繁體中文 (zh-TW)** · **English (en)**.
   - Change anytime in **⚙️ Settings → General → UI Language**, or via the language buttons in the **📖 Guide** pane.
   - Preference is persisted in `.deepautocode-data/ide-settings.json` as `ui.locale` (also mirrored to `localStorage dac.locale`).
   - Affects menus, Settings chrome, Guide content, Composer controls, activity bar, and status notices. Guide zh-TW is converted from Simplified with a phrase/char map.
3. **Configure Your AI Model (配置 AI 模型与密钥)**:
   - Press `Ctrl+Shift+J` (or `File -> AI Models & Providers` / `⚙️ Settings -> 🤖 Models & Providers`).
   - Select **DeepSeek**, **OpenAI-Compatible / Ollama / vLLM**, or **Anthropic Claude**, enter the API Key, then **⚡ Test AI Key**.
   - In Composer, prefer **⚡ Auto Router** (`deepseek-auto`) so the runtime can escalate to reasoner on multi-file edits / self-heal failures; or force Fast / Reasoner.
4. **Optional verification gate (验证门禁)**:
   - Settings → Runtime / Security writes workspace `.deepautocode/verify.json` (`buildCommand` / `testCommand` / `enableEvolveSandbox`).
   - Project rules are also written to `.deepautocode/project-rules.md` and injected into the Agent system prompt each turn.

---

## 2. Workbench Layout & Navigation (工作台布局与导航)

- **Top Titlebar & Menu Bar**:
  - Menus: `File`, `Edit`, `Selection`, `View`, `Go`, `Run`, `Terminal`, `Help`.
  - **Command Center** (`Ctrl+P` / `Ctrl+Shift+P`): jump to files or run IDE/AI/Help commands.
  - Quick toggles: theme (`Alt+T`), left sidebar (`Ctrl+B`), bottom panel (`Ctrl+J`), **🌐 Preview**, **✨ AI** (`Ctrl+L`), **📖 Guide** (`F1`), **⚙️ Settings** (`Ctrl+,`).
- **Right AI Dock tabs**:
  - **Composer** — multi-turn Agent chat, live tool cards, model/tier badge, Goal **token used/budget**.
  - **Artifacts** — Plans / Task Lists / Reports; one-click execute.
  - **Sessions** — history + **checkpoints** (Restore).
  - **Changes** — multi-file Diff list; Accept / Reject / Revise; Accept All / Reject All. Stopping the Agent keeps pending Diffs for review.
- **Editor**:
  - Pending Diffs show **line gutter / background** add-mod marks.
  - **Ghost autocomplete** (status bar toggle) with request cancellation + server LRU cache.
  - `Ctrl+Shift+O` Go to Symbol (CodeOutline); `F12` Go to Definition (LSP when available, else ranked search).
- **Bottom status bar**: workspace, Git branch, backend mode, live **Tokens: used/budget**, Autocomplete ON/OFF, cursor position.

---

## 3. Three AI Execution Modes (三种 AI 执行模式)

Selectable in the Composer footer (and mirrored by intent chips: Query-only / Auto-action):

| Mode | Badge | Behavior |
| :--- | :--- | :--- |
| **Auto (Agent)** | `∞ Agent (Auto)` | Reads, edits (`apply_patch` / `edit_file` / `write_file`), allowlisted commands (`git status`, `npm test`, `npm run build`, …). High-risk commands still need approval. First write may create an `evolve/auto-*` **sandbox branch**. |
| **Plan (Read-Only)** | `📖 Plan (Read)` | Explore + `write_artifact` + `invoke_subagent` research only. No source mutations until **▶ Proceed & Execute Plan** (or Execute Tasks / Act on Report). |
| **Manual** | `🛡️ Manual` | Every write / shell command shows an **Approval Card** (`Approve` / `Reject`). Rejected Diffs are marked rejected. |

**Safety events (status bar + audit log)**:
- `sandbox.branch.created` — evolve sandbox branch created  
- `circuit.breaker.triggered` — self-heal budget exhausted → session mutations rolled back  
- `diff.proposed` — Diff first, then approve/write  

---

## 4. `/` Slash Workflows & `@` Context Mentions (斜杠工作流与 `@` 上下文引用)

### 4.1 `/` Slash Commands (type `/` in Composer or click `/ Workflows`)
- `/plan` — Structured architectural plan Artifact (read-only).
- `/goal` — End-to-end implement → build → test → self-heal until verified (`[FORCE_AUTO_ACTION]`).
- `/fix` — Diagnose compiler/test/runtime errors; minimal fix + re-verify.
- `/review` — Security / performance / bug review with `file:line` references.
- `/test` — Author unit/integration tests and run the suite.
- `/learn` — Persist conventions into `.agents/rules/`.
- `/compact` — Summarize long history into a checkpoint Artifact.

### 4.2 `@` Context Mentions (type `@` or pin chips)
- `@git` — live `git status` / `git diff`
- `@terminal` — recent terminal output + exit codes
- `@rules` — `.agents/rules/*.md` + workspace AI rules
- `@problems` — compiler/linter Problems (also auto-injected on self-heal turns from `.deepautocode/problems.json`)
- `@code` — current editor selection
- `@tabs` — digest of open code tabs
- `@folder/...` — folder context chip
- `@<filepath>` — filter workspace files and inject content

---

## 5. Inline AI Command (`Ctrl+I`) & Code Lenses (编辑器行内 AI)

When a source file is open:
- **Code Lens**: `✨ Explain` · `🛠️ Refactor` · `🧪 Write Tests`
- **Inline Command (`Ctrl+I`)**: floating bar on cursor/selection; same Agent tool chain as Composer (`read_file` → `search_codebase` → editor → verify).
  - Explain-style → `INLINE_QUERY` (read-only)
  - Edit / refactor / tests → `INLINE_EDIT`

---

## 6. Artifacts, Subagents, Todos & Token UI (制品、子智能体、待办与 Token)

- **📑 Artifacts**: Plans, Task Lists, Walkthroughs, Reports from `write_artifact` / research / planner. Event `artifact.created` refreshes the panel (plan/research auto-focus Artifacts).
- **One-click execute**:
  - Plan → **▶ Proceed & Execute Plan**
  - Task list → **▶ Execute Tasks**
  - Report → **▶ Act on Report**
  - Injects `[FORCE_AUTO_ACTION]`, syncs `manage_todo`, prefers `apply_patch`, then build/verify + self-heal.
- **Subagents (`invoke_subagent`)** — each role runs in a **tool allowlist sandbox** with an isolated transcript and size-capped report:
  - `research` — multi-round search → outline → read evidence (heuristic + optional LLM decompose)
  - `planner` — stepped implementation plan
  - `verifier` — shared diagnose→verify contract → PASS/FAIL
  - `editor` — budgeted Diff edits (≤3 files / ≤6 hunks); diagnose **and verify**; fail → rollback
- **Session todos (`manage_todo`)**: checklist injected on self-heal continue; verify pass can auto-complete items.
- **Token usage**: default Goal budget **180k**. Composer badge + status bar show live used/budget (`goal.usage` / `model.tier`). Over budget → `budget_limit` summary; compaction uses structured tool-result summaries (not hard truncation).

---

## 7. Agent Coding Engine (Agent 编程能力)

What the Agent actually does each Auto turn:

| Capability | Behavior |
| :--- | :--- |
| **Search** | `search_codebase`: ripgrep-first; `regex` / `glob` / `case_sensitive`; `mode=symbol\|content\|auto`; workspace file index. Aliases: `grep`, `codebase_search`, `explore` |
| **Outline** | `outline_file` — TS/JS AST; C/C++/others heuristic (`Lstart-Lend: kind name`) |
| **Patch** | Hardened `apply_patch` (first-match, Add/Delete, multi-file rollback); `edit_file` + `apply_patch` mismatch → auto re-read + one-shot retry + numbered window |
| **MCP** | Settings → MCP: **stdio** / **sse** / **http**, Headers / Bearer paste, resources & prompts tools (`list_mcp_resources` / `get_mcp_prompt`), per-tool Disable → `.deepautocode/mcp.json` |
| **@codebase / semantic search** | `search_codebase mode=semantic` (local TF-IDF hybrid) + `@codebase` mention; respects `.cursorignore` / `.deepautocodeignore` |
| **Agent browser** | `browser_action`: snapshot / click / type / screenshot via Chrome CDP (`DEEPAUTOCODE_CDP_URL` or `:9222`), else HTTP structured snapshot |
| **Parallel worktree** | **∥ Parallel** creates an isolated git worktree under `.deepautocode/worktrees/<session>` when git is available |
| **Skills / Rules** | Skills catalog-only by default; `@skill` / `@skill:name` expands SKILL.md. User Rules + Project Rules + `.cursor/rules` `globs`/`alwaysApply` |
| **Composer queue / parallel** | Same Composer busy → queue ≤5. **∥ Parallel** starts a new session without aborting the running one; dock tabs show ● running |
| **Cross-session memory** | `/compact` + checkpoints write `.deepautocode/agent-memory.json`; injected into later Agent turns (History panel lists digests) |
| **Hunk Accept** | Changes panel: Accept/Reject per hunk; **Next File →** cycles pending Diffs; remaining hunks rebuild via `diff.updateProposed` |
| **@ picker** | Arrow keys + Enter/Esc; `@symbol`, `@skill`, `@docs`, `@web https://…`, recent tabs + files |
| **Diff deep-link** | Changes hunk **Jump →**; live chips **and** completed chat tool cards open Diff hunk in editor |
| **Checkpoint timeline** | Preview shows **content Diff** vs current (sample ± lines) + Restore |
| **Editor subagent** | `invoke_subagent(editor)` writes via Diff path (`diff_proposed` / Manual gate) with diagnose rollback |
| **Live diagnostics** | Debounced as-you-type LSP → Problems + **gutter dots** (TS/JS/Python/C++); Save still forces a refresh; errors feed self-heal |
| **Verify gate** | `.deepautocode/verify.json` build/test/combined; Problems panel + auto inject |
| **Self-heal budgets** | Verify nudge ≤4; build/test/semantic heal ≤5; then circuit-breaker rollback |
| **Model escalate** | Self-heal / semantic fail / edit mismatch / multi-file pending → reasoner tier (badge in Composer) |
| **Context compaction** | Graded by tool output size + Goal token budget; keep recent N tool messages |

Configure verify/sandbox under **⚙️ Settings → Runtime / Security**.

---

## 8. Live Web Preview & Remote SSH (网页预览与远程 SSH)

- **🌐 Live Web Preview**: titlebar **Preview** or `View -> Open Live Web Preview` (default `http://localhost:3000/`). URL bar, reload, open in browser, **✨ Ask AI to Inspect**.
- **Remote SSH (`Ctrl+Alt+O`)**: `File -> Connect to Remote Host (SSH)...` or status badge `>< SSH`. Supports `ssh -p 22 user@host:/path`, password/key auth, remote tree, Agent on remote. Open forces pull; dirty-file protect / Reconnect / Conflict Check / Take Remote. SSH mirror stubs are **not** treated as real remote content.

---

## 9. Keyboard Shortcuts Reference (快捷键速查表)

| Shortcut | Action |
| :--- | :--- |
| `F1` | Interactive User Guide Center (`Help` menu) |
| `Ctrl+Shift+P` / `Ctrl+P` | Command Palette / Quick Open |
| `Ctrl+I` | Inline AI Command |
| `Ctrl+Shift+O` | Go to Symbol in active file |
| `F12` | Go to Definition (LSP or search-ranked) |
| `Ctrl+L` | Toggle AI Dock / add active file context |
| `Ctrl+O` | Open Folder |
| `Ctrl+Alt+O` | Connect SSH |
| `Ctrl+S` | Save |
| `Ctrl+B` / `Ctrl+J` | Toggle left sidebar / bottom panel |
| `Ctrl+,` | Settings Center |
| `Ctrl+Shift+J` | AI Models & Providers |
| `Alt+T` | Toggle Dark / Light theme |

---

## Help Menu Map (菜单栏 Help)

| Menu item | Opens |
| :--- | :--- |
| DeepAutoCode User Guide (Complete Manual) `F1` | Interactive Guide → Quick Start |
| 1–9 section entries | Matching Guide panes |
| Open User Guide Markdown | `docs/USER-GUIDE.md` |
| Architecture & PoC Documentation | `docs/ADR-AND-POC-REPORT.md` |
| Settings Center | `Ctrl+,` |
| Export Security Diagnostics | Redacted capability audit dump |
