# Contributing to DeepAutoCode (CONTRIBUTING.md)

## Repository Architecture (ADR-002)

DeepAutoCode maintains two repositories:
1. **`deepautocode`**: IDE Workbench, Code - OSS product configuration, React + Vite Webview UI, Open VSX extension matrix, and user documentation.
2. **`deepautocode-agent`**: Locked `@cline/sdk@0.2.0` Runtime integration, Capability Registry, Event/Approval/Session Bridges, and Model Provider configurations.

## Dependency Direction Rules (Section 3.2)

- Always maintain the strict dependency direction: `DeepAutoCode IDE -> Agent Integration/Bridge -> Cline SDK`.
- **Never** import internal `@cline/sdk` types inside `deepautocode/webview/`.
- **Never** use floating versions (`latest` or `main`) for `@cline/sdk`; always commit `package-lock.json` and run `npm run test:poc` + `npm test` before submitting a PR.

