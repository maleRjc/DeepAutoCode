# DeepAutoCode Complete User Guide / 完整使用说明

Welcome to **DeepAutoCode Desktop IDE (v1.1.0)** — an Antigravity-aligned AI-Native development environment built on Code - OSS and `@cline/sdk@0.2.0`.

---

## 1. Quick Start & Project Setup (快速开始与项目打开)

1. **First Launch (首次启动)**:
   - On launch, DeepAutoCode opens the **Antigravity Welcome Screen** without pre-loading a project.
   - Click **📂 Open Folder** (`Ctrl+O`), **🌐 Connect to SSH** (`Ctrl+Alt+O`), or **✨ New File** (`Ctrl+N`) to enter the full 4-pane workbench.
2. **Configure Your AI Model (配置 AI 模型与密钥)**:
   - Press `Ctrl+Shift+J` (or go to `File -> AI Models & Providers` / `⚙️ Settings -> 🤖 Models & Providers`).
   - Select your provider (**DeepSeek**, **OpenAI-Compatible / Ollama / vLLM**, or **Anthropic Claude**), enter your API Key, and click **⚡ Test AI Key** to verify live connectivity.

---

## 2. Workbench Layout & Navigation (工作台布局与导航)

- **Top Titlebar & Menu Bar (顶部标题栏与菜单栏)**:
  - **8 Standard Menus**: `File`, `Edit`, `Selection`, `View`, `Go`, `Run`, `Terminal`, `Help`.
  - **Command Center (`Ctrl+P` / `Ctrl+Shift+P`)**: Click the center search bar to jump to any file or run any IDE/AI command.
  - **Right Quick Toggles**:
    - `🌙 Dark` / `☀️ Light`: Switch between Dark and Daylight themes (`Alt+T`).
    - `◧` (`Ctrl+B`): Toggle Left Primary Sidebar (Explorer, Search, Git, Extensions).
    - `◨` (`Ctrl+J`): Toggle Bottom Panel (Terminal, Problems, Security Audit, Output).
    - `🌐 Preview`: Open the built-in Live Web Preview tab (default `http://localhost:3000/`).
    - `✨ AI` (`Ctrl+L`): Toggle Right AI Agent & Artifacts Dock.
    - `📖 Guide` (`F1`): Open the interactive DeepAutoCode User Guide Center.
    - `⚙️ Settings` (`Ctrl+,`): Open DeepAutoCode Settings Center.

---

## 3. Three AI Execution Modes (三种 AI 执行模式)

DeepAutoCode supports three security-governed execution modes selectable in the AI Composer footer:

| Mode | Badge | Behavior & Best Use Case |
| :--- | :--- | :--- |
| **Auto (Agent)** | `∞ Agent (Auto)` | Automatically executes read tools, file edits, and allowlisted terminal commands (`git status`, `npm test`, `npm run build`). High-risk commands still require explicit approval. |
| **Plan (Read-Only)** | `📖 Plan (Read-Only)` | Strictly read-only exploration + `write_artifact` planning + `invoke_subagent` research. Blocks all source file mutations and terminal commands until you click **▶ Proceed & Execute Plan**. |
| **Manual (Approval)** | `🛡️ Manual` | Every file write or terminal command pauses and displays an interactive **Human-in-the-Loop Approval Card** (`Approve` / `Reject`). |

---

## 4. `/` Slash Workflows & `@` Context Mentions (斜杠工作流与 `@` 上下文引用)

### 4.1 `/` Slash Commands (type `/` in AI Composer or click `/ Workflows`)
- `/plan` — Generate a structured architectural plan Artifact without modifying source files.
- `/goal` — Autonomous end-to-end execution: implement, build, test, and self-heal errors until verified.
- `/fix` — Diagnose compiler/test/runtime errors, apply minimal root-cause fixes, and re-verify.
- `/review` — Perform a thorough security, performance, and bug review with `file:line` references.
- `/test` — Write unit/integration tests for the active module and run the test suite.
- `/learn` — Persist reusable project conventions into `.agents/rules/`.
- `/compact` — Summarize long session history into a structured checkpoint Artifact.

### 4.2 `@` Context Mentions (type `@` in AI Composer or click `@ Context`)
- `@git` — Automatically attaches live `git status --short` and `git diff` into your prompt.
- `@terminal` — Attaches recent terminal command outputs and exit codes.
- `@rules` — Attaches all `.agents/rules/*.md` and workspace AI rules.
- `@problems` — Inspects current workspace compiler/linter diagnostics.
- `@<filepath>` — Live-filters workspace files and injects the exact file content into the prompt.

---

## 5. Inline AI Command (`Ctrl+I`) & Code Lenses (编辑器行内 AI 与快捷动作)

When any source code file is open in the center editor:
- **Code Lens Bar**: At the top of the code editor, click:
  - `✨ Explain` — Explain the logic around the current cursor line.
  - `🛠️ Refactor` — Refactor the code around the current cursor line for clarity and safety.
  - `🧪 Write Tests` — Generate unit tests for the current file/function.
- **Inline Command (`Ctrl+I`)**: Press `Ctrl+I` (or click `⌨️ Inline Command (Ctrl+I)`) to open a floating instruction bar anchored to the active file and cursor line (`Ln X, Col Y`).

---

## 6. Artifacts, Subagents & `.agents/` Customizations (制品面板、子智能体与项目定制)

- **📑 Artifacts Panel**:
  - Switch to the **📑 Artifacts** tab in the Right AI Dock to view structured **Implementation Plans**, **Task Lists**, **Walkthroughs**, and **Reports** created via `write_artifact`.
  - For any `plan` Artifact, click **▶ Proceed & Execute Plan** to switch to Auto Mode and execute the plan step-by-step.
- **🤖 Subagent Delegation (`invoke_subagent`)**:
  - The main Agent can spawn isolated subagents (`research`, `planner`, `verifier`) in parallel to audit modules or verify builds without polluting the main conversation window.
- **📜 `.agents/` Workspace Customizations**:
  - DeepAutoCode automatically discovers and loads:
    - `.agents/rules/*.md` (Workspace AI rules)
    - `.agents/skills/*/SKILL.md` (Specialized skills)
    - `.agents/workflows/*.md` (Custom `/workflow` slash commands)
    - `AGENTS.md` / `CLAUDE.md`
  - Go to `⚙️ Settings -> 📜 Rules for AI` to scaffold new `.agents` Rules, Skills, and Workflows in one click.

---

## 7. Live Web Preview & Remote SSH Development (内置实时网页预览与远程 SSH 开发)

- **🌐 Live Web Preview**:
  - Click **🌐 Preview** in the top titlebar (or `View -> Open Live Web Preview`) to preview local web apps (e.g. `http://localhost:3000/`) directly inside an editor tab.
  - Supports custom URL input, **↻ Go / Reload**, **↗ Open in Browser**, and **✨ Ask AI to Inspect**.
- **🌐 Remote - SSH Connection Manager (`Ctrl+Alt+O`)**:
  - Click `File -> Connect to Remote Host (SSH)...` or the bottom-left green status bar badge `>< SSH: Local`.
  - Supports quick SSH command parsing (`ssh -p 22 user@host:/path`), password / SSH key authentication, remote directory browsing, and full AI Agent execution on the remote host.

---

## 8. Keyboard Shortcuts Reference (常用快捷键速查表)

| Shortcut | Action |
| :--- | :--- |
| `F1` | Open Interactive DeepAutoCode User Guide (`📖 User Guide`) |
| `Ctrl+Shift+P` / `Ctrl+P` | Open Command Palette / Quick File Open |
| `Ctrl+I` | Toggle Editor Inline AI Command Widget |
| `Ctrl+L` | Toggle Right AI Composer Dock / Add Active File to Context |
| `Ctrl+O` | Open Folder / Project Workspace |
| `Ctrl+Alt+O` | Connect to Remote Host (SSH) |
| `Ctrl+S` | Save Active File |
| `Ctrl+B` | Toggle Left Primary Sidebar |
| `Ctrl+J` | Toggle Bottom Terminal & Diagnostics Panel |
| `Ctrl+,` | Open DeepAutoCode Settings Center |
| `Ctrl+Shift+J` | Open AI Models & Provider Settings |
| `Alt+T` | Toggle Dark / Light Color Theme |

