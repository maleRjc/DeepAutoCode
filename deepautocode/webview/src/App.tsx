import React, { useEffect, useRef, useState } from 'react';
import { WebviewBridgeClient, type UIEventMessage } from './bridgeClient';
import { BrandMark } from './components/BrandMark';

const bridge = new WebviewBridgeClient();

declare global {
  interface Window {
    deepAutoCodeDesktop?: {
      isElectron?: boolean;
      openFolderDialog?: () => Promise<string | null>;
      openFileDialog?: () => Promise<string | null>;
      windowControl?: (action: 'minimize' | 'maximize' | 'close') => Promise<void>;
      setThemeOverlay?: (mode: 'light' | 'dark') => Promise<void>;
    };
  }
}

interface OpenTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  kind: 'code' | 'diff' | 'settings' | 'preview' | 'guide' | 'image';
  diffRecord?: any;
}

interface TerminalEntry {
  id: string;
  cmd: string;
  output: string;
  exitCode: number;
  durationMs: number;
  ts: string;
}

type SettingsCategory =
  | 'general'
  | 'models'
  | 'security'
  | 'rules'
  | 'mcp'
  | 'runtime'
  | 'extensions';

type GuideSectionId =
  | 'quickstart'
  | 'workbench'
  | 'modes'
  | 'workflows'
  | 'inline'
  | 'artifacts'
  | 'preview-ssh'
  | 'shortcuts';

export function App() {
  // Layout toggles & Resizable Pane Dimensions (Cursor / Antigravity style)
  // Start collapsed on initial Welcome screen; auto-expand when a workspace folder is opened
  const [showLeftSidebar, setShowLeftSidebar] = useState(false);
  const [showBottomPanel, setShowBottomPanel] = useState(false);
  const [showRightAiDock, setShowRightAiDock] = useState(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number>(240);
  const [rightAiDockWidth, setRightAiDockWidth] = useState<number>(390);
  const [bottomPanelHeight, setBottomPanelHeight] = useState<number>(180);
  const [settingsNavWidth, setSettingsNavWidth] = useState<number>(220);
  const [draggingSash, setDraggingSash] = useState<
    null | 'left' | 'right' | 'bottom' | 'settings'
  >(null);
  const [isSendingPrompt, setIsSendingPrompt] = useState<boolean>(false);
  const [activeActivity, setActiveActivity] = useState<
    'explorer' | 'search' | 'git' | 'extensions'
  >('explorer');
  const [activeBottomTab, setActiveBottomTab] = useState<
    'terminal' | 'problems' | 'audit' | 'output'
  >('terminal');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showGearPopup, setShowGearPopup] = useState(false);

  // Modals: Command Palette, Open Project Dialog, Create File/Folder Dialog
  const [showPalette, setShowPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [customFolderInput, setCustomFolderInput] = useState('');
  const [showCreateModal, setShowCreateModal] = useState<null | 'file' | 'directory'>(null);
  const [createTargetName, setCreateTargetName] = useState('src/new-module.ts');

  // Workspace & Multi-Tab Editor states (Antigravity first-launch: no folder opened by default)
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('');
  const [workspaceName, setWorkspaceName] = useState<string>('No Folder Opened');
  const [fileTree, setFileTree] = useState<any[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({
    src: true,
    product: true,
    webview: true,
    extensions: true,
    docs: true,
  });
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string>('');
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('general');
  const [guideSection, setGuideSection] = useState<GuideSectionId>('quickstart');
  const [guideLang, setGuideLang] = useState<'zh' | 'en'>('zh');
  const [imageZoom, setImageZoom] = useState<number>(1);
  const [imageBgPattern, setImageBgPattern] = useState<'checker' | 'dark' | 'light'>('checker');
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [ghostText, setGhostText] = useState<string>('');
  const [autocompleteEnabled, setAutocompleteEnabled] = useState<boolean>(true);
  const [diffViewMode, setDiffViewMode] = useState<'split' | 'unified'>('split');
  const autocompleteTimerRef = useRef<any>(null);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number }>({ line: 1, col: 1 });

  // IDE & AI Persisted Settings (read initial theme synchronously to prevent dark->light startup flash)
  const initialStartupTheme = (() => {
    try {
      return (
        (window as any).__DAC_INITIAL_THEME__ ||
        localStorage.getItem('dac.theme') ||
        document.documentElement.getAttribute('data-theme') ||
        'cursor-light'
      );
    } catch {
      return 'cursor-light';
    }
  })();

  const [ideSettings, setIdeSettings] = useState<any>({
    editor: {
      fontSize: 13,
      tabSize: 2,
      wordWrap: true,
      lineNumbers: true,
      minimap: true,
      autoSave: 'afterDelay',
      theme: initialStartupTheme,
    },
    agent: {
      defaultExecutionMode: 'auto',
      autoApproveReadFiles: true,
      autoApproveSafeCommands: true,
      approvalTimeoutSeconds: 120,
      includeActiveFileContext: true,
      commandAllowlist: [
        'git status',
        'git diff',
        'git log',
        'node -v',
        'npm test',
        'npm run typecheck',
        'npm run build',
      ],
      projectRules:
        '1. Follow TypeScript strict mode and ESM import conventions.\n2. Keep Cline SDK internal types isolated inside deepautocode-agent.\n3. Enforce workspace path canonicalization and never store plaintext API keys.',
    },
    mcpServers: [],
    recentWorkspaces: [],
  });
  const [newAllowlistCmd, setNewAllowlistCmd] = useState('');
  const [newMcpName, setNewMcpName] = useState('');
  const [newMcpCmd, setNewMcpCmd] = useState('');
  const [registeredCapabilities, setRegisteredCapabilities] = useState<any[]>([]);

  // Search & Git states
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ file: string; line: number; preview: string }>
  >([]);
  const [gitState, setGitState] = useState<{
    branch: string;
    changes: Array<{ status: string; file: string }>;
  }>({ branch: 'main', changes: [] });

  // Terminal & Output logs
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>([
    {
      id: 'init',
      cmd: 'deepautocode --version',
      output:
        'DeepAutoCode Desktop IDE v1.1.0 (Code - OSS 1.95 Baseline | @cline/sdk@0.2.0 Locked | MIT)',
      exitCode: 0,
      durationMs: 4,
      ts: new Date().toLocaleTimeString(),
    },
  ]);
  const [runtimeLogs, setRuntimeLogs] = useState<string[]>([
    '[ExtensionHost] Activated deepautocode.deepautocode-ai v1.1.0',
    '[RuntimeFactory] Verified @cline/sdk@0.2.0 (native-sdk-hybrid)',
    '[Security] Workspace boundary canonicalization & CSP nonce active',
  ]);

  // AI Agent & Bridge states
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [messages, setMessages] = useState<any[]>([]);
  const [streamingText, setStreamingText] = useState<string>('');
  const [liveToolCalls, setLiveToolCalls] = useState<any[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<any[]>([]);
  const [diffs, setDiffs] = useState<any[]>([]);
  const [recoveredFlag, setRecoveredFlag] = useState<boolean>(false);
  const [executionMode, setExecutionMode] = useState<'plan' | 'auto' | 'manual'>('auto');
  const [manualIntentChoice, setManualIntentChoice] = useState<
    null | 'query-only' | 'auto-action' | 'build-fix'
  >(null);
  const [promptInput, setPromptInput] = useState<string>('');
  const [attachActiveFile, setAttachActiveFile] = useState<boolean>(true);
  const [aiTab, setAiTab] = useState<'composer' | 'artifacts' | 'sessions'>('composer');

  // Antigravity Inline Command (Ctrl+I), Artifacts, .agents Customizations & Web Preview states
  const [showInlineCommand, setShowInlineCommand] = useState<boolean>(false);
  const [inlineCommandInput, setInlineCommandInput] = useState<string>('');
  const [artifactsList, setArtifactsList] = useState<any[]>([]);
  const [activeArtifactId, setActiveArtifactId] = useState<string>('');
  const [workspaceCustomizations, setWorkspaceCustomizations] = useState<{
    rules: Array<{ name: string; path: string; content: string }>;
    skills: Array<{ name: string; description: string; path: string }>;
    workflows: Array<{ name: string; description: string; path: string }>;
  }>({ rules: [], skills: [], workflows: [] });
  const [previewUrlInput, setPreviewUrlInput] = useState<string>('http://localhost:3000/');
  const [previewReloadKey, setPreviewReloadKey] = useState<number>(0);

  // Provider, Backend, Extensions & Diagnostics
  const [providerData, setProviderData] = useState<any>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('deepseek');
  const [endpointInput, setEndpointInput] = useState<string>('https://api.deepseek.com/v1');
  const [modelInput, setModelInput] = useState<string>('deepseek-chat');
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [smokeResult, setSmokeResult] = useState<any>(null);
  const [isTestingKey, setIsTestingKey] = useState<boolean>(false);
  const [backendStatus, setBackendStatus] = useState<any>(null);
  const [extensionsCatalog, setExtensionsCatalog] = useState<any>(null);
  const [vsixFileName, setVsixFileName] = useState<string>('enterprise-linter-1.0.0.vsix');
  const [vsixConfirmed, setVsixConfirmed] = useState<boolean>(false);
  const [diagnosticsDump, setDiagnosticsDump] = useState<any>(null);
  const [statusNotice, setStatusNotice] = useState<string>('Ready');

  // Remote - SSH Connection Manager states (VS Code / Cursor & Visual Studio style)
  const [showSshModal, setShowSshModal] = useState<boolean>(false);
  const [sshStatus, setSshStatus] = useState<any>({ connected: false });
  const [sshProfiles, setSshProfiles] = useState<any[]>([]);
  const [sshQuickCmd, setSshQuickCmd] = useState<string>('');
  const [sshForm, setSshForm] = useState<{
    id?: string;
    name: string;
    host: string;
    port: number;
    username: string;
    authMethod: 'password' | 'agent-or-default-key' | 'identity-file' | 'local-loopback';
    password: string;
    identityFile: string;
    remotePath: string;
  }>({
    name: 'Linux Dev Server',
    host: '10.0.62.83',
    port: 22,
    username: 'root',
    authMethod: 'password',
    password: '',
    identityFile: '~/.ssh/id_rsa',
    remotePath: '/root',
  });
  const [sshTestResult, setSshTestResult] = useState<any>(null);
  const [isTestingSsh, setIsTestingSsh] = useState<boolean>(false);
  const [isConnectingSsh, setIsConnectingSsh] = useState<boolean>(false);
  const [sshBrowseData, setSshBrowseData] = useState<{
    currentDir: string;
    directories: string[];
  } | null>(null);

  const lastSeqRef = useRef<number>(0);
  const bootstrappedRef = useRef<boolean>(false);
  const aiMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const codeGutterRef = useRef<HTMLDivElement | null>(null);
  const codeHighlightRef = useRef<HTMLDivElement | null>(null);
  const codeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [workspaceSectionOpen, setWorkspaceSectionOpen] = useState<boolean>(true);
  const [expandedMessageIds, setExpandedMessageIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    aiMessagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages.length, pendingApprovals.length]);

  const currentTheme = ideSettings.editor?.theme ?? initialStartupTheme;
  const isLightTheme = currentTheme === 'cursor-light' || currentTheme === 'light';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
    try {
      localStorage.setItem('dac.theme', currentTheme);
    } catch {
      // ignore storage errors
    }
    void window.deepAutoCodeDesktop?.setThemeOverlay?.(isLightTheme ? 'light' : 'dark');
  }, [currentTheme, isLightTheme]);

  function toggleColorTheme() {
    const nextTheme = isLightTheme ? 'cursor-dark' : 'cursor-light';
    void persistIdeSettings({
      ...ideSettings,
      editor: {
        ...ideSettings.editor,
        theme: nextTheme,
      },
    });
    setStatusNotice(
      nextTheme === 'cursor-light'
        ? 'Switched to Light Theme (Cursor Daylight)'
        : 'Switched to Dark Theme (Cursor Dark)'
    );
  }

  function startPaneResize(
    sash: 'left' | 'right' | 'bottom' | 'settings',
    e: React.MouseEvent
  ) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingSash(sash);
    const startX = e.clientX;
    const startY = e.clientY;
    const initLeft = leftSidebarWidth;
    const initRight = rightAiDockWidth;
    const initBottom = bottomPanelHeight;
    const initSettings = settingsNavWidth;

    const onMouseMove = (moveEv: MouseEvent) => {
      if (sash === 'left') {
        const next = Math.max(160, Math.min(600, initLeft + (moveEv.clientX - startX)));
        setLeftSidebarWidth(next);
      } else if (sash === 'right') {
        const next = Math.max(280, Math.min(760, initRight - (moveEv.clientX - startX)));
        setRightAiDockWidth(next);
      } else if (sash === 'bottom') {
        const next = Math.max(110, Math.min(560, initBottom - (moveEv.clientY - startY)));
        setBottomPanelHeight(next);
      } else if (sash === 'settings') {
        const next = Math.max(170, Math.min(420, initSettings + (moveEv.clientX - startX)));
        setSettingsNavWidth(next);
      }
    };

    const onMouseUp = () => {
      setDraggingSash(null);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    document.body.style.cursor = sash === 'bottom' ? 'row-resize' : 'col-resize';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  useEffect(() => {
    if (!bootstrappedRef.current) {
      bootstrappedRef.current = true;
      void bootstrapIde();
    }
    const unsub = bridge.onEvent((ev: UIEventMessage) => {
      if (ev.sequence > lastSeqRef.current) {
        lastSeqRef.current = ev.sequence;
      }
      handleRealtimeEvent(ev);
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setShowPalette((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setShowPalette((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        openSettingsCenter('general');
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        openSettingsCenter('models');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void handleOpenProjectAction();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setShowLeftSidebar((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setShowBottomPanel((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setShowRightAiDock((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setShowInlineCommand((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveCurrentTab();
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openSshConnectionModal();
      } else if (e.key === 'F1') {
        e.preventDefault();
        openUserGuide('quickstart');
      } else if (e.key === 'Escape') {
        setShowPalette(false);
        setOpenMenu(null);
        setShowGearPopup(false);
        setShowProjectModal(false);
        setShowCreateModal(null);
        setShowSshModal(false);
        setShowInlineCommand(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unsub();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeTabPath, tabs]);

  function appendLog(line: string) {
    setRuntimeLogs((prev) => [...prev.slice(-120), `[${new Date().toLocaleTimeString()}] ${line}`]);
  }

  function openUserGuide(section: GuideSectionId = 'quickstart') {
    setGuideSection(section);
    const guideTabPath = 'guide://deepautocode';
    setTabs((prev) => {
      const exists = prev.some((t) => t.path === guideTabPath);
      if (exists) return prev;
      return [
        ...prev,
        {
          path: guideTabPath,
          name: '📖 User Guide',
          content: '',
          savedContent: '',
          kind: 'guide',
        },
      ];
    });
    setActiveTabPath(guideTabPath);
    setOpenMenu(null);
    setStatusNotice(`Opened DeepAutoCode User Guide (${section})`);
  }

  function openSettingsCenter(category: SettingsCategory = 'general') {
    setSettingsCategory(category);
    const settingsTabPath = 'settings://deepautocode';
    setTabs((prev) => {
      const exists = prev.some((t) => t.path === settingsTabPath);
      if (exists) return prev;
      return [
        ...prev,
        {
          path: settingsTabPath,
          name: 'DeepAutoCode Settings',
          content: '',
          savedContent: '',
          kind: 'settings',
        },
      ];
    });
    setActiveTabPath(settingsTabPath);
  }

  function openWebPreviewTab(targetUrl?: string) {
    const cleanUrl = (targetUrl || previewUrlInput || 'http://localhost:3000/').trim();
    setPreviewUrlInput(cleanUrl);
    const previewTabPath = 'preview://localhost';
    setTabs((prev) => {
      const exists = prev.some((t) => t.path === previewTabPath);
      if (exists) {
        return prev.map((t) =>
          t.path === previewTabPath ? { ...t, content: cleanUrl, savedContent: cleanUrl } : t
        );
      }
      return [
        ...prev,
        {
          path: previewTabPath,
          name: '🌐 Web Preview',
          content: cleanUrl,
          savedContent: cleanUrl,
          kind: 'preview',
        },
      ];
    });
    setActiveTabPath(previewTabPath);
    setOpenMenu(null);
    setStatusNotice(`Opened Web Preview: ${cleanUrl}`);
  }

  async function refreshArtifactsAndCustomizations() {
    try {
      const [artRes, custRes] = await Promise.all([
        fetch('/api/workspace/artifacts').then((r) => r.json()).catch(() => null),
        fetch('/api/workspace/customizations').then((r) => r.json()).catch(() => null),
      ]);
      if (Array.isArray(artRes?.artifacts)) {
        setArtifactsList(artRes.artifacts);
        if (!activeArtifactId && artRes.artifacts.length > 0) {
          setActiveArtifactId(artRes.artifacts[0].id);
        }
      }
      if (custRes?.ok) {
        setWorkspaceCustomizations({
          rules: Array.isArray(custRes.rules) ? custRes.rules : [],
          skills: Array.isArray(custRes.skills) ? custRes.skills : [],
          workflows: Array.isArray(custRes.workflows) ? custRes.workflows : [],
        });
      }
    } catch {
      // ignore
    }
  }

  function handleInlineCommandSubmit(overrideInstruction?: string) {
    const instruction = (overrideInstruction ?? inlineCommandInput).trim();
    if (!instruction) return;
    const currentFile = activeTab?.kind === 'code' ? activeTab.path : files[0] || '';
    const lineHint = cursorPos.line ? ` (around line ${cursorPos.line})` : '';
    setShowRightAiDock(true);
    setAiTab('composer');
    setShowInlineCommand(false);
    setInlineCommandInput('');
    const isExplain = /^(?:explain|what|why|analyze)/i.test(instruction);
    void handleSendPrompt(
      currentFile
        ? `[Inline Command on ${currentFile}${lineHint}]: ${instruction}`
        : instruction,
      isExplain ? 'plan' : 'auto'
    );
  }

  async function handleScaffoldCustomization(kind: 'rule' | 'skill' | 'workflow') {
    const defaultName =
      kind === 'rule'
        ? 'coding-standards'
        : kind === 'skill'
          ? 'code-review'
          : 'verify-build';
    const defaultContent =
      kind === 'rule'
        ? `# Workspace Coding Standards (.agents/rules)\n\n1. Maintain strict type safety and clear error handling.\n2. Always run build and verification tests after modifying source files.\n3. Keep functions modular and preserve existing public APIs.\n`
        : kind === 'skill'
          ? `---\nname: code-review\ndescription: Deep architectural, boundary-value, and concurrency code review skill\n---\n\n# Code Review Skill\n\n1. Inspect all modified functions from signature to closing brace.\n2. Verify boundary conditions, memory safety, and error propagation.\n3. Provide exact clickable file:line references.\n`
          : `---\ndescription: Build and run verification suite\n---\n\n1. Compile the workspace project.\n2. Execute verification tests and fix any regressions.\n`;
    try {
      const res = await fetch('/api/workspace/customizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, name: defaultName, content: defaultContent }),
      }).then((r) => r.json());
      if (res.ok) {
        await refreshArtifactsAndCustomizations();
        await refreshWorkspaceTree();
        void openFileInTab(res.path, true, true);
        setStatusNotice(`Created Antigravity ${kind}: ${res.path}`);
      } else {
        setStatusNotice(res.error || `Failed to create ${kind}`);
      }
    } catch (err) {
      setStatusNotice((err as Error).message);
    }
  }

  async function bootstrapIde() {
    let currentWsRoot = '';
    let initialFiles: string[] = [];

    try {
      const wsData = await fetch('/api/workspace/files').then((r) => r.json());
      currentWsRoot = wsData.workspaceRoot ?? '';
      setWorkspaceRoot(currentWsRoot);
      setWorkspaceName(wsData.workspaceName || 'No Folder Opened');
      if (Array.isArray(wsData.tree)) setFileTree(wsData.tree);
      if (Array.isArray(wsData.files)) {
        initialFiles = wsData.files;
        setFiles(wsData.files);
      }
    } catch {
      // ignore
    }

    try {
      const sshRes = await fetch('/api/ssh/status').then((r) => r.json());
      if (sshRes?.status) setSshStatus(sshRes.status);
      if (Array.isArray(sshRes?.profiles)) setSshProfiles(sshRes.profiles);
    } catch {
      // ignore
    }

    try {
      const [sessList, prov, back] = await Promise.all([
        bridge.request<any[]>('session.list'),
        bridge.request<any>('provider.get'),
        bridge.request<any>('backend.status'),
      ]);
      setSessions(sessList);
      setProviderData(prov);
      if (prov?.active?.provider) {
        setSelectedProviderId(prov.active.provider.providerId);
        setEndpointInput(prov.active.provider.apiEndpoint);
        setModelInput(prov.active.model.modelId);
      }
      setBackendStatus(back);

      if (currentWsRoot) {
        setShowLeftSidebar(true);
        setShowRightAiDock(true);
        const normRoot = (p: string) => (p || '').replace(/\\/g, '/').toLowerCase();
        const matchingSession = sessList.find(
          (s: any) => normRoot(s.workspaceRoot) === normRoot(currentWsRoot)
        );

        if (matchingSession) {
          await selectAndResumeSession(matchingSession.sessionId);
        } else {
          const folderName = currentWsRoot.split(/[\\/]/).pop() || 'Workspace';
          const created = await bridge.request<any>('session.create', {
            title: `${folderName} AI Session`,
            workspaceRoot: currentWsRoot,
            executionMode,
          });
          const updatedList = await bridge.request<any[]>('session.list');
          setSessions(updatedList);
          await selectAndResumeSession(created.sessionId);
        }
      }
    } catch (err) {
      setStatusNotice(`Init notice: ${(err as Error).message}`);
    }

    await Promise.all([
      refreshGitStatus(),
      loadServerIdeSettings(),
      refreshArtifactsAndCustomizations(),
      fetch('/api/extensions')
        .then((r) => r.json())
        .then(setExtensionsCatalog)
        .catch(() => {}),
    ]);

    if (currentWsRoot && initialFiles.length > 0) {
      const preferredFile =
        initialFiles.find((f) => /^readme\.md$/i.test(f)) ||
        initialFiles.find((f) => /^package\.json$/i.test(f)) ||
        initialFiles[0];
      if (preferredFile) {
        await openFileInTab(preferredFile, true);
      }
    }
  }

  async function loadServerIdeSettings() {
    try {
      const res = await fetch('/api/settings').then((r) => r.json());
      if (res.settings) {
        setIdeSettings(res.settings);
        setExecutionMode(res.settings.agent?.defaultExecutionMode ?? 'auto');
      }
      if (typeof res.workspaceRoot === 'string') {
        setWorkspaceRoot(res.workspaceRoot);
        if (res.workspaceRoot) {
          setCustomFolderInput(res.workspaceRoot);
        }
      }
      if (Array.isArray(res.capabilities)) {
        setRegisteredCapabilities(res.capabilities);
      }
    } catch {
      // ignore
    }
  }

  async function persistIdeSettings(nextSettings: any) {
    setIdeSettings(nextSettings);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextSettings),
      });
      setStatusNotice('Settings saved to .deepautocode-data/ide-settings.json');
    } catch (err) {
      setStatusNotice(`Save settings failed: ${(err as Error).message}`);
    }
  }

  async function refreshWorkspaceTree() {
    try {
      const data = await fetch('/api/workspace/files').then((r) => r.json());
      if (data.workspaceRoot) setWorkspaceRoot(data.workspaceRoot);
      if (data.workspaceName) setWorkspaceName(data.workspaceName);
      if (Array.isArray(data.tree)) {
        setFileTree(data.tree);
      }
      if (Array.isArray(data.files)) {
        setFiles(data.files);
      }
    } catch {
      // ignore
    }
  }

  async function handleOpenProjectAction() {
    if (window.deepAutoCodeDesktop?.openFolderDialog) {
      const picked = await window.deepAutoCodeDesktop.openFolderDialog();
      if (picked) {
        await switchProjectFolder(picked);
        return;
      }
    }
    setShowProjectModal(true);
  }

  async function switchProjectFolder(folderPath: string) {
    try {
      const res = await fetch('/api/workspace/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath }),
      }).then((r) => r.json());
      if (!res.ok) {
        throw new Error(res.error || 'Failed to switch workspace folder');
      }
      const nextRoot = res.workspaceRoot as string;
      const folderName = nextRoot.split(/[\\/]/).pop() || nextRoot;
      setWorkspaceRoot(nextRoot);
      setWorkspaceName(folderName);
      setFileTree(res.tree ?? []);
      setShowLeftSidebar(true);
      setShowRightAiDock(true);
      if (Array.isArray(res.recentWorkspaces)) {
        setIdeSettings((prev: any) => ({ ...prev, recentWorkspaces: res.recentWorkspaces }));
      }

      // Clear tabs from previous project (keep Settings tab if open)
      setTabs((prev) => prev.filter((t) => t.kind === 'settings'));
      setActiveTabPath('');

      // Open a representative file from the newly opened project
      const nextFiles: string[] = Array.isArray(res.files) ? res.files : [];
      setFiles(nextFiles);
      const firstFile =
        nextFiles.find((f) => /^readme\.md$/i.test(f)) ||
        nextFiles.find((f) => /^package\.json$/i.test(f)) ||
        nextFiles[0];
      if (firstFile) {
        await openFileInTab(firstFile, true);
      }

      // Switch or create an AI session dedicated to the newly opened project folder
      const sessList = await bridge.request<any[]>('session.list');
      const normRoot = (p: string) => (p || '').replace(/\\/g, '/').toLowerCase();
      const matchingSession = sessList.find(
        (s: any) => normRoot(s.workspaceRoot) === normRoot(nextRoot)
      );
      if (matchingSession) {
        setSessions(sessList);
        await selectAndResumeSession(matchingSession.sessionId);
      } else {
        const created = await bridge.request<any>('session.create', {
          title: `${folderName} AI Session`,
          workspaceRoot: nextRoot,
          executionMode,
        });
        const updatedList = await bridge.request<any[]>('session.list');
        setSessions(updatedList);
        await selectAndResumeSession(created.sessionId);
      }

      setShowProjectModal(false);
      setStatusNotice(`Switched project workspace to: ${nextRoot}`);
      appendLog(`[Workspace] Switched active project root -> ${nextRoot}`);
      await Promise.all([refreshGitStatus(), refreshArtifactsAndCustomizations()]);
    } catch (err) {
      setStatusNotice(`Switch folder error: ${(err as Error).message}`);
    }
  }

  function handleCloseFolder() {
    void fetch('/api/workspace/close', { method: 'POST' }).catch(() => {});
    setWorkspaceRoot('');
    setWorkspaceName('No Folder Opened');
    setFileTree([]);
    setFiles([]);
    setGitState({ branch: 'main', changes: [] });
    setTabs([]);
    setActiveTabPath('');
    setShowLeftSidebar(false);
    setShowBottomPanel(false);
    setShowRightAiDock(false);
    setStatusNotice('Closed active workspace folder');
    appendLog('[Workspace] Closed active project folder');
  }

  async function handleCloseWindow() {
    if (window.deepAutoCodeDesktop?.windowControl) {
      await window.deepAutoCodeDesktop.windowControl('close');
      return;
    }
    window.close();
  }

  async function handleCreateFileOrFolder() {
    if (!createTargetName.trim() || !showCreateModal) return;
    const targetPath = createTargetName.trim();
    const kind = showCreateModal;
    try {
      const res = await fetch('/api/workspace/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetPath,
          kind,
          content:
            kind === 'file'
              ? `// Created in DeepAutoCode IDE (${new Date().toISOString()})\n`
              : '',
        }),
      }).then((r) => r.json());

      if (!res.ok) throw new Error(res.error || 'Creation failed');
      setFileTree(res.tree ?? []);
      setShowCreateModal(null);
      setStatusNotice(`Created ${kind}: ${targetPath}`);
      if (kind === 'file') {
        await openFileInTab(targetPath, true);
      }
    } catch (err) {
      setStatusNotice(`Create error: ${(err as Error).message}`);
    }
  }

  async function refreshGitStatus() {
    try {
      const data = await fetch('/api/git/status').then((r) => r.json());
      setGitState({
        branch: data.branch || 'main',
        changes: Array.isArray(data.changes) ? data.changes : [],
      });
    } catch {
      // ignore
    }
  }

  function resolveWorkspaceFilePath(rawInput: string): string {
    let cleaned = String(rawInput ?? '').trim();
    if (!cleaned) return '';
    // Strip file:// URL scheme
    if (/^file:\/\//i.test(cleaned)) {
      try {
        cleaned = decodeURIComponent(cleaned.replace(/^file:\/\/\/?/i, ''));
      } catch {
        cleaned = cleaned.replace(/^file:\/\/\/?/i, '');
      }
      // On Windows file:///C:/... leaves C:/..., on Unix file:///home/... needs leading /
      if (!/^[a-zA-Z]:/.test(cleaned) && !cleaned.startsWith('/')) {
        cleaned = '/' + cleaned;
      }
    }
    cleaned = cleaned.replace(/\\/g, '/').replace(/^\.\//, '');

    // Strip active SSH remote workspace root if present
    const sshRoot = sshStatus?.activeProfile?.remotePath
      ? String(sshStatus.activeProfile.remotePath).replace(/\\/g, '/').replace(/\/+$/, '')
      : '';
    if (sshRoot && cleaned.startsWith(sshRoot + '/')) {
      cleaned = cleaned.slice(sshRoot.length + 1);
    }

    // Strip local workspaceRoot if present
    const normWsRoot = workspaceRoot
      ? workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
      : '';
    if (normWsRoot && cleaned.toLowerCase().startsWith(normWsRoot.toLowerCase() + '/')) {
      cleaned = cleaned.slice(normWsRoot.length + 1);
    }

    // Match against known workspace files (exact match or suffix match for absolute paths / bare filenames)
    if (files.length > 0 && !files.includes(cleaned)) {
      const lower = cleaned.toLowerCase();
      const exactCaseInsensitive = files.find((f) => f.toLowerCase() === lower);
      if (exactCaseInsensitive) {
        return exactCaseInsensitive;
      }
      // If cleaned is an absolute path like /home/renjc01/Bug/fhccl/src/enqueue.cc, find longest matching workspace file suffix
      const suffixMatches = files
        .filter((f) => lower.endsWith('/' + f.toLowerCase()) || f.toLowerCase().endsWith('/' + lower))
        .sort((a, b) => b.length - a.length);
      if (suffixMatches.length > 0) {
        return suffixMatches[0];
      }
    }

    return cleaned.replace(/^\/+/, '');
  }

  function scrollEditorToLine(contentStr: string, targetLine: number, targetEndLine?: number) {
    const lines = (contentStr || '').split('\n');
    const clampedLine = Math.max(1, Math.min(lines.length || 1, targetLine));
    const clampedEndLine = Math.max(
      clampedLine,
      Math.min(lines.length || 1, targetEndLine ?? clampedLine)
    );
    setCursorPos({ line: clampedLine, col: 1 });

    setTimeout(() => {
      const textarea = codeTextareaRef.current;
      const gutter = codeGutterRef.current;
      const highlight = codeHighlightRef.current;

      if (textarea) {
        let startOffset = 0;
        for (let i = 0; i < clampedLine - 1 && i < lines.length; i++) {
          startOffset += lines[i].length + 1;
        }
        let endOffset = startOffset;
        for (let i = clampedLine - 1; i < clampedEndLine && i < lines.length; i++) {
          endOffset += lines[i].length + (i < clampedEndLine - 1 ? 1 : 0);
        }
        try {
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(startOffset, endOffset);
        } catch {
          // ignore selection errors
        }
      }

      const firstGutterRow = gutter?.firstElementChild as HTMLElement | null;
      const rowHeight =
        firstGutterRow && firstGutterRow.getBoundingClientRect().height > 8
          ? firstGutterRow.getBoundingClientRect().height
          : 20.8;
      const viewportHeight = textarea?.clientHeight || gutter?.clientHeight || 400;
      const targetScrollTop = Math.max(0, (clampedLine - 1) * rowHeight - viewportHeight * 0.35);

      if (textarea) textarea.scrollTop = targetScrollTop;
      if (gutter) gutter.scrollTop = targetScrollTop;
      if (highlight) highlight.scrollTop = targetScrollTop;
    }, 35);
  }

  const IMAGE_FILE_EXT_PATTERN = /\.(?:png|ico|jpg|jpeg|gif|webp|svg|bmp|avif)$/i;

  function getImageMimeType(filePath: string): string {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    switch (ext) {
      case 'png':
        return 'image/png';
      case 'ico':
        return 'image/x-icon';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'svg':
        return 'image/svg+xml';
      case 'bmp':
        return 'image/bmp';
      case 'avif':
        return 'image/avif';
      default:
        return 'image/png';
    }
  }

  async function openFileInTab(
    rawFilePath: string,
    activate = true,
    forceReload = false,
    targetLine?: number,
    targetEndLine?: number
  ) {
    const filePath = resolveWorkspaceFilePath(rawFilePath);
    if (!filePath) return;

    const existing = tabs.find((t) => t.path === filePath);
    if (
      existing &&
      !forceReload &&
      (!/\.pdf$/i.test(filePath) || existing.content.startsWith('blob:')) &&
      (!IMAGE_FILE_EXT_PATTERN.test(filePath) || existing.kind === 'image')
    ) {
      if (activate) setActiveTabPath(filePath);
      if (targetLine && targetLine > 0) {
        scrollEditorToLine(existing.content, targetLine, targetEndLine);
        setStatusNotice(
          `Jumped to ${filePath}:${targetLine}${
            targetEndLine && targetEndLine > targetLine ? `-${targetEndLine}` : ''
          }`
        );
      }
      return;
    }
    if (IMAGE_FILE_EXT_PATTERN.test(filePath)) {
      try {
        const mime = getImageMimeType(filePath);
        const res = await bridge.request<any>(
          'capability.invoke',
          {
            capability: 'read-file',
            executionMode: 'plan',
            params: {
              filePath,
              encoding: 'base64',
              maxBytes: 25 * 1024 * 1024,
            },
          },
          activeSessionId || undefined
        );
        const b64 = String(res?.content || '').trim();
        let imageUrl = `/api/workspace/raw?path=${encodeURIComponent(filePath)}`;
        if (b64) {
          imageUrl = `data:${mime};base64,${b64}`;
        }
        const name = filePath.split('/').pop() || filePath;
        const newTab: OpenTab = {
          path: filePath,
          name: `🖼️ ${name}`,
          content: imageUrl,
          savedContent: imageUrl,
          kind: 'image',
        };
        setTabs((prev) => [...prev.filter((t) => t.path !== filePath), newTab]);
        if (activate) setActiveTabPath(filePath);
        setImageZoom(1);
        setImageDimensions(null);
        setStatusNotice(`Opened Image: ${filePath}`);
      } catch {
        const rawUrl = `/api/workspace/raw?path=${encodeURIComponent(filePath)}`;
        const name = filePath.split('/').pop() || filePath;
        const newTab: OpenTab = {
          path: filePath,
          name: `🖼️ ${name}`,
          content: rawUrl,
          savedContent: rawUrl,
          kind: 'image',
        };
        setTabs((prev) => [...prev.filter((t) => t.path !== filePath), newTab]);
        if (activate) setActiveTabPath(filePath);
        setImageZoom(1);
        setImageDimensions(null);
        setStatusNotice(`Opened Image Preview: ${filePath}`);
      }
      return;
    }
    if (/\.pdf$/i.test(filePath)) {
      try {
        const res = await bridge.request<any>(
          'capability.invoke',
          {
            capability: 'read-file',
            executionMode: 'plan',
            params: {
              filePath,
              encoding: 'base64',
              maxBytes: 20 * 1024 * 1024,
            },
          },
          activeSessionId || undefined
        );
        const b64 = String(res?.content || '').trim();
        let pdfUrl = `/api/workspace/raw?path=${encodeURIComponent(filePath)}`;
        if (b64) {
          const binStr = window.atob(b64);
          const bytes = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) {
            bytes[i] = binStr.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: 'application/pdf' });
          pdfUrl = URL.createObjectURL(blob);
        }
        const name = filePath.split('/').pop() || filePath;
        const newTab: OpenTab = {
          path: filePath,
          name: `📕 ${name}`,
          content: pdfUrl,
          savedContent: pdfUrl,
          kind: 'code',
        };
        setTabs((prev) => [...prev.filter((t) => t.path !== filePath), newTab]);
        if (activate) setActiveTabPath(filePath);
        setStatusNotice(`Opened PDF preview: ${filePath}`);
      } catch (err) {
        setStatusNotice(`Failed to open PDF ${filePath}: ${(err as Error).message}`);
      }
      return;
    }
    try {
      const res = await bridge.request<any>(
        'capability.invoke',
        {
          capability: 'read-file',
          executionMode: 'plan',
          params: { filePath },
        },
        activeSessionId || undefined
      );
      const contentStr = res.content ?? '';
      const name = filePath.split('/').pop() || filePath;
      const newTab: OpenTab = {
        path: filePath,
        name,
        content: contentStr,
        savedContent: contentStr,
        kind: 'code',
      };
      setTabs((prev) => [...prev.filter((t) => t.path !== filePath), newTab]);
      if (activate) setActiveTabPath(filePath);
      if (targetLine && targetLine > 0) {
        scrollEditorToLine(contentStr, targetLine, targetEndLine);
        setStatusNotice(
          `Opened ${filePath}:${targetLine}${
            targetEndLine && targetEndLine > targetLine ? `-${targetEndLine}` : ''
          }`
        );
      } else {
        setStatusNotice(`Opened ${filePath}`);
      }
      appendLog(`[Capability:read-file] ${filePath} (${res.byteLength} bytes)`);
    } catch (err) {
      setStatusNotice(`Cannot open ${filePath}: ${(err as Error).message}`);
    }
  }

  async function navigateToSourceLocation(
    rawRef: string,
    explicitStartLine?: number,
    explicitEndLine?: number
  ) {
    let text = String(rawRef ?? '').trim();
    if (!text) return;

    let startLine = explicitStartLine;
    let endLine = explicitEndLine;

    // 1. Check #L123-L456 or #L123 anchor
    const hashMatch = text.match(/^(.*?)#L?(\d+)(?:-L?(\d+))?$/i);
    if (hashMatch) {
      text = hashMatch[1];
      if (!startLine) startLine = Number(hashMatch[2]);
      if (!endLine && hashMatch[3]) endLine = Number(hashMatch[3]);
    }

    // 2. Check :123-456 or :123:45 or :123 suffix (excluding Windows drive letters like C:/)
    const colonMatch = text.match(/^(.+?\.[a-zA-Z0-9_+-]+):(\d+)(?:[-:](\d+))?$/);
    if (colonMatch) {
      text = colonMatch[1];
      if (!startLine) startLine = Number(colonMatch[2]);
      if (!endLine && colonMatch[3]) endLine = Number(colonMatch[3]);
    }

    // 3. Check parenthesized line numbers like "src/init.cc (1663-1687)"
    const parenMatch = text.match(/^(.+?\.[a-zA-Z0-9_+-]+)\s*[(（]L?(\d+)(?:\s*[-~]\s*L?(\d+))?[)）]$/i);
    if (parenMatch) {
      text = parenMatch[1];
      if (!startLine) startLine = Number(parenMatch[2]);
      if (!endLine && parenMatch[3]) endLine = Number(parenMatch[3]);
    }

    await openFileInTab(text, true, false, startLine, endLine);
  }

  function openDiffInTab(diff: any) {
    const tabPath = `diff://${diff.diffId}/${diff.filePath}`;
    const newTab: OpenTab = {
      path: tabPath,
      name: `Diff: ${diff.filePath.split('/').pop()}`,
      content: diff.unifiedDiff || '',
      savedContent: diff.unifiedDiff || '',
      kind: 'diff',
      diffRecord: diff,
    };
    setTabs((prev) => [...prev.filter((t) => t.path !== tabPath), newTab]);
    setActiveTabPath(tabPath);
  }

  function closeTab(tabPath: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== tabPath);
      if (activeTabPath === tabPath) {
        setActiveTabPath(next[next.length - 1]?.path ?? '');
      }
      return next;
    });
  }

  async function saveCurrentTab() {
    const current = tabs.find((t) => t.path === activeTabPath);
    if (!current || current.kind !== 'code') return;
    try {
      await bridge.request<any>(
        'capability.invoke',
        {
          capability: 'write-file',
          executionMode: 'auto',
          params: { filePath: current.path, content: current.content },
        },
        activeSessionId || undefined
      );
      setTabs((prev) =>
        prev.map((t) => (t.path === current.path ? { ...t, savedContent: t.content } : t))
      );
      setStatusNotice(`Saved ${current.path}`);
      appendLog(`[Capability:write-file] Saved ${current.path}`);
      void refreshGitStatus();
    } catch (err) {
      setStatusNotice(`Save blocked/rejected: ${(err as Error).message}`);
    }
  }

  async function saveAllTabs() {
    for (const tab of tabs) {
      if (tab.kind === 'code' && tab.content !== tab.savedContent) {
        await bridge.request<any>(
          'capability.invoke',
          {
            capability: 'write-file',
            executionMode: 'auto',
            params: { filePath: tab.path, content: tab.content },
          },
          activeSessionId || undefined
        );
      }
    }
    setTabs((prev) => prev.map((t) => ({ ...t, savedContent: t.content })));
    setStatusNotice('Saved all modified files');
  }

  async function handleWorkspaceSearch(q: string) {
    setSearchQuery(q);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    const res = await fetch('/api/workspace/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    }).then((r) => r.json());
    setSearchResults(res.matches ?? []);
  }

  async function handleRunTerminalCommand(cmdText?: string) {
    const cmd = (cmdText ?? terminalInput).trim();
    if (!cmd) return;
    setTerminalInput('');
    setShowBottomPanel(true);
    setActiveBottomTab('terminal');
    appendLog(`[Terminal] Executing: ${cmd}`);

    const res = await fetch('/api/terminal/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    }).then((r) => r.json());

    setTerminalHistory((prev) => [
      ...prev,
      {
        id: `term_${Date.now()}`,
        cmd,
        output: (res.stdout || '') + (res.stderr ? `\n${res.stderr}` : ''),
        exitCode: res.exitCode ?? 0,
        durationMs: res.durationMs ?? 0,
        ts: new Date().toLocaleTimeString(),
      },
    ]);
    void refreshWorkspaceTree();
    void refreshGitStatus();
  }

  function handleRealtimeEvent(ev: UIEventMessage) {
    appendLog(`[Event #${ev.sequence}] ${ev.type}`);
    switch (ev.type) {
      case 'assistant.text.delta':
        setStreamingText((prev) => prev + String(ev.payload.delta ?? ''));
        break;
      case 'assistant.text.done':
        setStreamingText('');
        setLiveToolCalls([]);
        void selectAndResumeSession(ev.sessionId);
        void bridge.request<any[]>('session.list').then(setSessions);
        void refreshWorkspaceTree();
        void refreshGitStatus();
        break;
      case 'tool.call.started':
        setLiveToolCalls((prev) => [...prev, ev.payload]);
        break;
      case 'tool.call.completed':
      case 'tool.call.failed':
        setLiveToolCalls((prev) =>
          prev.map((tc) => (tc.toolCallId === ev.payload.toolCallId ? ev.payload : tc))
        );
        break;
      case 'approval.requested':
        setPendingApprovals((prev) => [...prev, ev.payload]);
        setStatusNotice(`Approval required: ${ev.payload.toolName} (${ev.payload.risk})`);
        break;
      case 'approval.resolved':
        setPendingApprovals((prev) =>
          prev.filter((a) => a.approvalId !== ev.payload.approvalId)
        );
        break;
      case 'diff.proposed':
        setDiffs((prev) => {
          const exists = prev.some((d) => d.diffId === ev.payload.diffId);
          return exists
            ? prev.map((d) => (d.diffId === ev.payload.diffId ? ev.payload : d))
            : [ev.payload, ...prev];
        });
        if (
          ev.payload?.filePath &&
          typeof ev.payload?.proposedContent === 'string'
        ) {
          const modPath = String(ev.payload.filePath).replace(/\\/g, '/');
          const newCode = ev.payload.proposedContent;
          setTabs((prev) => {
            const hasTab = prev.some((t) => t.path.replace(/\\/g, '/') === modPath);
            if (hasTab) {
              return prev.map((t) =>
                t.path.replace(/\\/g, '/') === modPath
                  ? { ...t, content: newCode, savedContent: newCode }
                  : t
              );
            }
            const name = modPath.split('/').pop() || modPath;
            return [
              ...prev,
              {
                path: modPath,
                name,
                kind: 'code',
                content: newCode,
                savedContent: newCode,
              },
            ];
          });
          setActiveTabPath(modPath);
          setStatusNotice(`Modified file: ${modPath}`);
        }
        void refreshWorkspaceTree();
        void refreshGitStatus();
        break;
      case 'runtime.error':
        setStatusNotice(`Runtime error: ${ev.payload.message}`);
        break;
    }
  }

  async function selectAndResumeSession(sessionId: string) {
    setActiveSessionId(sessionId);
    const snapshot = await bridge.resumeSession(sessionId, lastSeqRef.current);
    setMessages(snapshot.messages ?? []);
    setDiffs(snapshot.diffs ?? []);
    setPendingApprovals(snapshot.pendingApprovals ?? []);
    setRecoveredFlag(Boolean(snapshot.recoveredAcrossInstanceRestart));
  }

  async function handleCreateSession(initialPrompt?: string) {
    const folderName = workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() : 'Workspace';
    const created = await bridge.request<any>('session.create', {
      title: initialPrompt
        ? initialPrompt.slice(0, 28)
        : `${folderName} Session ${sessions.length + 1}`,
      prompt: initialPrompt,
      workspaceRoot: workspaceRoot || undefined,
      executionMode,
      modelId: modelInput || undefined,
    });
    const list = await bridge.request<any[]>('session.list');
    setSessions(list);
    await selectAndResumeSession(created.sessionId);
  }

  function detectUiPromptIntent(rawText: string): {
    isQueryOnly: boolean;
    badgeText: string;
  } {
    const cleaned = String(rawText || '').trim();
    if (!cleaned) {
      return {
        isQueryOnly: executionMode === 'plan',
        badgeText:
          executionMode === 'plan'
            ? '📖 Mode: Read-Only Analysis'
            : '⚡ Smart Routing: Read-Only Query / Auto-Edit & Verify',
      };
    }
    if (
      /(?:只分析|仅分析|不要改|先别改|别修改|不修改|不要修改|只查询|只看|只解释)/i.test(cleaned)
    ) {
      return { isQueryOnly: true, badgeText: '🔍 Detected: Read-Only Analysis (No Edits)' };
    }
    const hasActionVerb =
      /(?:修复|修改|改一下|帮我改|直接改|改好|解决|处理|实现|新增|添加|创建|编写|写一个|重构|优化|升级|替换|删除|编译|构建|运行测试|跑一下|按你的建议|按你说的|按此方案|落地|继续改|还是不对|仍然不对|依然不对|一键自动)/i.test(
        cleaned
      );
    const hasErrorLog =
      /(?:#wrong\s*=\s*[1-9]|Out of bounds values\s*:\s*[1-9]|\bfatal error:|\berror:\s+[^\n]+|\bSegmentation fault\b|\bFAILED\b|ENOENT|EADDRINUSE)/i.test(
        cleaned
      );
    const hasQueryPattern =
      /(?:是什么|是干嘛的|干什么用|在哪里|在哪儿|怎么理解|为什么|为何|如何理解|帮我看看|帮我查|查一下|查询|分析一下|解释一下|介绍一下|讲讲|有哪些|区别是|流程是|调用链|逻辑是)/i.test(
        cleaned
      );
    if (hasQueryPattern && !hasActionVerb && !hasErrorLog) {
      return { isQueryOnly: true, badgeText: '🔍 Smart Route: Read-Only Analysis (No Edits)' };
    }
    if (hasActionVerb || hasErrorLog) {
      return { isQueryOnly: false, badgeText: '🛠️ Smart Route: Auto-Edit + Build & Verify' };
    }
    if (/[?？]\s*$/.test(cleaned)) {
      return { isQueryOnly: true, badgeText: '🔍 Smart Route: Read-Only Analysis (No Edits)' };
    }
    return { isQueryOnly: false, badgeText: '🛠️ Smart Route: Auto-Edit + Build & Verify' };
  }

  async function handleAutoBuildDiagnoseAndFix() {
    if (isSendingPrompt) return;
    setManualIntentChoice('build-fix');
    try {
      // Step 1: If SSH is not currently connected, check if a saved SSH profile exists and auto-login
      if (!sshStatus.connected && sshProfiles.length > 0) {
        const candidateProfile =
          sshProfiles.find((p: any) => Boolean(p.lastConnectedAt)) || sshProfiles[0];
        if (candidateProfile) {
          setStatusNotice(
            `Auto-connecting to remote SSH server ${candidateProfile.username}@${candidateProfile.host}:${candidateProfile.remotePath}...`
          );
          const connRes = await fetch('/api/ssh/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(candidateProfile),
          }).then((r) => r.json());
          if (connRes?.ok) {
            setSshStatus(connRes.status);
            if (Array.isArray(connRes.profiles)) setSshProfiles(connRes.profiles);
            if (connRes.workspaceRoot) setWorkspaceRoot(connRes.workspaceRoot);
            if (connRes.workspaceName) setWorkspaceName(connRes.workspaceName);
            if (Array.isArray(connRes.tree)) setFileTree(connRes.tree);
            if (Array.isArray(connRes.files)) setFiles(connRes.files);
          }
        }
      }
    } catch {
      // proceed with current workspace if SSH auto-login is skipped
    }

    // Step 2: Launch end-to-end autonomous compile -> diagnose -> edit -> verify pipeline
    await handleSendPrompt(
      '请立即启动全自动【编译 → 查错 → 修改源码 → 验证】闭环：先调用 auto_build_and_test（或 run_command）执行当前项目的编译与验证测试；若发现任何编译报错或测试失败（如 #wrong != 0 / FAILED），立即根据报错定位调用 edit_file 修改源码并同步远端，随后再次编译与运行测试，直到编译 0 报错且测试全部通过！',
      'auto'
    );
  }

  async function handleSendPrompt(
    overridePrompt?: string,
    overrideMode?: 'plan' | 'auto' | 'manual'
  ) {
    const raw = (overridePrompt ?? promptInput).trim();
    if (!raw || isSendingPrompt) return;

    const autoIntent = detectUiPromptIntent(raw);
    const resolvedChoice =
      manualIntentChoice === 'query-only' || manualIntentChoice === 'auto-action'
        ? manualIntentChoice
        : autoIntent.isQueryOnly
          ? 'query-only'
          : 'auto-action';

    const effectiveMode =
      overrideMode ?? (resolvedChoice === 'query-only' ? 'plan' : 'auto');
    if (effectiveMode !== executionMode) {
      setExecutionMode(effectiveMode);
    }
    setPromptInput('');
    setStreamingText('');
    setLiveToolCalls([]);
    setIsSendingPrompt(true);
    setStatusNotice('Agent is thinking and executing tools...');

    let finalPrompt = raw;
    if (!overridePrompt) {
      if (manualIntentChoice === 'query-only' && !/^\[READ_ONLY_ANALYSIS\]/i.test(finalPrompt)) {
        finalPrompt = `[READ_ONLY_ANALYSIS] ${finalPrompt}`;
      } else if (
        manualIntentChoice === 'auto-action' &&
        !/^\[FORCE_AUTO_ACTION\]/i.test(finalPrompt)
      ) {
        finalPrompt = `[FORCE_AUTO_ACTION] ${finalPrompt}`;
      }
    }
    if (/(?:^|\s)@terminal\b/i.test(finalPrompt) && terminalHistory.length > 0) {
      const recentTerm = terminalHistory
        .slice(-3)
        .map((t) => `$ ${t.cmd} (exit=${t.exitCode})\n${(t.output || '').slice(0, 1500)}`)
        .join('\n\n');
      finalPrompt = `${finalPrompt}\n\n<mentioned_terminal_output>\n${recentTerm}\n</mentioned_terminal_output>`;
    }
    if (
      !overridePrompt &&
      attachActiveFile &&
      activeTab &&
      activeTab.kind === 'code' &&
      activeTab.path
    ) {
      finalPrompt = `[Context Active File: ${activeTab.path}]\n${finalPrompt}`;
    }

    // Optimistically append user message immediately so the user sees instant feedback
    const optimisticUserMsg = {
      id: `optimistic_u_${Date.now()}`,
      sessionId: activeSessionId || 'pending',
      role: 'user',
      content: raw,
      sequence: messages.length + 1,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    try {
      if (!activeSessionId) {
        await handleCreateSession(finalPrompt);
      } else {
        try {
          await bridge.request(
            'session.send',
            {
              sessionId: activeSessionId,
              prompt: finalPrompt,
              workspaceRoot: workspaceRoot || undefined,
              executionMode: effectiveMode,
              modelId: modelInput || undefined,
            },
            activeSessionId
          );
          await selectAndResumeSession(activeSessionId);
        } catch (sendErr) {
          const sendErrMsg = (sendErr as Error).message || String(sendErr);
          if (sendErrMsg.includes('SESSION_NOT_FOUND')) {
            await handleCreateSession(finalPrompt);
          } else {
            throw sendErr;
          }
        }
      }
      await refreshWorkspaceTree();
      await refreshGitStatus();
      await refreshArtifactsAndCustomizations();
      setStatusNotice('Agent response completed');
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      setStatusNotice(`Agent error: ${errMsg}`);
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          sessionId: activeSessionId || 'err',
          role: 'assistant',
          content: `⚠️ Request failed: ${errMsg}`,
          sequence: prev.length + 1,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsSendingPrompt(false);
    }
  }

  async function handleApprovalDecision(approvalId: string, approved: boolean) {
    await bridge.request('approval.respond', {
      approvalId,
      approved,
      reason: approved ? 'Approved in IDE Workbench' : 'Rejected in IDE Workbench',
    });
    setStatusNotice(approved ? 'Approved tool execution' : 'Rejected tool execution');
  }

  async function handleDiffReview(
    diffId: string,
    action: 'accept' | 'reject' | 'revise',
    explicitSessionId?: string
  ) {
    const existingDiff = diffs.find((d) => d.diffId === diffId);
    const targetSessionId =
      explicitSessionId ||
      existingDiff?.sessionId ||
      activeSessionId ||
      sessions[0]?.sessionId ||
      'default';

    try {
      setStatusNotice(`Processing Diff action: ${action}...`);
      const updated = await bridge.request(
        'diff.review',
        {
          sessionId: targetSessionId,
          diffId,
          action,
          feedback: action === 'revise' ? '请进一步完善错误处理与类型定义' : undefined,
        },
        targetSessionId
      );

      if (!updated) {
        setStatusNotice(`Diff ${diffId} not found`);
        return;
      }

      // Immediately update local diffs state and any open diff tab
      setDiffs((prev) => prev.map((d) => (d.diffId === diffId ? updated : d)));
      const diffTabPath = `diff://${updated.diffId}/${updated.filePath}`;

      await refreshWorkspaceTree();
      await refreshGitStatus();

      if (action === 'accept') {
        closeTab(diffTabPath);
        await openFileInTab(updated.filePath, true, true);
        setStatusNotice(`✅ Accepted changes and opened: ${updated.filePath}`);
      } else if (action === 'reject') {
        closeTab(diffTabPath);
        if (updated.operation === 'create') {
          closeTab(updated.filePath);
        } else {
          await openFileInTab(updated.filePath, true, true);
        }
        setStatusNotice(`↩️ Rejected and reverted file changes: ${updated.filePath}`);
      } else if (action === 'revise') {
        openDiffInTab(updated);
        setStatusNotice(`↺ Requested Agent to revise ${updated.filePath}...`);
        void handleSendPrompt(
          `Please revise and improve ${updated.filePath} based on review feedback, ensuring proper error handling and code standards.`
        );
      }
    } catch (err) {
      setStatusNotice(`Diff review error: ${(err as Error).message}`);
    }
  }

  async function handleSimulateExtensionHostRestart() {
    const res = await fetch('/api/simulate-restart', { method: 'POST' }).then((r) => r.json());
    const list = await bridge.request<any[]>('session.list');
    setSessions(list);
    if (activeSessionId) {
      await selectAndResumeSession(activeSessionId);
    }
    appendLog(`[PoC-L2] Extension Host Restarted (${res.oldInstanceId} -> ${res.newInstanceId})`);
    setStatusNotice(
      `PoC-L2 Verified: Restarted ClineCore & restored ${list.length} persisted session(s)!`
    );
  }

  async function handleExportDiagnostics() {
    const dump = await bridge.request('diagnostics.export', {}, activeSessionId);
    setDiagnosticsDump(dump);
    setShowBottomPanel(true);
    setActiveBottomTab('audit');
    setStatusNotice('Exported redacted diagnostic & capability audit bundle');
  }

  async function handleTestAiKey() {
    if (isTestingKey) return;
    setIsTestingKey(true);
    setSmokeResult(null);
    setStatusNotice(`Testing AI API Key connectivity for ${selectedProviderId}...`);
    try {
      // If user typed a new API Key or modified endpoint/model, save it first before testing
      if (apiKeyInput.trim()) {
        const saved = await bridge.request('provider.update', {
          providerId: selectedProviderId,
          apiEndpoint: endpointInput,
          modelId: modelInput,
          apiKey: apiKeyInput.trim(),
        });
        setProviderData((prev: any) => ({ ...prev, active: saved.active }));
        setApiKeyInput('');
      }
      const res = await bridge.request('provider.test', {
        providerId: selectedProviderId,
        modelId: modelInput,
      });
      setSmokeResult(res);
      setStatusNotice(
        res.ok
          ? `✓ AI Key Verified (${selectedProviderId}/${modelInput}, ${res.latencyMs}ms)`
          : `✗ AI Key Test Failed: ${res.diagnostic?.userMessage || 'Check API Key'}`
      );
    } catch (err) {
      const msg = (err as Error).message || String(err);
      setSmokeResult({
        ok: false,
        providerId: selectedProviderId,
        modelId: modelInput,
        latencyMs: 0,
        diagnostic: {
          code: 'NETWORK_UNREACHABLE',
          userMessage: msg,
          remediation: 'Please verify that your API Key is valid and your network connection is active.',
        },
      });
      setStatusNotice(`✗ AI Key Test Error: ${msg}`);
    } finally {
      setIsTestingKey(false);
    }
  }

  async function openSshConnectionModal() {
    setShowSshModal(true);
    setSshTestResult(null);
    setSshBrowseData(null);
    try {
      const res = await fetch('/api/ssh/status').then((r) => r.json());
      if (res?.status) {
        setSshStatus(res.status);
        if (res.status.activeProfile) {
          setSshForm({
            id: res.status.activeProfile.id,
            name: res.status.activeProfile.name || '',
            host: res.status.activeProfile.host || '127.0.0.1',
            port: res.status.activeProfile.port || 22,
            username: res.status.activeProfile.username || 'root',
            authMethod: res.status.activeProfile.authMethod || 'password',
            password: res.status.activeProfile.password || '',
            identityFile: res.status.activeProfile.identityFile || '~/.ssh/id_rsa',
            remotePath: res.status.activeProfile.remotePath || '~',
          });
        }
      }
      if (Array.isArray(res?.profiles)) {
        setSshProfiles(res.profiles);
        if (!res?.status?.activeProfile && res.profiles.length > 0) {
          const first = res.profiles[0];
          setSshForm({
            id: first.id,
            name: first.name || '',
            host: first.host || '127.0.0.1',
            port: first.port || 22,
            username: first.username || 'root',
            authMethod: first.authMethod || 'password',
            password: first.password || '',
            identityFile: first.identityFile || '~/.ssh/id_rsa',
            remotePath: first.remotePath || '~',
          });
        }
      }
    } catch {
      // ignore
    }
  }

  function parseQuickSshCommand() {
    const raw = sshQuickCmd.trim();
    if (!raw) return;
    // Supports: ssh -p 2222 -i ~/.ssh/key user@host:/remote/dir or user@host
    let port = sshForm.port || 22;
    let identityFile = sshForm.identityFile;
    let authMethod = sshForm.authMethod;

    const portMatch = raw.match(/(?:-p|--port)\s+(\d+)/);
    if (portMatch) port = Number(portMatch[1]) || 22;

    const keyMatch = raw.match(/-i\s+([^\s]+)/);
    if (keyMatch) {
      identityFile = keyMatch[1].replace(/^["']|["']$/g, '');
      authMethod = 'identity-file';
    }

    const cleaned = raw
      .replace(/^ssh\s+/i, '')
      .replace(/(?:-p|--port)\s+\d+/g, '')
      .replace(/-i\s+[^\s]+/g, '')
      .trim();

    const targetToken = cleaned.split(/\s+/)[0] || '';
    let username = sshForm.username || 'root';
    let hostPart = targetToken;
    let remotePath = sshForm.remotePath || '~';

    if (targetToken.includes('@')) {
      const [u, rest] = targetToken.split('@');
      if (u) username = u;
      hostPart = rest || '';
    }

    if (hostPart.includes(':')) {
      const [h, p] = hostPart.split(':');
      hostPart = h;
      if (p) {
        if (/^\d+$/.test(p)) {
          port = Number(p);
        } else {
          remotePath = p;
        }
      }
    }

    if (hostPart) {
      setSshForm({
        ...sshForm,
        id: undefined,
        name: `${username}@${hostPart}`,
        host: hostPart,
        port,
        username,
        authMethod,
        identityFile,
        remotePath,
      });
      setStatusNotice(`Parsed SSH target: ${username}@${hostPart}:${port}`);
    }
  }

  async function handleTestSshConnection() {
    if (isTestingSsh) return;
    setIsTestingSsh(true);
    setSshTestResult(null);
    setStatusNotice(`Testing SSH connection to ${sshForm.username}@${sshForm.host}:${sshForm.port}...`);
    try {
      const res = await fetch('/api/ssh/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sshForm),
      }).then((r) => r.json());
      setSshTestResult(res);
      setStatusNotice(
        res.ok
          ? `✓ SSH Connection Verified (${res.latencyMs}ms) — Syncing remote files...`
          : `✗ SSH Test Failed: ${res.message}`
      );
      if (res.ok) {
        // Automatically connect and populate the left Explorer file tree with the remote machine's files
        await handleConnectSshHost(true);
      }
    } catch (err) {
      setSshTestResult({
        ok: false,
        message: (err as Error).message,
      });
    } finally {
      setIsTestingSsh(false);
    }
  }

  async function handleSaveSshProfile() {
    const res = await fetch('/api/ssh/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sshForm),
    }).then((r) => r.json());
    if (Array.isArray(res?.profiles)) {
      setSshProfiles(res.profiles);
      setStatusNotice(`Saved SSH Host "${sshForm.name || sshForm.host}"`);
    }
  }

  async function handleDeleteSshProfile(profileId: string) {
    const res = await fetch('/api/ssh/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    }).then((r) => r.json());
    if (Array.isArray(res?.profiles)) {
      setSshProfiles(res.profiles);
      setStatusNotice('Deleted saved SSH Host profile');
    }
  }

  async function handleBrowseRemoteSsh(targetDir?: string) {
    const dirToBrowse = targetDir ?? sshForm.remotePath ?? '~';
    setStatusNotice(`Browsing remote directory ${dirToBrowse}...`);
    try {
      const res = await fetch('/api/ssh/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: sshForm, targetDir: dirToBrowse }),
      }).then((r) => r.json());
      if (res?.ok) {
        setSshBrowseData({
          currentDir: res.currentDir,
          directories: res.directories || [],
        });
        setSshForm((prev) => ({ ...prev, remotePath: res.currentDir }));
        setStatusNotice(`Loaded remote directory: ${res.currentDir}`);
      } else {
        setStatusNotice(`Remote browse failed: ${res?.error || 'Check SSH connection'}`);
      }
    } catch (err) {
      setStatusNotice(`Remote browse error: ${(err as Error).message}`);
    }
  }

  async function handleConnectSshHost(keepModalOpen = false, remotePathOverride?: string) {
    if (isConnectingSsh) return;
    setIsConnectingSsh(true);
    const activeP = sshStatus?.activeProfile;
    const payload = {
      ...sshForm,
      host: activeP && remotePathOverride ? activeP.host : sshForm.host,
      port: activeP && remotePathOverride ? activeP.port : sshForm.port,
      username: activeP && remotePathOverride ? activeP.username : sshForm.username,
      authMethod: activeP && remotePathOverride ? activeP.authMethod : sshForm.authMethod,
      password: (activeP && remotePathOverride ? activeP.password : undefined) || sshForm.password,
      identityFile: activeP && remotePathOverride ? activeP.identityFile : sshForm.identityFile,
      remotePath: remotePathOverride ?? sshForm.remotePath,
    };
    setStatusNotice(
      `Connecting to Remote SSH ${payload.username}@${payload.host}:${payload.remotePath}...`
    );
    try {
      const res = await fetch('/api/ssh/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json());

      if (!res.ok) {
        setSshTestResult({
          ok: false,
          message: res.error || 'SSH Connection Failed',
        });
        setStatusNotice(`✗ SSH Connect Failed: ${res.error}`);
        return;
      }

      setSshStatus(res.status);
      if (res.status?.activeProfile?.remotePath) {
        setSshForm((prev) => ({
          ...prev,
          remotePath: res.status.activeProfile.remotePath,
        }));
      }
      if (Array.isArray(res.profiles)) setSshProfiles(res.profiles);
      setWorkspaceRoot(res.workspaceRoot);
      setWorkspaceName(res.workspaceName);
      setFileTree(res.tree ?? []);
      setExpandedDirs({});
      setShowLeftSidebar(true);
      setShowRightAiDock(true);
      setActiveActivity('explorer');
      setWorkspaceSectionOpen(true);
      setTabs([]);
      setActiveTabPath('');
      if (!keepModalOpen) {
        setShowSshModal(false);
      }

      const newFiles: string[] = Array.isArray(res.files) ? res.files : [];
      const preferred =
        newFiles.find((f) => /^readme\.md$/i.test(f)) ||
        newFiles.find((f) => /^makefile$/i.test(f)) ||
        newFiles.find((f) => /^package\.json$/i.test(f)) ||
        newFiles[0];
      if (preferred) {
        await openFileInTab(preferred);
      }

      // Create or resume AI Session scoped to the remote SSH workspace
      const sessList = await bridge.request<any[]>('session.list');
      const normRoot = (p: string) => (p || '').replace(/\\/g, '/').toLowerCase();
      const matchingSession = sessList.find(
        (s: any) => normRoot(s.workspaceRoot) === normRoot(res.workspaceRoot)
      );
      if (matchingSession) {
        setSessions(sessList);
        await selectAndResumeSession(matchingSession.sessionId);
      } else {
        const created = await bridge.request<any>('session.create', {
          title: `${res.workspaceName} AI Session`,
          workspaceRoot: res.workspaceRoot,
          executionMode,
        });
        const updatedList = await bridge.request<any[]>('session.list');
        setSessions(updatedList);
        await selectAndResumeSession(created.sessionId);
      }

      await refreshGitStatus();
      appendLog(`[Remote-SSH] Connected to ${sshForm.username}@${sshForm.host}:${sshForm.remotePath}`);
      setStatusNotice(`🌐 Connected to SSH: ${res.workspaceName}`);
    } catch (err) {
      setStatusNotice(`SSH Error: ${(err as Error).message}`);
    } finally {
      setIsConnectingSsh(false);
    }
  }

  async function handleDisconnectSshHost() {
    const res = await fetch('/api/ssh/disconnect', { method: 'POST' }).then((r) => r.json());
    if (res?.ok) {
      setSshStatus(res.status);
      setWorkspaceRoot(res.workspaceRoot);
      setWorkspaceName(res.workspaceName);
      setFileTree(res.tree ?? []);
      setTabs([]);
      setActiveTabPath('');
      setShowSshModal(false);
      await refreshGitStatus();
      setStatusNotice(`Disconnected Remote SSH -> Local (${res.workspaceName})`);
    }
  }

  async function handleNavigateToParentDirectory() {
    if (sshStatus?.connected && sshStatus.activeProfile) {
      const cur = (sshStatus.activeProfile.remotePath || '/root').replace(/\/+$/, '') || '/';
      if (cur === '/') {
        setStatusNotice('Already at remote root directory (/)');
        return;
      }
      const lastSlash = cur.lastIndexOf('/');
      const parentRemote = lastSlash <= 0 ? '/' : cur.slice(0, lastSlash);
      await handleConnectSshHost(true, parentRemote);
      return;
    }

    if (workspaceRoot) {
      const cleaned = workspaceRoot.replace(/[\\/]+$/, '');
      const sepIdx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
      if (sepIdx > 0) {
        const isWinDriveRoot = /^[a-zA-Z]:$/.test(cleaned.slice(0, sepIdx));
        const parentLocal = isWinDriveRoot
          ? `${cleaned.slice(0, sepIdx)}\\`
          : cleaned.slice(0, sepIdx);
        if (parentLocal && parentLocal !== workspaceRoot) {
          await switchProjectFolder(parentLocal);
        }
      }
    }
  }

  async function handleNavigateIntoDirectory(relDirPath: string) {
    const cleanRel = relDirPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanRel) return;
    if (sshStatus?.connected && sshStatus.activeProfile) {
      const base = (sshStatus.activeProfile.remotePath || '/root').replace(/\/+$/, '');
      const targetRemote = base === '' || base === '/' ? `/${cleanRel}` : `${base}/${cleanRel}`;
      await handleConnectSshHost(true, targetRemote);
      return;
    }
    if (workspaceRoot) {
      const sep = workspaceRoot.includes('\\') ? '\\' : '/';
      const base = workspaceRoot.replace(/[\\/]+$/, '');
      const targetLocal = `${base}${sep}${cleanRel.replace(/\//g, sep)}`;
      await switchProjectFolder(targetLocal);
    }
  }

  function formatToolStepLabel(tc: any): string {
    const name = String(tc?.toolName || '');
    const input = tc?.input || {};
    const targetPath = input.path || input.filePath || input.directory || input.dirPath || '';
    const shortPath = targetPath
      ? String(targetPath).split(/[\\/]/).slice(-2).join('/')
      : '';
    if (name === 'read_file' || name === 'read-file')
      return shortPath ? `Read ${shortPath}` : 'Read file';
    if (name === 'list_files' || name === 'list-files')
      return shortPath ? `Scan ${shortPath}` : 'Scan workspace';
    if (
      name === 'write_file' ||
      name === 'write-file' ||
      name === 'edit_file' ||
      name === 'editor' ||
      name === 'reveal-diff'
    )
      return shortPath ? `Edit ${shortPath}` : 'Generate code changes';
    if (
      name === 'run_command' ||
      name === 'run-build' ||
      name === 'auto_build_and_test' ||
      name === 'bash'
    )
      return input.command ? `Run build/command` : 'Run terminal command';
    if (name === 'open_file' || name === 'open-file')
      return shortPath ? `Open ${shortPath}` : 'Locate file';
    if (name === 'browser_action')
      return input.action ? `Browser: ${input.action}` : 'Browser inspect';
    return name;
  }

  interface SplitDiffRow {
    leftLine?: number;
    leftText?: string;
    leftType?: 'del' | 'normal' | 'empty' | 'hdr';
    rightLine?: number;
    rightText?: string;
    rightType?: 'add' | 'normal' | 'empty' | 'hdr';
  }

  function parseDiffToSplitRows(diffText: string): SplitDiffRow[] {
    const lines = (diffText || '').split('\n');
    const rows: SplitDiffRow[] = [];
    let leftNum = 1;
    let rightNum = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('@@')) {
        const m = line.match(/@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
        if (m) {
          leftNum = parseInt(m[1], 10);
          rightNum = parseInt(m[2], 10);
        }
        rows.push({
          leftText: line,
          leftType: 'hdr',
          rightText: line,
          rightType: 'hdr',
        });
        continue;
      }

      if (line.startsWith('-')) {
        if (i + 1 < lines.length && lines[i + 1].startsWith('+')) {
          const nextLine = lines[i + 1];
          rows.push({
            leftLine: leftNum++,
            leftText: line.slice(1),
            leftType: 'del',
            rightLine: rightNum++,
            rightText: nextLine.slice(1),
            rightType: 'add',
          });
          i++;
        } else {
          rows.push({
            leftLine: leftNum++,
            leftText: line.slice(1),
            leftType: 'del',
            rightType: 'empty',
          });
        }
      } else if (line.startsWith('+')) {
        rows.push({
          leftType: 'empty',
          rightLine: rightNum++,
          rightText: line.slice(1),
          rightType: 'add',
        });
      } else {
        const normalText = line.startsWith(' ') ? line.slice(1) : line;
        rows.push({
          leftLine: leftNum++,
          leftText: normalText,
          leftType: 'normal',
          rightLine: rightNum++,
          rightText: normalText,
          rightType: 'normal',
        });
      }
    }
    return rows;
  }

  function triggerDebouncedGhostAutocomplete(content: string, cursorPosOffset: number) {
    if (!autocompleteEnabled) return;
    if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current);
    autocompleteTimerRef.current = setTimeout(async () => {
      try {
        const prefix = content.slice(0, cursorPosOffset);
        const suffix = content.slice(cursorPosOffset);
        const currentLine = prefix.split('\n').pop() || '';
        if (currentLine.trim().length === 0) {
          setGhostText('');
          return;
        }
        const res = await fetch('/api/ai/autocomplete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filePath: activeTabPath,
            prefix,
            suffix,
          }),
        }).then((r) => r.json());
        if (res?.ok && typeof res.completion === 'string' && res.completion.length > 0) {
          setGhostText(res.completion);
        } else {
          setGhostText('');
        }
      } catch {
        setGhostText('');
      }
    }, 280);
  }

  const SOURCE_FILE_EXT_PATTERN =
    /\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|hxx|py|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|md|pdf|txt|csv|sh|bash|zsh|bat|ps1|cmake|mk|go|rs|java|kt|cs|rb|php|sql|html|css|scss|less|vue|svelte|proto|gradle|xml|ini|cfg|conf)$/i;

  function parseSourceReferenceToken(rawToken: string): {
    filePath: string;
    startLine?: number;
    endLine?: number;
    display: string;
  } | null {
    const trimmed = String(rawToken ?? '').trim();
    if (!trimmed || trimmed.length > 220 || /\s/.test(trimmed)) return null;

    let candidate = trimmed;
    let startLine: number | undefined;
    let endLine: number | undefined;

    // 1. Check #L123-L456
    const hashMatch = candidate.match(/^(.*?)#L?(\d+)(?:-L?(\d+))?$/i);
    if (hashMatch) {
      candidate = hashMatch[1];
      startLine = Number(hashMatch[2]);
      if (hashMatch[3]) endLine = Number(hashMatch[3]);
    }

    // 2. Check :123-456 or :123:45 or :123
    const colonMatch = candidate.match(/^(.+?\.[a-zA-Z0-9_+-]+):(\d+)(?:[-:](\d+))?$/);
    if (colonMatch) {
      candidate = colonMatch[1];
      if (!startLine) startLine = Number(colonMatch[2]);
      if (!endLine && colonMatch[3]) endLine = Number(colonMatch[3]);
    }

    // Reject HTTP(S) URLs
    if (/^https?:\/\//i.test(candidate)) return null;

    const cleanCandidate = candidate.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/');
    const isKnownSpecialFile = /(?:^|\/)(?:Makefile|CMakeLists\.txt|Dockerfile)$/i.test(
      cleanCandidate
    );
    if (!SOURCE_FILE_EXT_PATTERN.test(cleanCandidate) && !isKnownSpecialFile) {
      return null;
    }

    // Either has a path separator, or has an explicit line number, or matches a workspace file
    const hasSlash = cleanCandidate.includes('/');
    const hasLine = typeof startLine === 'number' && startLine > 0;
    const matchesWorkspace =
      files.length > 0 &&
      files.some(
        (f) =>
          f.toLowerCase() === cleanCandidate.toLowerCase() ||
          f.toLowerCase().endsWith('/' + cleanCandidate.toLowerCase())
      );

    if (!hasSlash && !hasLine && !matchesWorkspace) {
      return null;
    }

    return {
      filePath: candidate,
      startLine,
      endLine,
      display: trimmed,
    };
  }

  function findBestLineMatchInContent(
    contentStr: string,
    codeBody: string,
    clickedLineText?: string,
    hintStartLine?: number
  ): { startLine: number; endLine: number } | null {
    const fileLines = (contentStr || '').split('\n');
    if (fileLines.length === 0) return null;

    const normalizeCodeLine = (s: string) =>
      s
        .replace(/\/\/.*$/, '')
        .replace(/\/\*.*?\*\//g, '')
        .trim();

    const searchCandidates: string[] = [];
    if (clickedLineText) {
      const normClicked = normalizeCodeLine(clickedLineText);
      if (normClicked.length >= 4) {
        searchCandidates.push(normClicked);
      }
    }

    const snippetLines = (codeBody || '')
      .split('\n')
      .map((l) => normalizeCodeLine(l))
      .filter((l) => l.length >= 5 && !/^[{}()[\];]+$/.test(l));
    for (const sl of snippetLines.slice(0, 6)) {
      if (!searchCandidates.includes(sl)) {
        searchCandidates.push(sl);
      }
    }

    for (const needle of searchCandidates) {
      const matchedLineNumbers: number[] = [];
      for (let i = 0; i < fileLines.length; i++) {
        const hay = normalizeCodeLine(fileLines[i]);
        if (!hay) continue;
        if (hay === needle || (needle.length >= 10 && hay.includes(needle))) {
          matchedLineNumbers.push(i + 1);
        }
      }
      if (matchedLineNumbers.length > 0) {
        if (hintStartLine && hintStartLine > 0) {
          matchedLineNumbers.sort(
            (a, b) => Math.abs(a - hintStartLine) - Math.abs(b - hintStartLine)
          );
        }
        const bestStart = matchedLineNumbers[0];
        const span = Math.max(0, Math.min(25, snippetLines.length - 1));
        return {
          startLine: bestStart,
          endLine: clickedLineText ? bestStart : Math.min(fileLines.length, bestStart + span),
        };
      }
    }

    if (hintStartLine && hintStartLine > 0) {
      return {
        startLine: hintStartLine,
        endLine: Math.min(
          fileLines.length,
          hintStartLine + Math.max(0, Math.min(25, (codeBody || '').split('\n').length - 1))
        ),
      };
    }

    return null;
  }

  async function navigateToAiCodeSnippet(
    codeBody: string,
    lang: string,
    clickedLineText?: string,
    contextRef?: { filePath?: string; startLine?: number; endLine?: number }
  ) {
    // 1. Check if the code block itself starts with a comment naming a file path
    let targetFile = contextRef?.filePath;
    let targetStart = contextRef?.startLine;
    let targetEnd = contextRef?.endLine;

    const firstLines = (codeBody || '').split('\n').slice(0, 3);
    for (const fl of firstLines) {
      const m = fl.match(
        /([a-zA-Z0-9_./-]+\.(?:c|cc|cpp|cu|cuh|h|hpp|py|ts|tsx|js|jsx|go|rs|java|sh|json|md))(?::(\d+)(?:-(\d+))?)?/i
      );
      if (m) {
        targetFile = m[1];
        if (m[2]) targetStart = Number(m[2]);
        if (m[3]) targetEnd = Number(m[3]);
        break;
      }
    }

    // 2. If we have a target file path from context or comment, load/open it and locate the clicked line!
    if (targetFile) {
      const resolvedPath = resolveWorkspaceFilePath(targetFile);
      if (resolvedPath) {
        let fileContent = tabs.find((t) => t.path === resolvedPath)?.content;
        if (fileContent === undefined) {
          try {
            const res = await bridge.request<any>(
              'capability.invoke',
              {
                capability: 'read-file',
                executionMode: 'plan',
                params: { filePath: resolvedPath },
              },
              activeSessionId || undefined
            );
            fileContent = res.content ?? '';
            const name = resolvedPath.split('/').pop() || resolvedPath;
            const newTab: OpenTab = {
              path: resolvedPath,
              name,
              content: fileContent,
              savedContent: fileContent,
              kind: 'code',
            };
            setTabs((prev) => [...prev.filter((t) => t.path !== resolvedPath), newTab]);
          } catch {
            fileContent = undefined;
          }
        }

        if (fileContent !== undefined) {
          setActiveTabPath(resolvedPath);
          const matched = findBestLineMatchInContent(
            fileContent,
            codeBody,
            clickedLineText,
            targetStart
          );
          const finalStart = matched?.startLine ?? targetStart ?? 1;
          const finalEnd = matched?.endLine ?? targetEnd ?? finalStart;
          scrollEditorToLine(fileContent, finalStart, finalEnd);
          setStatusNotice(
            `Located ${resolvedPath}:${finalStart}${
              finalEnd > finalStart ? `-${finalEnd}` : ''
            }`
          );
          return;
        }
      }
    }

    // 3. Search currently open code tabs for a matching line
    for (const tab of tabs) {
      if (tab.kind !== 'code' || tab.path.startsWith('ai-snippet://')) continue;
      const matched = findBestLineMatchInContent(tab.content, codeBody, clickedLineText);
      if (matched) {
        setActiveTabPath(tab.path);
        scrollEditorToLine(tab.content, matched.startLine, matched.endLine);
        setStatusNotice(`Located in open tab: ${tab.path}:${matched.startLine}`);
        return;
      }
    }

    // 4. Fallback: Open the AI code block directly in the center Code Editor as an interactive preview tab
    const extMap: Record<string, string> = {
      c: 'c',
      cpp: 'cc',
      cc: 'cc',
      cxx: 'cc',
      cu: 'cu',
      h: 'h',
      bash: 'sh',
      sh: 'sh',
      shell: 'sh',
      python: 'py',
      py: 'py',
      typescript: 'ts',
      ts: 'ts',
      tsx: 'tsx',
      javascript: 'js',
      js: 'js',
      json: 'json',
    };
    const ext = extMap[lang.toLowerCase()] || 'txt';
    const previewPath = targetFile
      ? resolveWorkspaceFilePath(targetFile) || `AI-Preview.${ext}`
      : `AI-Code-Preview.${ext}`;
    const previewTab: OpenTab = {
      path: previewPath,
      name: `📄 ${previewPath.split('/').pop()}`,
      content: codeBody,
      savedContent: codeBody,
      kind: 'code',
    };
    setTabs((prev) => [...prev.filter((t) => t.path !== previewPath), previewTab]);
    setActiveTabPath(previewPath);
    const snippetMatch = findBestLineMatchInContent(codeBody, codeBody, clickedLineText, 1);
    scrollEditorToLine(codeBody, snippetMatch?.startLine ?? 1, snippetMatch?.endLine ?? 1);
    setStatusNotice(`Opened AI code snippet in editor (${previewTab.name})`);
  }

  async function navigateToInlineCodeOrSymbol(
    codeText: string,
    contextRef?: { filePath?: string; startLine?: number; endLine?: number }
  ) {
    const parsed = parseSourceReferenceToken(codeText);
    if (parsed) {
      await navigateToSourceLocation(parsed.filePath, parsed.startLine, parsed.endLine);
      return;
    }
    // Also support "src/init.cc:1663-1687" or "src/enqueue.cc (782-811)" inside backticks
    const embeddedFileMatch = codeText.match(
      /([a-zA-Z0-9_./-]+\.[a-zA-Z0-9_+-]+)(?::(\d+)(?:-(\d+))?)?/
    );
    if (embeddedFileMatch) {
      const subParsed = parseSourceReferenceToken(embeddedFileMatch[0]);
      if (subParsed) {
        await navigateToSourceLocation(
          subParsed.filePath,
          subParsed.startLine,
          subParsed.endLine
        );
        return;
      }
    }
    // Otherwise treat as a symbol/expression click and locate it in contextRef file or open tabs
    await navigateToAiCodeSnippet(codeText, 'code', codeText, contextRef);
  }

  function renderPlainTextWithSourceLinks(
    text: string,
    keyPrefix: string,
    _contextRef?: { filePath?: string; startLine?: number; endLine?: number }
  ): React.ReactNode[] {
    // Linear-time O(N) token split by Markdown links or word/punctuation delimiters (zero backtracking)
    const tokens = text.split(/(\[[^\]]+\]\([^)]+\)|[\s,;()[\]{}<>"'，；。（）【】「」|]+)/g);
    return tokens.map((token, idx) => {
      if (!token) return null;
      if (token.startsWith('[')) {
        const mdLink = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (mdLink) {
          const label = mdLink[1];
          const href = mdLink[2].trim();
          if (/^https?:\/\//i.test(href)) {
            return (
              <a
                key={`${keyPrefix}_a_${idx}`}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="md-source-link"
              >
                {label} ↗
              </a>
            );
          }
          return (
            <code
              key={`${keyPrefix}_l_${idx}`}
              className="md-inline-code md-source-link"
              title={`Click to open in editor: ${href}`}
              onClick={() => void navigateToSourceLocation(href)}
            >
              📄 {label}
            </code>
          );
        }
      }
      const parsed = parseSourceReferenceToken(token);
      if (parsed) {
        return (
          <code
            key={`${keyPrefix}_s_${idx}`}
            className="md-inline-code md-source-link"
            title={`Click to jump to source: ${parsed.display}`}
            onClick={() =>
              void navigateToSourceLocation(
                parsed.filePath,
                parsed.startLine,
                parsed.endLine
              )
            }
          >
            📍 {parsed.display}
          </code>
        );
      }
      return <React.Fragment key={`${keyPrefix}_t_${idx}`}>{token}</React.Fragment>;
    });
  }

  function renderInlineFormatted(
    text: string,
    contextRef?: { filePath?: string; startLine?: number; endLine?: number }
  ): React.ReactNode[] {
    const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return tokens.map((tok, idx) => {
      if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
        const inner = tok.slice(1, -1);
        const parsedRef = parseSourceReferenceToken(inner);
        const isClickableSymbol =
          Boolean(parsedRef) ||
          Boolean(contextRef?.filePath) ||
          /^[a-zA-Z_][a-zA-Z0-9_:.-]{2,80}(\(\))?$/.test(inner.trim());
        return (
          <code
            key={idx}
            className={`md-inline-code ${
              parsedRef
                ? 'md-source-link'
                : isClickableSymbol
                  ? 'md-symbol-link'
                  : ''
            }`}
            title={
              parsedRef
                ? `Click to jump to source location: ${parsedRef.display}`
                : isClickableSymbol
                  ? `Click to locate in editor: ${inner}`
                  : undefined
            }
            onClick={
              isClickableSymbol
                ? () => void navigateToInlineCodeOrSymbol(inner, contextRef)
                : undefined
            }
          >
            {parsedRef ? `📍 ${inner}` : inner}
          </code>
        );
      }
      if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
        return (
          <strong key={idx}>
            {renderPlainTextWithSourceLinks(tok.slice(2, -2), `b_${idx}`, contextRef)}
          </strong>
        );
      }
      return (
        <React.Fragment key={idx}>
          {renderPlainTextWithSourceLinks(tok, `p_${idx}`, contextRef)}
        </React.Fragment>
      );
    });
  }

  function extractLatestSourceRefFromText(
    textChunk: string,
    prevRef?: { filePath?: string; startLine?: number; endLine?: number }
  ): { filePath?: string; startLine?: number; endLine?: number } | undefined {
    const words = String(textChunk ?? '').split(/[\s,;()[\]{}<>"'`，；。（）【】「」|]+/);
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (!w || !w.includes('.')) continue;
      const parsed = parseSourceReferenceToken(w);
      if (parsed) {
        return {
          filePath: parsed.filePath,
          startLine: parsed.startLine,
          endLine: parsed.endLine,
        };
      }
    }
    return prevRef;
  }

  function extractCompactExecutiveSummary(cleaned: string): {
    conclusionLines: string[];
    sourceRefs: Array<{
      filePath: string;
      startLine?: number;
      endLine?: number;
      display: string;
    }>;
    primaryCodeBlock?: {
      lang: string;
      codeBody: string;
      context?: { filePath?: string; startLine?: number; endLine?: number };
    };
  } {
    const rawLines = cleaned.split('\n');
    const conclusionLines: string[] = [];

    // 1. Prioritize lines under "结论", "根因定位", "核心原因", "决定性因素", or "修改内容"
    let inConclusionSection = false;
    for (const rawLine of rawLines) {
      const t = rawLine.trim();
      if (!t || t === '---' || t.startsWith('```') || t.startsWith('|')) {
        if (inConclusionSection && conclusionLines.length >= 2) break;
        continue;
      }
      if (/^(?:#+\s*)?(?:🎯\s*)?(?:结论|核心原因|根因定位|核心结论|总结)\b/.test(t)) {
        inConclusionSection = true;
        const inlineAfterColon = t.replace(
          /^(?:#+\s*)?(?:🎯\s*)?(?:结论|核心原因|根因定位|核心结论|总结)\s*[:：]?\s*/,
          ''
        );
        if (inlineAfterColon.length >= 8) {
          conclusionLines.push(inlineAfterColon);
        }
        continue;
      }
      if (/^(?:\*\*|[-*•]\s*)?(?:决定性因素|核心修复|修改内容|验证结果)\s*[:：]/.test(t)) {
        conclusionLines.push(t.replace(/^[-*•]\s*/, ''));
        if (conclusionLines.length >= 3) break;
        continue;
      }
      if (inConclusionSection && !t.startsWith('#')) {
        conclusionLines.push(t.replace(/^[-*•]\s*/, ''));
        if (conclusionLines.length >= 3) break;
      }
    }

    // Fallback: pick first 2 meaningful prose lines (not headings, tables, or code fences)
    if (conclusionLines.length === 0) {
      let insideFence = false;
      for (const rawLine of rawLines) {
        const t = rawLine.trim();
        if (t.startsWith('```')) {
          insideFence = !insideFence;
          continue;
        }
        if (insideFence || !t || t.startsWith('#') || t.startsWith('|') || t === '---') {
          continue;
        }
        if (t.length >= 10) {
          conclusionLines.push(t.replace(/^[-*•]\s*/, ''));
          if (conclusionLines.length >= 2) break;
        }
      }
    }

    // 2. Collect unique file:line references across the entire message using linear-time word splitting
    const sourceRefs: Array<{
      filePath: string;
      startLine?: number;
      endLine?: number;
      display: string;
    }> = [];
    const seenRefKeys = new Set<string>();
    const allTokens = cleaned.split(/[\s,;()[\]{}<>"'`，；。（）【】「」|]+/);
    for (const tok of allTokens) {
      if (!tok || !tok.includes('.')) continue;
      const parsed = parseSourceReferenceToken(tok);
      if (!parsed) continue;
      const key = `${parsed.filePath}:${parsed.startLine || 0}`;
      if (seenRefKeys.has(key)) continue;
      seenRefKeys.add(key);
      sourceRefs.push(parsed);
      if (sourceRefs.length >= 6) break;
    }

    // 3. Pick the primary source code block (preferring C/C++/TS/Py/JS over bash/log blocks)
    const segments = cleaned.split(/(```[\s\S]*?```)/g);
    let runningCtx: { filePath?: string; startLine?: number; endLine?: number } | undefined;
    let primaryCodeBlock:
      | {
          lang: string;
          codeBody: string;
          context?: { filePath?: string; startLine?: number; endLine?: number };
        }
      | undefined;

    for (const seg of segments) {
      if (seg.startsWith('```') && seg.endsWith('```')) {
        const lines = seg.slice(3, -3).split('\n');
        const firstLine = (lines[0] || '').trim();
        const hasLang = /^[a-zA-Z0-9_+-]+$/.test(firstLine);
        const lang = hasLang ? firstLine.toLowerCase() : 'code';
        const codeBody = (hasLang ? lines.slice(1) : lines).join('\n').trim();
        if (!codeBody) continue;
        const isSourceCodeLang = /^(c|cpp|cc|cxx|cu|h|hpp|ts|tsx|js|jsx|py|python|go|rust|java)$/.test(
          lang
        );
        if (!primaryCodeBlock || (isSourceCodeLang && primaryCodeBlock.lang === 'code')) {
          const isShellLang = /^(bash|sh|zsh|shell|cmd|powershell|ps1)$/i.test(lang);
          primaryCodeBlock = {
            lang: lang.toUpperCase(),
            codeBody,
            context: isShellLang ? undefined : runningCtx ? { ...runningCtx } : sourceRefs[0],
          };
          if (isSourceCodeLang) break;
        }
      } else {
        for (const l of seg.split('\n')) {
          runningCtx = extractLatestSourceRefFromText(l.trim(), runningCtx);
        }
      }
    }

    return { conclusionLines, sourceRefs, primaryCodeBlock };
  }

  function renderFormattedMarkdown(
    rawContent: string,
    messageId?: string,
    role: string = 'assistant'
  ): React.ReactNode {
    try {
      return renderFormattedMarkdownInner(rawContent, messageId, role);
    } catch {
      return <pre className="md-code-pre">{String(rawContent ?? '')}</pre>;
    }
  }

  function renderFormattedMarkdownInner(
    rawContent: string,
    messageId?: string,
    role: string = 'assistant'
  ): React.ReactNode {
    const cleaned = String(rawContent ?? '')
      .replace(/^\[Context Active File:[^\]]+\]\s*/i, '')
      .trim();
    if (!cleaned) return null;

    const totalLines = cleaned.split('\n').length;
    const isLongAssistantReply =
      role === 'assistant' && Boolean(messageId) && (totalLines > 16 || cleaned.length > 520);
    const isExpanded = messageId ? expandedMessageIds[messageId] !== false : true;
    const compactSummary = isLongAssistantReply
      ? extractCompactExecutiveSummary(cleaned)
      : null;

    // Split by fenced code blocks ```lang ... ```
    const segments = cleaned.split(/(```[\s\S]*?```)/g);
    let activeSourceContext:
      | { filePath?: string; startLine?: number; endLine?: number }
      | undefined;

    return (
      <div className="md-body">
        {isLongAssistantReply && compactSummary && (
          <div className="md-glance-card">
            <div className="md-glance-header">
              <span style={{ fontWeight: 700, color: 'var(--accent-bright)' }}>
                ⚡ Executive Summary
              </span>
              <button
                type="button"
                className="btn"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={() =>
                  messageId &&
                  setExpandedMessageIds((prev) => ({
                    ...prev,
                    [messageId]: prev[messageId] === false ? true : false,
                  }))
                }
              >
                {isExpanded
                  ? '▴ Collapse Details (Summary Only)'
                  : `▾ Expand Full Analysis (${totalLines} lines)`}
              </button>
            </div>

            {compactSummary.conclusionLines.length > 0 && (
              <div className="md-glance-conclusion">
                {compactSummary.conclusionLines.map((cLine, idx) => (
                  <div key={idx} className="md-glance-line">
                    {renderInlineFormatted(cLine, compactSummary.sourceRefs[0])}
                  </div>
                ))}
              </div>
            )}

            {compactSummary.sourceRefs.length > 0 && (
              <div className="md-glance-refs">
                <span className="md-glance-refs-label">Source References:</span>
                {compactSummary.sourceRefs.map((ref, idx) => (
                  <code
                    key={idx}
                    className="md-inline-code md-source-link"
                    title={`Click to open and locate ${ref.display} in editor`}
                    onClick={() =>
                      void navigateToSourceLocation(
                        ref.filePath,
                        ref.startLine,
                        ref.endLine
                      )
                    }
                  >
                    📍 {ref.display}
                  </code>
                ))}
              </div>
            )}

            {!isExpanded && compactSummary.primaryCodeBlock && (
              <div className="md-code-block" style={{ marginTop: 4 }}>
                <div className="md-code-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>Key Code ({compactSummary.primaryCodeBlock.lang})</span>
                    {compactSummary.primaryCodeBlock.context?.filePath && (
                      <span
                        className="md-code-file-badge"
                        onClick={() =>
                          void navigateToAiCodeSnippet(
                            compactSummary.primaryCodeBlock!.codeBody,
                            compactSummary.primaryCodeBlock!.lang,
                            undefined,
                            compactSummary.primaryCodeBlock!.context
                          )
                        }
                      >
                        📍 {compactSummary.primaryCodeBlock.context.filePath}
                        {compactSummary.primaryCodeBlock.context.startLine
                          ? `:${compactSummary.primaryCodeBlock.context.startLine}`
                          : ''}
                      </span>
                    )}
                  </div>
                  <button
                    className="btn"
                    style={{ padding: '1px 6px', fontSize: 10 }}
                    onClick={() =>
                      void navigateToAiCodeSnippet(
                        compactSummary.primaryCodeBlock!.codeBody,
                        compactSummary.primaryCodeBlock!.lang,
                        undefined,
                        compactSummary.primaryCodeBlock!.context
                      )
                    }
                  >
                    🔍 Open in Editor
                  </button>
                </div>
                <pre className="md-code-pre">
                  <code>
                    {compactSummary.primaryCodeBlock.codeBody
                      .split('\n')
                      .slice(0, 10)
                      .map((cLine, cIdx) => (
                        <div
                          key={cIdx}
                          className="md-code-line"
                          title="Click this line to locate in code editor"
                          onClick={() =>
                            void navigateToAiCodeSnippet(
                              compactSummary.primaryCodeBlock!.codeBody,
                              compactSummary.primaryCodeBlock!.lang,
                              cLine,
                              compactSummary.primaryCodeBlock!.context
                            )
                          }
                        >
                          <span className="md-code-line-num">
                            {(compactSummary.primaryCodeBlock?.context?.startLine ?? 1) +
                              cIdx}
                          </span>
                          <span className="md-code-line-text">{cLine || ' '}</span>
                        </div>
                      ))}
                  </code>
                </pre>
              </div>
            )}
          </div>
        )}

        {(!isLongAssistantReply || isExpanded) &&
          segments.map((segment, segIdx) => {
          if (segment.startsWith('```') && segment.endsWith('```')) {
            const lines = segment.slice(3, -3).split('\n');
            const firstLine = (lines[0] || '').trim();
            const hasLang = /^[a-zA-Z0-9_+-]+$/.test(firstLine);
            const lang = hasLang ? firstLine : 'code';
            const codeBody = (hasLang ? lines.slice(1) : lines).join('\n').trim();
            const codeLinesArr = codeBody.split('\n');
            const capturedContext = activeSourceContext
              ? { ...activeSourceContext }
              : undefined;
            const contextBadgeLabel = capturedContext?.filePath
              ? `${capturedContext.filePath}${
                  capturedContext.startLine
                    ? `:${capturedContext.startLine}${
                        capturedContext.endLine &&
                        capturedContext.endLine > capturedContext.startLine
                          ? `-${capturedContext.endLine}`
                          : ''
                      }`
                    : ''
                }`
              : null;

            return (
              <div key={segIdx} className="md-code-block">
                <div className="md-code-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{lang.toUpperCase()}</span>
                    {contextBadgeLabel && (
                      <span
                        className="md-code-file-badge"
                        title={`Click to open ${contextBadgeLabel} in editor`}
                        onClick={() =>
                          void navigateToAiCodeSnippet(
                            codeBody,
                            lang,
                            undefined,
                            capturedContext
                          )
                        }
                      >
                        📍 {contextBadgeLabel}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      className="btn"
                      style={{ padding: '1px 6px', fontSize: 10 }}
                      title="Open and locate this code snippet in editor"
                      onClick={() =>
                        void navigateToAiCodeSnippet(
                          codeBody,
                          lang,
                          undefined,
                          capturedContext
                        )
                      }
                    >
                      🔍 View in Editor
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '1px 6px', fontSize: 10 }}
                      onClick={() => {
                        void navigator.clipboard.writeText(codeBody);
                        setStatusNotice('Copied code snippet to clipboard');
                      }}
                    >
                      📋 Copy Code
                    </button>
                  </div>
                </div>
                <pre className="md-code-pre">
                  <code>
                    {codeLinesArr.map((cLine, cIdx) => (
                      <div
                        key={cIdx}
                        className="md-code-line"
                        title="Click this line to locate corresponding file and line in editor"
                        onClick={() =>
                          void navigateToAiCodeSnippet(
                            codeBody,
                            lang,
                            cLine,
                            capturedContext
                          )
                        }
                      >
                        <span className="md-code-line-num">
                          {(capturedContext?.startLine ?? 1) + cIdx}
                        </span>
                        <span className="md-code-line-text">{cLine || ' '}</span>
                      </div>
                    ))}
                  </code>
                </pre>
              </div>
            );
          }

          const lines = segment.split('\n');
          const elements: React.ReactNode[] = [];
          let listBuffer: { ordered: boolean; items: string[] } | null = null;
          let tableBuffer: string[][] | null = null;

          const flushList = (keyPrefix: string) => {
            if (!listBuffer) return;
            const ListTag = listBuffer.ordered ? 'ol' : 'ul';
            const ctxSnap = activeSourceContext ? { ...activeSourceContext } : undefined;
            elements.push(
              <ListTag key={keyPrefix} className="md-list">
                {listBuffer.items.map((item, i) => (
                  <li key={i} className="md-li">
                    {renderInlineFormatted(item, ctxSnap)}
                  </li>
                ))}
              </ListTag>
            );
            listBuffer = null;
          };

          const flushTable = (keyPrefix: string) => {
            if (!tableBuffer || tableBuffer.length === 0) return;
            const rows = tableBuffer.filter(
              (r) => !r.every((cell) => /^[:\-\s]+$/.test(cell))
            );
            tableBuffer = null;
            if (rows.length === 0) return;

            const headerRow = rows[0];
            const bodyRows = rows.slice(1);

            elements.push(
              <div key={keyPrefix} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {headerRow.map((hCell, cIdx) => (
                        <th key={cIdx}>{renderInlineFormatted(hCell, activeSourceContext)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bodyRows.map((row, rIdx) => {
                      // Check if this row has a file column and a separate line-range column (e.g. | src/init.cc | 1663-1687 |)
                      let rowFileRef: string | undefined;
                      let rowStartLine: number | undefined;
                      let rowEndLine: number | undefined;

                      for (const cell of row) {
                        const cleanCell = cell.replace(/`/g, '').trim();
                        const parsed = parseSourceReferenceToken(cleanCell);
                        if (parsed) {
                          rowFileRef = parsed.filePath;
                          if (parsed.startLine) rowStartLine = parsed.startLine;
                          if (parsed.endLine) rowEndLine = parsed.endLine;
                        } else if (/^\d+(?:\s*[-~]\s*\d+)?$/.test(cleanCell) && !rowStartLine) {
                          const parts = cleanCell.split(/[-~]/).map((s) => Number(s.trim()));
                          rowStartLine = parts[0];
                          if (parts[1]) rowEndLine = parts[1];
                        }
                      }

                      const rowCtx = rowFileRef
                        ? {
                            filePath: rowFileRef,
                            startLine: rowStartLine,
                            endLine: rowEndLine,
                          }
                        : activeSourceContext;

                      return (
                        <tr key={rIdx}>
                          {row.map((cell, cIdx) => {
                            const cleanCell = cell.replace(/`/g, '').trim();
                            const isPureLineRange =
                              Boolean(rowFileRef) && /^\d+(?:\s*[-~]\s*\d+)?$/.test(cleanCell);
                            const cellParsed = parseSourceReferenceToken(cleanCell);

                            if (cellParsed && rowStartLine && !cellParsed.startLine) {
                              return (
                                <td key={cIdx}>
                                  <code
                                    className="md-inline-code md-source-link"
                                    title={`Click to open ${cellParsed.filePath}:${rowStartLine}`}
                                    onClick={() =>
                                      void navigateToSourceLocation(
                                        cellParsed.filePath,
                                        rowStartLine,
                                        rowEndLine
                                      )
                                    }
                                  >
                                    📍 {cleanCell}
                                  </code>
                                </td>
                              );
                            }

                            if (isPureLineRange && rowFileRef && rowStartLine) {
                              return (
                                <td key={cIdx}>
                                  <code
                                    className="md-inline-code md-source-link"
                                    title={`Click to jump to ${rowFileRef}:${cleanCell}`}
                                    onClick={() =>
                                      void navigateToSourceLocation(
                                        rowFileRef!,
                                        rowStartLine,
                                        rowEndLine
                                      )
                                    }
                                  >
                                    L{cleanCell} ↗
                                  </code>
                                </td>
                              );
                            }

                            return <td key={cIdx}>{renderInlineFormatted(cell, rowCtx)}</td>;
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          };

          lines.forEach((line, lineIdx) => {
            const trimmed = line.trim();
            activeSourceContext = extractLatestSourceRefFromText(
              trimmed,
              activeSourceContext
            );

            if (!trimmed) {
              flushList(`list_${segIdx}_${lineIdx}`);
              flushTable(`tbl_${segIdx}_${lineIdx}`);
              return;
            }

            // Detect Markdown table rows: | col1 | col2 |
            if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
              flushList(`list_${segIdx}_${lineIdx}`);
              const cells = trimmed
                .slice(1, -1)
                .split('|')
                .map((c) => c.trim());
              if (!tableBuffer) tableBuffer = [];
              tableBuffer.push(cells);
              return;
            } else if (tableBuffer) {
              flushTable(`tbl_${segIdx}_${lineIdx}`);
            }

            const ctxSnap = activeSourceContext ? { ...activeSourceContext } : undefined;

            if (trimmed.startsWith('### ')) {
              flushList(`list_${segIdx}_${lineIdx}`);
              elements.push(
                <h4 key={`h3_${lineIdx}`} className="md-h3">
                  {renderInlineFormatted(trimmed.slice(4), ctxSnap)}
                </h4>
              );
            } else if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
              flushList(`list_${segIdx}_${lineIdx}`);
              const titleText = trimmed.replace(/^#+\s*/, '');
              elements.push(
                <h3 key={`h2_${lineIdx}`} className="md-h2">
                  {renderInlineFormatted(titleText, ctxSnap)}
                </h3>
              );
            } else if (/^[-*•]\s+/.test(trimmed)) {
              const itemText = trimmed.replace(/^[-*•]\s+/, '');
              if (!listBuffer || listBuffer.ordered) {
                flushList(`list_${segIdx}_${lineIdx}`);
                listBuffer = { ordered: false, items: [] };
              }
              listBuffer.items.push(itemText);
            } else if (/^\d+\.\s+/.test(trimmed)) {
              const itemText = trimmed.replace(/^\d+\.\s+/, '');
              if (!listBuffer || !listBuffer.ordered) {
                flushList(`list_${segIdx}_${lineIdx}`);
                listBuffer = { ordered: true, items: [] };
              }
              listBuffer.items.push(itemText);
            } else if (trimmed.startsWith('> ')) {
              flushList(`list_${segIdx}_${lineIdx}`);
              elements.push(
                <blockquote key={`q_${lineIdx}`} className="md-quote">
                  {renderInlineFormatted(trimmed.slice(2), ctxSnap)}
                </blockquote>
              );
            } else {
              flushList(`list_${segIdx}_${lineIdx}`);
              elements.push(
                <p key={`p_${lineIdx}`} className="md-p">
                  {renderInlineFormatted(trimmed, ctxSnap)}
                </p>
              );
            }
          });

          flushList(`list_end_${segIdx}`);
          flushTable(`tbl_end_${segIdx}`);
          return <React.Fragment key={segIdx}>{elements}</React.Fragment>;
        })}
      </div>
    );
  }

  function getFileVisualMeta(filePath: string): {
    badge: string;
    color: string;
    language: string;
  } {
    const clean = (filePath || '').toLowerCase();
    const ext = clean.includes('.') ? clean.split('.').pop() || '' : '';
    switch (ext) {
      case 'ts':
        return { badge: 'TS', color: '#3b82f6', language: 'TypeScript' };
      case 'tsx':
        return { badge: 'TSX', color: '#38bdf8', language: 'TypeScript React' };
      case 'js':
      case 'mjs':
      case 'cjs':
        return { badge: 'JS', color: '#eab308', language: 'JavaScript' };
      case 'jsx':
        return { badge: 'JSX', color: '#22d3ee', language: 'JavaScript React' };
      case 'html':
      case 'htm':
        return { badge: '<>', color: '#f97316', language: 'HTML' };
      case 'css':
      case 'scss':
      case 'less':
        return { badge: '#', color: '#06b6d4', language: 'CSS' };
      case 'json':
        return { badge: '{}', color: '#f59e0b', language: 'JSON' };
      case 'md':
      case 'mdx':
        return { badge: 'M↓', color: '#a855f7', language: 'Markdown' };
      case 'py':
        return { badge: 'PY', color: '#3b82f6', language: 'Python' };
      case 'sh':
      case 'bash':
      case 'ps1':
      case 'cmd':
        return { badge: '$_', color: '#10b981', language: 'Shell' };
      case 'yml':
      case 'yaml':
        return { badge: 'YML', color: '#ec4899', language: 'YAML' };
      case 'ico':
        return { badge: 'ICO', color: '#f59e0b', language: 'Icon File' };
      case 'png':
        return { badge: 'PNG', color: '#10b981', language: 'PNG Image' };
      case 'jpg':
      case 'jpeg':
        return { badge: 'JPG', color: '#06b6d4', language: 'JPEG Image' };
      case 'gif':
        return { badge: 'GIF', color: '#ec4899', language: 'GIF Image' };
      case 'webp':
        return { badge: 'WEBP', color: '#38bdf8', language: 'WebP Image' };
      case 'svg':
        return { badge: 'SVG', color: '#f97316', language: 'SVG Vector' };
      case 'bmp':
        return { badge: 'BMP', color: '#8b5cf6', language: 'Bitmap Image' };
      default:
        return {
          badge: (ext || 'FILE').toUpperCase().slice(0, 3),
          color: '#94a3b8',
          language: ext ? ext.toUpperCase() : 'Plain Text',
        };
    }
  }

  function renderSyntaxHighlightedLine(
    line: string,
    lineIdx: number,
    isActiveLine: boolean
  ): React.ReactNode {
    const trimmed = line.trim();
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('<!--')
    ) {
      return (
        <div
          key={lineIdx}
          className={`ag-code-line ${isActiveLine ? 'active' : ''}`}
        >
          <span className="tok-comment">{line || ' '}</span>
        </div>
      );
    }

    const tokenRegex =
      /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*$|<!--[\s\S]*?-->|<\/?[a-zA-Z0-9-]+|\b(?:import|export|from|const|let|var|function|return|async|await|if|else|for|while|switch|case|break|continue|try|catch|finally|new|class|interface|type|extends|implements|true|false|null|undefined|void|typeof|in|of)\b|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms)?\b|\b[a-zA-Z_$][\w$]*(?=\s*\())/g;

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let tokIdx = 0;

    while ((match = tokenRegex.exec(line)) !== null) {
      if (match.index > lastIndex) {
        parts.push(line.slice(lastIndex, match.index));
      }
      const token = match[0];
      let cls = 'tok-kw';
      if (token.startsWith('//') || token.startsWith('<!--')) {
        cls = 'tok-comment';
      } else if (
        token.startsWith('"') ||
        token.startsWith("'") ||
        token.startsWith('`')
      ) {
        cls = 'tok-str';
      } else if (token.startsWith('<')) {
        cls = 'tok-tag';
      } else if (/^\d/.test(token)) {
        cls = 'tok-num';
      } else if (
        /^(import|export|from|const|let|var|function|return|async|await|if|else|for|while|switch|case|break|continue|try|catch|finally|new|class|interface|type|extends|implements|true|false|null|undefined|void|typeof|in|of)$/.test(
          token
        )
      ) {
        cls = 'tok-kw';
      } else {
        cls = 'tok-fn';
      }
      parts.push(
        <span key={tokIdx++} className={cls}>
          {token}
        </span>
      );
      lastIndex = tokenRegex.lastIndex;
    }

    if (lastIndex < line.length) {
      parts.push(line.slice(lastIndex));
    }

    return (
      <div
        key={lineIdx}
        className={`ag-code-line ${isActiveLine ? 'active' : ''}`}
      >
        {parts.length > 0 ? parts : ' '}
        {isActiveLine && ghostText && (
          <span className="ag-ghost-text">
            {ghostText} <span className="ag-ghost-hint">Tab ⇥</span>
          </span>
        )}
      </div>
    );
  }

  function renderTreeNodes(nodes: any[], depth = 0): React.ReactNode {
    return nodes.map((node) => {
      const guides = Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          className="ag-indent-guide"
          style={{ left: 14 + i * 14 }}
        />
      ));

      if (node.type === 'directory') {
        const isOpen = Boolean(expandedDirs[node.path] ?? depth < 1);
        const hasChildren = Array.isArray(node.children) && node.children.length > 0;
        const hasModifiedChild = gitState.changes.some((c) =>
          c.file.replace(/\\/g, '/').startsWith(`${node.path.replace(/\\/g, '/')}/`)
        );
        return (
          <div key={node.path} className="ag-tree-group">
            <div
              className={`ag-tree-row directory ${isOpen ? 'open' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              title={`${node.path} (Click to expand, or click ↵ / double-click to enter directory)`}
              onClick={() => {
                if (!hasChildren && sshStatus?.connected) {
                  void handleNavigateIntoDirectory(node.path);
                  return;
                }
                setExpandedDirs((prev) => ({ ...prev, [node.path]: !isOpen }));
              }}
              onDoubleClick={() => void handleNavigateIntoDirectory(node.path)}
            >
              {guides}
              <span className="ag-tree-chevron">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  {isOpen ? (
                    <path d="M3.2 5.5L8 10.3l4.8-4.8.9.9L8 12.1 2.3 6.4l.9-.9z" />
                  ) : (
                    <path d="M5.5 3.2L10.3 8l-4.8 4.8.9.9L12.1 8 6.4 2.3l-.9.9z" />
                  )}
                </svg>
              </span>
              <span className="ag-folder-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  {isOpen ? (
                    <path d="M1.5 2.5A1.5 1.5 0 013 1h3.293a1.5 1.5 0 011.06.44l1.122 1.12A.5.5 0 008.828 2.7H13A1.5 1.5 0 0114.5 4.2v1.3H2.8a1.5 1.5 0 00-1.45 1.11L1.5 3.8V2.5zm1.35 4.2h11.6a.8.8 0 01.77 1.01l-1.45 5.2a1.5 1.5 0 01-1.45 1.09H2.5a1.5 1.5 0 01-1.45-1.89l1.35-4.4a1.2 1.2 0 01.45-1.01z" />
                  ) : (
                    <path d="M1.5 3A1.5 1.5 0 013 1.5h3.293a1.5 1.5 0 011.06.44l1.122 1.12a.5.5 0 00.353.14H13A1.5 1.5 0 0114.5 4.7v7.8A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z" />
                  )}
                </svg>
              </span>
              <span className="ag-tree-label folder">{node.name}</span>
              {hasModifiedChild && <span className="ag-git-dot" title="Contains modified files" />}
              <span
                className="ag-enter-dir-btn"
                title={`Enter folder: ${node.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleNavigateIntoDirectory(node.path);
                }}
              >
                ↵
              </span>
            </div>
            {isOpen && node.children && renderTreeNodes(node.children, depth + 1)}
          </div>
        );
      }

      const meta = getFileVisualMeta(node.name);
      const isSelected = activeTabPath === node.path;
      const openTab = tabs.find((t) => t.path === node.path);
      const isDirty = openTab?.kind === 'code' && openTab.content !== openTab.savedContent;
      const gitChange = gitState.changes.find(
        (c) => c.file.replace(/\\/g, '/') === node.path.replace(/\\/g, '/')
      );

      return (
        <div
          key={node.path}
          className={`ag-tree-row file ${isSelected ? 'selected' : ''} ${
            gitChange ? 'modified' : ''
          }`}
          style={{ paddingLeft: 20 + depth * 14 }}
          onClick={() => void openFileInTab(node.path)}
          title={node.path}
        >
          {guides}
          <span
            className="ag-file-icon"
            style={{
              color: meta.color,
              borderColor: `${meta.color}40`,
              background: `${meta.color}16`,
            }}
          >
            {meta.badge}
          </span>
          <span className="ag-tree-label">{node.name}</span>
          {isDirty ? (
            <span className="ag-git-badge dirty" title="Unsaved changes">
              ●
            </span>
          ) : gitChange ? (
            <span className="ag-git-badge" title={`Git: ${gitChange.status}`}>
              {gitChange.status.slice(0, 1).toUpperCase() || 'M'}
            </span>
          ) : null}
        </div>
      );
    });
  }

  const activeTab = tabs.find((t) => t.path === activeTabPath);
  const codeLines = (activeTab?.content ?? '').split('\n');

  const bodyGridStyle: React.CSSProperties = {
    gridTemplateColumns: [
      '46px',
      showLeftSidebar ? `minmax(180px, min(${leftSidebarWidth}px, 28vw)) 5px` : '',
      'minmax(0, 1fr)',
      showRightAiDock ? `5px minmax(260px, min(${rightAiDockWidth}px, 42vw))` : '',
    ]
      .filter(Boolean)
      .join(' '),
  };

  const centerGridStyle: React.CSSProperties = {
    gridTemplateRows: showBottomPanel
      ? `minmax(0, 1fr) 5px ${bottomPanelHeight}px`
      : 'minmax(0, 1fr)',
  };

  // Complete Cursor / Antigravity Top Menu Bar Definition (Clean, Grouped & Separated)
  const MENU_DEFINITIONS = [
    {
      id: 'file',
      label: 'File',
      items: [
        { header: 'Create' },
        {
          label: 'New File...',
          shortcut: 'Ctrl+N',
          action: () => {
            setCreateTargetName('src/new-file.ts');
            setShowCreateModal('file');
          },
        },
        {
          label: 'New Folder...',
          shortcut: 'Ctrl+Shift+N',
          action: () => {
            setCreateTargetName('src/new-folder');
            setShowCreateModal('directory');
          },
        },
        { divider: true },
        { header: 'Project & Workspace' },
        {
          label: 'Open Folder / Project...',
          shortcut: 'Ctrl+O',
          action: () => void handleOpenProjectAction(),
        },
        {
          label: 'Switch Recent Project...',
          shortcut: 'Ctrl+R',
          action: () => setShowProjectModal(true),
        },
        {
          label: 'Connect to Remote Host (SSH)...',
          shortcut: 'Ctrl+Alt+O',
          action: () => void openSshConnectionModal(),
        },
        ...(sshStatus?.connected
          ? [
              {
                label: 'Close Remote SSH Connection',
                shortcut: '',
                action: () => void handleDisconnectSshHost(),
              },
            ]
          : []),
        { divider: true },
        { header: 'Save' },
        {
          label: 'Save',
          shortcut: 'Ctrl+S',
          action: () => void saveCurrentTab(),
        },
        {
          label: 'Save All',
          shortcut: 'Ctrl+K S',
          action: () => void saveAllTabs(),
        },
        { divider: true },
        { header: 'Preferences' },
        {
          label: 'Settings',
          shortcut: 'Ctrl+,',
          action: () => openSettingsCenter('general'),
        },
        {
          label: 'AI Models & Providers',
          shortcut: 'Ctrl+Shift+J',
          action: () => openSettingsCenter('models'),
        },
        {
          label: 'Security & Approval Policies',
          shortcut: '',
          action: () => openSettingsCenter('security'),
        },
        {
          label: 'Extensions',
          shortcut: 'Ctrl+Shift+X',
          action: () => openSettingsCenter('extensions'),
        },
        { divider: true },
        { header: 'Close' },
        {
          label: 'Close Editor',
          shortcut: 'Ctrl+W',
          action: () => activeTabPath && closeTab(activeTabPath),
        },
        {
          label: 'Close Folder',
          shortcut: 'Ctrl+K F',
          action: () => handleCloseFolder(),
        },
        {
          label: 'Close Window',
          shortcut: 'Alt+F4',
          action: () => void handleCloseWindow(),
        },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        {
          label: 'Find in Files...',
          shortcut: 'Ctrl+Shift+F',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('search');
          },
        },
        { divider: true },
        {
          label: 'Edit AI Project Rules...',
          shortcut: '',
          action: () => openSettingsCenter('rules'),
        },
      ],
    },
    {
      id: 'selection',
      label: 'Selection',
      items: [
        {
          label: 'Add Active File to AI Context',
          shortcut: 'Ctrl+L',
          action: () => {
            setAttachActiveFile(true);
            setShowRightAiDock(true);
          },
        },
        { divider: true },
        {
          label: 'Ask Agent to Review Active File',
          shortcut: '',
          action: () => {
            setShowRightAiDock(true);
            if (activeTab?.kind === 'code') {
              void handleSendPrompt(`Read ${activeTab.path}`);
            }
          },
        },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        {
          label: 'Command Palette...',
          shortcut: 'Ctrl+Shift+P',
          action: () => setShowPalette(true),
        },
        { divider: true },
        { header: 'Panels' },
        {
          label: 'Explorer',
          shortcut: 'Ctrl+Shift+E',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('explorer');
          },
        },
        {
          label: 'Search',
          shortcut: 'Ctrl+Shift+F',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('search');
          },
        },
        {
          label: 'Source Control (Git)',
          shortcut: 'Ctrl+Shift+G',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('git');
          },
        },
        {
          label: 'Extensions',
          shortcut: 'Ctrl+Shift+X',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('extensions');
          },
        },
        { divider: true },
        { header: 'Appearance & Layout' },
        {
          label: 'Toggle Dark / Light Theme',
          shortcut: 'Alt+T',
          action: () => toggleColorTheme(),
        },
        {
          label: 'Toggle Primary Sidebar',
          shortcut: 'Ctrl+B',
          action: () => setShowLeftSidebar((v) => !v),
        },
        {
          label: 'Toggle Bottom Panel',
          shortcut: 'Ctrl+J',
          action: () => setShowBottomPanel((v) => !v),
        },
        {
          label: 'Toggle AI Composer Dock',
          shortcut: 'Ctrl+L',
          action: () => setShowRightAiDock((v) => !v),
        },
      ],
    },
    {
      id: 'go',
      label: 'Go',
      items: [
        {
          label: 'Go to File...',
          shortcut: 'Ctrl+P',
          action: () => setShowPalette(true),
        },
        { divider: true },
        {
          label: 'Product Config (product.json)',
          shortcut: '',
          action: () => void openFileInTab('product/product.json', true),
        },
        {
          label: 'Architecture & ADR Report',
          shortcut: '',
          action: () => void openFileInTab('docs/ADR-AND-POC-REPORT.md', true),
        },
      ],
    },
    {
      id: 'run',
      label: 'Run',
      items: [
        { header: 'Build & Test' },
        {
          label: 'Run TypeScript Typecheck',
          shortcut: 'Ctrl+Shift+B',
          action: () => void handleRunTerminalCommand('npm run typecheck'),
        },
        {
          label: 'Run Test Suite',
          shortcut: 'F5',
          action: () => void handleRunTerminalCommand('npm test'),
        },
        { divider: true },
        { header: 'Runtime Verification' },
        {
          label: 'Restart Extension Host (PoC-L2)',
          shortcut: 'Ctrl+Shift+R',
          action: () => void handleSimulateExtensionHostRestart(),
        },
        {
          label: 'Provider Smoke Test',
          shortcut: '',
          action: () => openSettingsCenter('models'),
        },
      ],
    },
    {
      id: 'terminal',
      label: 'Terminal',
      items: [
        {
          label: 'New / Focus Terminal',
          shortcut: 'Ctrl+`',
          action: () => {
            setShowBottomPanel(true);
            setActiveBottomTab('terminal');
          },
        },
        { divider: true },
        {
          label: 'Run git status',
          shortcut: '',
          action: () => void handleRunTerminalCommand('git status'),
        },
        {
          label: 'Clear Terminal',
          shortcut: '',
          action: () => setTerminalHistory([]),
        },
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        { header: 'User Guide & Manual' },
        {
          label: '📖 DeepAutoCode User Guide (Complete Manual)',
          shortcut: 'F1',
          action: () => openUserGuide('quickstart'),
        },
        {
          label: '🚀 1. Quick Start & Project Setup',
          shortcut: '',
          action: () => openUserGuide('quickstart'),
        },
        {
          label: '🖥️ 2. Workbench Layout & Navigation',
          shortcut: '',
          action: () => openUserGuide('workbench'),
        },
        {
          label: '🤖 3. AI Execution Modes (Plan / Auto / Manual)',
          shortcut: '',
          action: () => openUserGuide('modes'),
        },
        {
          label: '⚡ 4. / Slash Workflows & @ Context Mentions',
          shortcut: '',
          action: () => openUserGuide('workflows'),
        },
        {
          label: '✨ 5. Inline AI (Ctrl+I) & Code Lenses',
          shortcut: '',
          action: () => openUserGuide('inline'),
        },
        {
          label: '📑 6. Artifacts, Subagents & .agents/ Rules',
          shortcut: '',
          action: () => openUserGuide('artifacts'),
        },
        {
          label: '🌐 7. Live Web Preview & Remote SSH',
          shortcut: '',
          action: () => openUserGuide('preview-ssh'),
        },
        {
          label: '⌨️ 8. Keyboard Shortcuts & Troubleshooting',
          shortcut: '',
          action: () => openUserGuide('shortcuts'),
        },
        { divider: true },
        { header: 'Documentation & Diagnostics' },
        {
          label: 'Open User Guide Markdown (docs/USER-GUIDE.md)',
          shortcut: '',
          action: () => void openFileInTab('docs/USER-GUIDE.md', true),
        },
        {
          label: 'Architecture & PoC Documentation',
          shortcut: '',
          action: () => void openFileInTab('docs/ADR-AND-POC-REPORT.md', true),
        },
        {
          label: 'Settings Center',
          shortcut: 'Ctrl+,',
          action: () => openSettingsCenter('general'),
        },
        {
          label: 'Export Security Diagnostics',
          shortcut: '',
          action: () => void handleExportDiagnostics(),
        },
      ],
    },
  ];

  return (
    <div
      className="ide-shell"
      onClick={() => {
        setOpenMenu(null);
        setShowGearPopup(false);
      }}
    >
      {/* 1. Custom Native IDE Titlebar & 8-Item Project Menu Bar */}
      <header className="ide-titlebar">
        <div className="titlebar-left">
          <div className="ide-logo">
            <BrandMark size={20} radius={5} />
            <span>DeepAutoCode</span>
          </div>

          <nav className="menubar" onClick={(e) => e.stopPropagation()}>
            {MENU_DEFINITIONS.map((menu) => (
              <div
                key={menu.id}
                className={`menu-item ${openMenu === menu.id ? 'open' : ''}`}
                onMouseEnter={() => {
                  if (openMenu) setOpenMenu(menu.id);
                }}
                onClick={() => setOpenMenu(openMenu === menu.id ? null : menu.id)}
              >
                {menu.label}
                {openMenu === menu.id && (
                  <div className="menu-dropdown">
                    {menu.items.map((item: any, idx: number) =>
                      item.divider ? (
                        <div key={`div_${idx}`} className="menu-divider" />
                      ) : item.header ? (
                        <div key={`hdr_${idx}`} className="menu-group-header">
                          {item.header}
                        </div>
                      ) : (
                        <div
                          key={item.label}
                          className="menu-dropdown-item"
                          onClick={() => {
                            setOpenMenu(null);
                            item.action();
                          }}
                        >
                          <span>{item.label}</span>
                          {item.shortcut && (
                            <span className="menu-shortcut">{item.shortcut}</span>
                          )}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
          </nav>
        </div>

        {/* Center Command Center Bar */}
        <div className="command-center-bar" onClick={() => setShowPalette(true)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>🔍</span>
            <span>{workspaceName} — Search files or run command</span>
          </span>
          <span className="badge" style={{ fontSize: 10 }}>
            Ctrl+P
          </span>
        </div>

        {/* Right Titlebar Controls: Layout Toggles, Theme Switch, and Settings */}
        <div className="titlebar-right">
          <button
            className="theme-toggle-btn"
            onClick={() => toggleColorTheme()}
            title="Switch between Dark and Light Theme"
          >
            <span>{isLightTheme ? '🌙' : '☀️'}</span>
            <span>{isLightTheme ? 'Dark' : 'Light'}</span>
          </button>
          <div className="titlebar-sep" />
          <button
            className={`icon-btn ${showLeftSidebar ? 'active' : ''}`}
            onClick={() => setShowLeftSidebar((v) => !v)}
            title="Toggle Primary Sidebar (Ctrl+B)"
          >
            ◧
          </button>
          <button
            className={`icon-btn ${showBottomPanel ? 'active' : ''}`}
            onClick={() => setShowBottomPanel((v) => !v)}
            title="Toggle Terminal Panel (Ctrl+J)"
          >
            ◨
          </button>
          <button
            className={`icon-btn ${activeTabPath === 'preview://localhost' ? 'active' : ''}`}
            onClick={() => openWebPreviewTab()}
            title="Open Live Web Preview (http://localhost:3000/)"
          >
            🌐 Preview
          </button>
          <button
            className={`icon-btn ${showRightAiDock ? 'active' : ''}`}
            onClick={() => setShowRightAiDock((v) => !v)}
            title="Toggle AI Agent Dock (Ctrl+L)"
          >
            ✨ AI
          </button>
          <div className="titlebar-sep" />
          <button
            className={`icon-btn ${activeTabPath === 'guide://deepautocode' ? 'active' : ''}`}
            onClick={() => openUserGuide('quickstart')}
            title="Open DeepAutoCode User Guide & Manual (F1)"
          >
            📖 Guide
          </button>
          <button
            className={`icon-btn ${activeTabPath === 'settings://deepautocode' ? 'active' : ''}`}
            onClick={() => openSettingsCenter('general')}
            title="Open DeepAutoCode Settings Center (Ctrl+,)"
          >
            ⚙️ Settings
          </button>
        </div>
      </header>

      {/* 2. Main 4-Pane IDE Workbench Body */}
      <div className="ide-body" style={bodyGridStyle}>
        {/* Pane A: Leftmost Activity Bar (Antigravity Style) */}
        <aside className="activity-bar">
          <div className="activity-top">
            {[
              {
                id: 'explorer',
                title: 'Project Explorer (Ctrl+Shift+E)',
                svg: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                ),
              },
              {
                id: 'search',
                title: 'Search Workspace (Ctrl+Shift+F)',
                svg: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                ),
              },
              {
                id: 'git',
                title: 'Source Control / Git (Ctrl+Shift+G)',
                svg: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="18" r="3" />
                    <circle cx="6" cy="6" r="3" />
                    <path d="M6 21V9a9 9 0 009 9" />
                  </svg>
                ),
              },
              {
                id: 'extensions',
                title: 'Open VSX Extensions & VSIX (Ctrl+Shift+X)',
                svg: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" rx="1.2" />
                    <rect x="14" y="3" width="7" height="7" rx="1.2" />
                    <rect x="14" y="14" width="7" height="7" rx="1.2" />
                    <rect x="3" y="14" width="7" height="7" rx="1.2" />
                  </svg>
                ),
              },
            ].map((item) => (
              <div
                key={item.id}
                className={`activity-icon ${
                  showLeftSidebar && activeActivity === item.id ? 'active' : ''
                }`}
                title={item.title}
                onClick={() => {
                  if (activeActivity === item.id && showLeftSidebar) {
                    setShowLeftSidebar(false);
                  } else {
                    setActiveActivity(item.id as any);
                    setShowLeftSidebar(true);
                  }
                }}
              >
                {item.svg}
                {item.id === 'git' && gitState.changes.length > 0 && (
                  <span className="ag-activity-badge">{gitState.changes.length}</span>
                )}
              </div>
            ))}
          </div>

          {/* Bottom-Left Settings Gear with Popup Menu (Antigravity style) */}
          <div className="activity-bottom" onClick={(e) => e.stopPropagation()}>
            <div
              className="activity-icon"
              title="Export Redacted Security Diagnostics"
              onClick={() => void handleExportDiagnostics()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div
              className={`activity-icon ${
                activeTabPath === 'settings://deepautocode' ? 'active' : ''
              }`}
              title="Settings & Customizations (Ctrl+,)"
              onClick={() => setShowGearPopup((v) => !v)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
              {showGearPopup && (
                <div
                  className="menu-dropdown"
                  style={{ bottom: 8, top: 'auto', left: 48, minWidth: 240 }}
                >
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      toggleColorTheme();
                    }}
                  >
                    <span>{isLightTheme ? '🌙 Switch to Dark Theme' : '☀️ Switch to Light Theme'}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Theme</span>
                  </div>
                  <div className="menu-divider" />
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('general');
                    }}
                  >
                    <span>⚙️ IDE & Project Settings</span>
                    <span style={{ fontSize: 11, color: '#8b949e' }}>Ctrl+,</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('models');
                    }}
                  >
                    <span>🤖 AI Models & Providers</span>
                    <span style={{ fontSize: 11, color: '#8b949e' }}>Ctrl+Shift+J</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('security');
                    }}
                  >
                    <span>🛡️ Security & Approval Policies</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('rules');
                    }}
                  >
                    <span>📜 Rules for AI (.deepautocode)</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('mcp');
                    }}
                  >
                    <span>🔌 MCP Servers & Capabilities</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('runtime');
                    }}
                  >
                    <span>⚡ Cline SDK Runtime (local/auto/hub)</span>
                  </div>
                  <div className="menu-divider" />
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('extensions');
                    }}
                  >
                    <span>🧩 Extensions & VSIX Marketplace</span>
                    <span style={{ fontSize: 11, color: '#8b949e' }}>Ctrl+Shift+X</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      setShowPalette(true);
                    }}
                  >
                    <span>⌨️ Command Palette...</span>
                    <span style={{ fontSize: 11, color: '#8b949e' }}>Ctrl+Shift+P</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* Pane B: Primary Left Sidebar (Antigravity Explorer) */}
        <aside className="primary-sidebar" style={{ display: showLeftSidebar ? 'flex' : 'none' }}>
          {activeActivity === 'explorer' && (
            <>
              <div className="sidebar-header ag-sidebar-titlebar">
                <span>EXPLORER</span>
                <button
                  className="ag-header-action"
                  title="Open / Switch Workspace Folder..."
                  onClick={() => void handleOpenProjectAction()}
                >
                  Switch Folder
                </button>
              </div>

              {/* Antigravity Collapsible Workspace Section */}
              <div className="ag-workspace-section">
                <div
                  className="ag-workspace-header"
                  onClick={() => setWorkspaceSectionOpen((v) => !v)}
                  title={workspaceRoot || 'Click to toggle workspace tree'}
                >
                  <div className="ag-workspace-title">
                    <span className="ag-tree-chevron">
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                        {workspaceSectionOpen ? (
                          <path d="M3.2 5.5L8 10.3l4.8-4.8.9.9L8 12.1 2.3 6.4l.9-.9z" />
                        ) : (
                          <path d="M5.5 3.2L10.3 8l-4.8 4.8.9.9L12.1 8 6.4 2.3l-.9.9z" />
                        )}
                      </svg>
                    </span>
                    <span className="ag-workspace-name">
                      {(workspaceName || 'WORKSPACE').toUpperCase()}
                    </span>
                  </div>
                  <div
                    className="ag-workspace-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="ag-icon-action"
                      title="Go to Parent Directory (..)"
                      onClick={() => void handleNavigateToParentDirectory()}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 2.5l5 5-.7.7L8.5 4.4V14h-1V4.4L3.7 8.2 3 7.5l5-5z" />
                      </svg>
                    </button>
                    <button
                      className="ag-icon-action"
                      title="New File..."
                      onClick={() => {
                        setCreateTargetName('new-file.ts');
                        setShowCreateModal('file');
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M9.5 1.1l3.4 3.5.1.4v2h-1V6H8V2H3v11h4v1H2.5l-.5-.5v-12l.5-.5h6.7l.3.1zM9 2v3h2.9L9 2zm4 14h-1v-3H9v-1h3V9h1v3h3v1h-3v3z" />
                      </svg>
                    </button>
                    <button
                      className="ag-icon-action"
                      title="New Folder..."
                      onClick={() => {
                        setCreateTargetName('new-folder');
                        setShowCreateModal('directory');
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M14.5 2H7.71l-.85-.85L6.51 1h-5l-.5.5v11l.5.5H7v-1H1.99V6h4.49l.35-.15.86-.86H14v1.5l-.001.51h1.011V2.5L14.5 2zm-.51 2h-6.5l-.35.15-.86.86H2v-3h4.29l.85.85.36.15H14l-.01.99zM13 16h-1v-3H9v-1h3V9h1v3h3v1h-3v3z" />
                      </svg>
                    </button>
                    <button
                      className="ag-icon-action"
                      title="Refresh Explorer"
                      onClick={() => void refreshWorkspaceTree()}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c-.335.415-.927 1.341-1.124 2.876l-.021.165.033.163.071.345c0 1.654-1.346 3-3 3-.795 0-1.545-.311-2.107-.868-.563-.557-.873-1.302-.873-2.094 0-1.63 1.308-2.961 2.931-2.999v2.097l3.528-2.647-3.528-2.646v2.096c-2.228.039-4.031 1.86-4.031 4.099 0 1.087.425 2.11 1.197 2.875.772.765 1.801 1.192 2.893 1.192 2.26 0 4.099-1.84 4.099-4.1l-.072-.348c.148-1.088.532-1.766.819-2.129l.908-.69z" />
                      </svg>
                    </button>
                    <button
                      className="ag-icon-action"
                      title="Collapse Folders in Explorer"
                      onClick={() => setExpandedDirs({})}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M9 9H4v1h5V9zM6 6h5v1H6V6z" />
                        <path d="M14 1H3L2 2v11l1 1h11l1-1V2l-1-1zm0 12H3V2h11v11z" />
                      </svg>
                    </button>
                  </div>
                </div>
                {workspaceRoot && (
                  <div
                    className="ag-workspace-path-pill"
                    title={
                      sshStatus?.connected && sshStatus.activeProfile
                        ? `${sshStatus.activeProfile.username}@${sshStatus.activeProfile.host}:${sshStatus.activeProfile.remotePath}`
                        : workspaceRoot
                    }
                  >
                    <span>
                      {sshStatus?.connected && sshStatus.activeProfile
                        ? `🌐 ${sshStatus.activeProfile.username}@${sshStatus.activeProfile.host}:${sshStatus.activeProfile.remotePath}`
                        : workspaceRoot}
                    </span>
                  </div>
                )}
              </div>

              <div className="sidebar-scroll ag-tree-container">
                {workspaceRoot ? (
                  workspaceSectionOpen ? (
                    <>
                      <div
                        className="ag-tree-row parent-dir-row"
                        style={{ paddingLeft: 10 }}
                        title="Click to go to parent directory"
                        onClick={() => void handleNavigateToParentDirectory()}
                      >
                        <span className="ag-folder-icon" style={{ color: '#60a5fa' }}>
                          ⬆
                        </span>
                        <span className="ag-tree-label folder">.. (Parent Directory)</span>
                      </div>
                      {renderTreeNodes(fileTree)}
                    </>
                  ) : null
                ) : (
                  <div
                    style={{
                      padding: '24px 14px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      color: 'var(--text-secondary)',
                      fontSize: 12,
                    }}
                  >
                    <div>You have not yet opened a folder.</div>
                    <button
                      className="btn primary"
                      style={{ width: '100%', justifyContent: 'center', padding: '7px 12px' }}
                      onClick={() => void handleOpenProjectAction()}
                    >
                      📂 Open Folder
                    </button>
                    <button
                      className="btn"
                      style={{ width: '100%', justifyContent: 'center', padding: '7px 12px' }}
                      onClick={() => void openSshConnectionModal()}
                    >
                      🌐 Connect to SSH Host...
                    </button>
                    {(ideSettings.recentWorkspaces ?? []).length > 0 && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.8 }}>
                          RECENT FOLDERS
                        </div>
                        {(ideSettings.recentWorkspaces ?? []).slice(0, 5).map((ws: string) => (
                          <div
                            key={ws}
                            className="tree-row"
                            style={{ padding: '4px 6px', borderRadius: 4 }}
                            onClick={() => void switchProjectFolder(ws)}
                            title={ws}
                          >
                            <span style={{ color: '#60a5fa' }}>📁</span>
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {ws.split(/[\\/]/).pop() || ws}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {activeActivity === 'search' && (
            <>
              <div className="sidebar-header">
                <span>Search in Project</span>
              </div>
              <div style={{ padding: 10 }}>
                <input
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    color: 'var(--text-primary)',
                  }}
                  placeholder="Search text across workspace files..."
                  value={searchQuery}
                  onChange={(e) => void handleWorkspaceSearch(e.target.value)}
                />
              </div>
              <div className="sidebar-scroll">
                {searchResults.map((m, idx) => (
                  <div
                    key={`${m.file}:${m.line}:${idx}`}
                    className="tree-row"
                    style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
                    onClick={() => void openFileInTab(m.file)}
                  >
                    <div style={{ fontSize: 11.5, color: '#60a5fa', fontWeight: 600 }}>
                      {m.file}:{m.line}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: '#8b949e',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {m.preview}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {activeActivity === 'git' && (
            <>
              <div className="sidebar-header">
                <span>Source Control (Git)</span>
                <span className="badge">{gitState.branch}</span>
              </div>
              <div className="sidebar-scroll" style={{ padding: 8 }}>
                <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 8 }}>
                  Working Tree Changes ({gitState.changes.length})
                </div>
                {gitState.changes.map((c) => (
                  <div
                    key={c.file}
                    className="tree-row"
                    onClick={() => void openFileInTab(c.file)}
                    style={{ justifyContent: 'space-between' }}
                  >
                    <span>{c.file}</span>
                    <span className="badge warning">{c.status}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {activeActivity === 'extensions' && (
            <>
              <div className="sidebar-header">
                <span>Open VSX Marketplace</span>
                <button
                  className="btn"
                  style={{ padding: '2px 6px', fontSize: 10.5 }}
                  onClick={() => openSettingsCenter('extensions')}
                >
                  Full View
                </button>
              </div>
              <div className="sidebar-scroll" style={{ padding: 8 }}>
                {(extensionsCatalog?.extensions ?? []).map((ext: any) => (
                  <div
                    key={ext.id}
                    style={{
                      padding: 8,
                      borderBottom: '1px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <strong style={{ fontSize: 12 }}>{ext.displayName}</strong>
                      <span
                        className={`badge ${ext.openVsxAvailable ? 'success' : 'warning'}`}
                      >
                        {ext.openVsxAvailable ? 'Open VSX' : 'Restricted'}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#8b949e' }}>{ext.id}</div>
                    {ext.openVsxAvailable && (
                      <button
                        className={`btn ${ext.installed ? '' : 'primary'}`}
                        onClick={async () => {
                          await fetch('/api/extensions/install-openvsx', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ extensionId: ext.id }),
                          });
                          const updated = await fetch('/api/extensions').then((r) => r.json());
                          setExtensionsCatalog(updated);
                          setStatusNotice(`Installed ${ext.id}`);
                        }}
                      >
                        {ext.installed ? 'Installed ✓' : 'Install'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>

        {/* Resizable Sash between Left Sidebar and Center Editor */}
        <div
          className={`resizer-col ${draggingSash === 'left' ? 'dragging' : ''}`}
          style={{ display: showLeftSidebar ? 'block' : 'none' }}
          title="Drag to resize Primary Sidebar"
          onMouseDown={(e) => startPaneResize('left', e)}
        />

        {/* Pane C: Center Multi-Tab Editor (Code / Diff / Full-Tab Settings Center) + Bottom Panel */}
        <main className="center-workbench" style={centerGridStyle}>
          <div className="editor-area">
            {/* Multi-Tab Editor Bar (Antigravity Style) — hidden on empty startup welcome screen */}
            {tabs.length > 0 && (
            <div className="editor-tabs-bar">
              <div className="editor-tabs-list">
                {tabs.map((tab) => {
                  const isDirty = tab.kind === 'code' && tab.content !== tab.savedContent;
                  const meta = getFileVisualMeta(tab.path);
                  const pathParts = tab.path.replace(/\\/g, '/').split('/');
                  const parentDir =
                    pathParts.length > 1 ? pathParts[pathParts.length - 2] : '';

                  return (
                    <div
                      key={tab.path}
                      className={`editor-tab ${tab.path === activeTabPath ? 'active' : ''}`}
                      onClick={() => setActiveTabPath(tab.path)}
                      title={tab.path}
                    >
                      {tab.kind === 'settings' ? (
                        <BrandMark size={14} radius={3} />
                      ) : tab.kind === 'diff' ? (
                        <span className="ag-file-icon" style={{ color: '#f59e0b' }}>
                          ⇄
                        </span>
                      ) : (
                        <span
                          className="ag-file-icon"
                          style={{
                            color: meta.color,
                            borderColor: `${meta.color}40`,
                            background: `${meta.color}16`,
                          }}
                        >
                          {meta.badge}
                        </span>
                      )}
                      <span className="ag-tab-name">{tab.name}</span>
                      {parentDir && tab.kind === 'code' && (
                        <span className="ag-tab-dir">{parentDir}</span>
                      )}
                      {isDirty ? (
                        <span className="ag-tab-dirty" title="Unsaved modifications">
                          ●
                        </span>
                      ) : null}
                      <span
                        className="tab-close"
                        title="Close Tab"
                        onClick={(e) => closeTab(tab.path, e)}
                      >
                        ✕
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="ag-editor-toolbar">
                {activeTab?.kind === 'code' && (
                  <>
                    <button
                      className="ag-toolbar-btn"
                      title="Antigravity Inline AI Command (Ctrl+I)"
                      onClick={() => setShowInlineCommand((v) => !v)}
                    >
                      ✨ Inline Edit (Ctrl+I)
                    </button>
                    <button
                      className="ag-toolbar-btn"
                      title="Open Live Web Preview (http://localhost:3000/)"
                      onClick={() => openWebPreviewTab()}
                    >
                      🌐 Preview
                    </button>
                    <button
                      className="ag-toolbar-btn"
                      title="Toggle Minimap"
                      onClick={() =>
                        void persistIdeSettings({
                          ...ideSettings,
                          editor: {
                            ...ideSettings.editor,
                            minimap: ideSettings.editor?.minimap === false,
                          },
                        })
                      }
                    >
                      Minimap
                    </button>
                    <button
                      className="btn primary"
                      style={{ padding: '3px 10px', fontSize: 11 }}
                      onClick={() => void saveCurrentTab()}
                    >
                      Save (Ctrl+S)
                    </button>
                  </>
                )}
              </div>
            </div>
            )}

            {/* Breadcrumbs / Diff Action Bar (Antigravity Style) — hidden on empty startup welcome screen */}
            {tabs.length > 0 && (
            <div className="breadcrumbs-bar">
              <div className="ag-breadcrumbs-trail">
                <span className="ag-crumb root">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.75 }}>
                    <path d="M1.5 3A1.5 1.5 0 013 1.5h3.293a1.5 1.5 0 011.06.44l1.122 1.12a.5.5 0 00.353.14H13A1.5 1.5 0 0114.5 4.7v7.8A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z" />
                  </svg>
                  {workspaceName}
                </span>
                {activeTab &&
                  activeTab.path
                    .replace(/\\/g, '/')
                    .split('/')
                    .filter(Boolean)
                    .map((seg, i, arr) => {
                      const isLast = i === arr.length - 1;
                      const meta = isLast ? getFileVisualMeta(seg) : null;
                      return (
                        <React.Fragment key={i}>
                          <span className="ag-crumb-sep">›</span>
                          <span className={`ag-crumb ${isLast ? 'active' : ''}`}>
                            {isLast && meta && (activeTab.kind === 'code' || activeTab.kind === 'image') && (
                              <span
                                className="ag-file-icon"
                                style={{
                                  color: meta.color,
                                  borderColor: `${meta.color}40`,
                                  background: `${meta.color}16`,
                                  transform: 'scale(0.9)',
                                }}
                              >
                                {meta.badge}
                              </span>
                            )}
                            {seg}
                          </span>
                        </React.Fragment>
                      );
                    })}
              </div>
              {activeTab?.kind === 'code' && (
                <div className="ag-editor-meta-pills">
                  <span className="ag-meta-pill">
                    {getFileVisualMeta(activeTab.path).language}
                  </span>
                  <span className="ag-meta-pill">UTF-8</span>
                  <span className="ag-meta-pill">
                    Ln {cursorPos.line}, Col {cursorPos.col}
                  </span>
                  <span className="ag-meta-pill">{codeLines.length} lines</span>
                </div>
              )}
              {activeTab?.kind === 'image' && (
                <div className="ag-editor-meta-pills">
                  <span className="ag-meta-pill">
                    {getFileVisualMeta(activeTab.path).language}
                  </span>
                  {imageDimensions && (
                    <span className="ag-meta-pill">
                      {imageDimensions.width} × {imageDimensions.height} px
                    </span>
                  )}
                  <span className="ag-meta-pill">Zoom: {Math.round(imageZoom * 100)}%</span>
                </div>
              )}
              {activeTab?.kind === 'diff' && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      gap: 2,
                      background: 'var(--bg-input)',
                      padding: '2px 4px',
                      borderRadius: 4,
                      border: '1px solid var(--border)',
                    }}
                  >
                    <button
                      type="button"
                      className={`btn ${diffViewMode === 'split' ? 'primary' : ''}`}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => setDiffViewMode('split')}
                      title="Side-by-Side Split Diff View (Antigravity style)"
                    >
                      ◫ Split
                    </button>
                    <button
                      type="button"
                      className={`btn ${diffViewMode === 'unified' ? 'primary' : ''}`}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => setDiffViewMode('unified')}
                      title="Inline Unified Diff View"
                    >
                      ☰ Unified
                    </button>
                  </div>
                  {activeTab.diffRecord && (
                    <>
                      <span
                        className={`badge ${
                          activeTab.diffRecord.status === 'accepted'
                            ? 'success'
                            : activeTab.diffRecord.status === 'rejected'
                              ? 'danger'
                              : 'warning'
                        }`}
                      >
                        {String(activeTab.diffRecord.status || 'pending').toUpperCase()}
                      </span>
                      <button
                        className="btn success"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() =>
                          void handleDiffReview(
                            activeTab.diffRecord.diffId,
                            'accept',
                            activeTab.diffRecord.sessionId
                          )
                        }
                      >
                        ✓ Accept Change
                      </button>
                      <button
                        className="btn danger"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() =>
                          void handleDiffReview(
                            activeTab.diffRecord.diffId,
                            'reject',
                            activeTab.diffRecord.sessionId
                          )
                        }
                      >
                        ✕ Reject & Revert
                      </button>
                      <button
                        className="btn"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() =>
                          void handleDiffReview(
                            activeTab.diffRecord.diffId,
                            'revise',
                            activeTab.diffRecord.sessionId
                          )
                        }
                      >
                        ↺ Ask Agent to Revise
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            )}

            {/* Center Surface: User Guide OR Settings Center OR Diff Viewer OR Code Editor */}
            {activeTab?.kind === 'guide' ? (
              <div
                className="settings-center-layout"
                style={{ gridTemplateColumns: `${settingsNavWidth}px 5px 1fr` }}
              >
                {/* Left Guide Navigation Rail */}
                <aside className="settings-nav">
                  <div
                    className="settings-nav-title"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <BrandMark size={16} radius={4} />
                      <span style={{ fontWeight: 700 }}>DeepAutoCode Guide</span>
                    </div>
                  </div>

                  <div style={{ padding: '4px 8px 10px 8px', display: 'flex', gap: 6 }}>
                    <button
                      className={`btn ${guideLang === 'zh' ? 'primary' : ''}`}
                      style={{ flex: 1, padding: '3px 6px', fontSize: 11 }}
                      onClick={() => setGuideLang('zh')}
                    >
                      🇨🇳 中文说明
                    </button>
                    <button
                      className={`btn ${guideLang === 'en' ? 'primary' : ''}`}
                      style={{ flex: 1, padding: '3px 6px', fontSize: 11 }}
                      onClick={() => setGuideLang('en')}
                    >
                      🇺🇸 English
                    </button>
                  </div>

                  {[
                    { id: 'quickstart', icon: '🚀', label: guideLang === 'zh' ? '1. 快速上手配置' : '1. Quick Start' },
                    { id: 'workbench', icon: '🖥️', label: guideLang === 'zh' ? '2. 工作台与布局' : '2. Workbench Layout' },
                    { id: 'modes', icon: '🤖', label: guideLang === 'zh' ? '3. 三种 AI 模式' : '3. AI Execution Modes' },
                    { id: 'workflows', icon: '⚡', label: guideLang === 'zh' ? '4. 斜杠 / 与引用 @' : '4. / Slash & @ Mentions' },
                    { id: 'inline', icon: '✨', label: guideLang === 'zh' ? '5. 行内 AI (Ctrl+I)' : '5. Inline AI & CodeLens' },
                    { id: 'artifacts', icon: '📑', label: guideLang === 'zh' ? '6. 制品与 .agents' : '6. Artifacts & .agents' },
                    { id: 'preview-ssh', icon: '🌐', label: guideLang === 'zh' ? '7. 网页预览与 SSH' : '7. Web Preview & SSH' },
                    { id: 'shortcuts', icon: '⌨️', label: guideLang === 'zh' ? '8. 快捷键速查表' : '8. Shortcuts & Cheat Sheet' },
                  ].map((nav) => (
                    <div
                      key={nav.id}
                      className={`settings-nav-item ${guideSection === nav.id ? 'active' : ''}`}
                      onClick={() => setGuideSection(nav.id as GuideSectionId)}
                    >
                      <span>{nav.icon}</span>
                      <span>{nav.label}</span>
                    </div>
                  ))}

                  <div style={{ marginTop: 'auto', padding: '12px 8px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <button
                      className="btn"
                      style={{ width: '100%', fontSize: 11, padding: '4px 8px' }}
                      onClick={() => void openFileInTab('docs/USER-GUIDE.md', true)}
                    >
                      📄 查看 USER-GUIDE.md
                    </button>
                    <button
                      className="btn"
                      style={{ width: '100%', fontSize: 11, padding: '4px 8px' }}
                      onClick={() => openSettingsCenter('general')}
                    >
                      ⚙️ 打开设置中心 (Ctrl+,)
                    </button>
                  </div>
                </aside>

                {/* Resizable Sash inside Guide Center */}
                <div
                  className={`resizer-col ${draggingSash === 'settings' ? 'dragging' : ''}`}
                  title="Drag to resize Guide navigation"
                  onMouseDown={(e) => startPaneResize('settings', e)}
                />

                {/* Right Guide Content Pane */}
                <div className="settings-content" style={{ overflowY: 'auto', padding: '24px 32px' }}>
                  {/* Section 1: Quick Start */}
                  {guideSection === 'quickstart' && (
                    <div>
                      <div className="settings-section-title">
                        {guideLang === 'zh' ? '🚀 1. 快速上手与项目打开 (Quick Start)' : '🚀 1. Quick Start & Project Setup'}
                      </div>
                      <div className="settings-section-desc">
                        {guideLang === 'zh'
                          ? 'DeepAutoCode 深度对齐 Google Antigravity 交互规范。首次启动时保持极简欢迎界面，无需预载冗余代码；支持一键打开本地项目或远程 SSH 服务器。'
                          : 'DeepAutoCode is fully aligned with Google Antigravity specifications. Clean startup screen by default; open local folders or remote SSH servers in one click.'}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {guideLang === 'zh' ? '步骤 1：打开工作区项目' : 'Step 1: Open a Project Workspace'}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {guideLang === 'zh'
                            ? '点击顶部菜单 File -> Open Folder (Ctrl+O) 打开本地工程，或者点击 Connect via SSH (Ctrl+Alt+O) 直连远程 Linux 开发机。'
                            : 'Click File -> Open Folder (Ctrl+O) to open a local repository, or click Connect via SSH (Ctrl+Alt+O) for remote Linux development.'}
                        </p>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button className="btn primary" onClick={() => void handleOpenProjectAction()}>
                            📂 {guideLang === 'zh' ? '打开本地项目文件夹 (Ctrl+O)' : 'Open Local Folder (Ctrl+O)'}
                          </button>
                          <button className="btn" onClick={() => void openSshConnectionModal()}>
                            🌐 {guideLang === 'zh' ? '连接远程 SSH 主机 (Ctrl+Alt+O)' : 'Connect via SSH (Ctrl+Alt+O)'}
                          </button>
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {guideLang === 'zh' ? '步骤 2：配置 AI 模型与 API 密钥' : 'Step 2: Configure AI Model & API Key'}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {guideLang === 'zh'
                            ? 'DeepAutoCode 开箱即用支持 DeepSeek (deepseek-chat / deepseek-reasoner)，并原生兼容 OpenAI 接口（如 Ollama、vLLM、企业中转网关）以及 Anthropic Claude。所有密钥严格存放于系统凭据管理器 (SecretStorage)，杜绝明文泄露。'
                            : 'DeepAutoCode supports DeepSeek out of the box, with full OpenAI-Compatible (Ollama, vLLM, Gateway) and Anthropic Claude compatibility. API keys are safely stored in OS SecretStorage.'}
                        </p>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button className="btn primary" onClick={() => openSettingsCenter('models')}>
                            🤖 {guideLang === 'zh' ? '配置 AI 模型与 Provider (Ctrl+Shift+J)' : 'Configure AI Models (Ctrl+Shift+J)'}
                          </button>
                          <button className="btn" onClick={() => void handleTestAiKey()}>
                            ⚡ {guideLang === 'zh' ? '测试当前 AI 连通性' : 'Test AI Connectivity'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Section 2: Workbench Layout */}
                  {guideSection === 'workbench' && (
                    <div>
                      <div className="settings-section-title">
                        {guideLang === 'zh' ? '🖥️ 2. 工作台布局与四大工作区 (Workbench Layout)' : '🖥️ 2. Workbench Layout & Navigation'}
                      </div>
                      <div className="settings-section-desc">
                        {guideLang === 'zh'
                          ? 'DeepAutoCode 采用标准的 Antigravity / Cursor 四面板弹性网格布局，支持自由拖拽调节尺寸与快捷键随时唤出/隐藏。'
                          : 'Standard Antigravity / Cursor 4-pane resizable grid layout with full keyboard shortcuts and collapsible panels.'}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10, fontSize: 14 }}>
                          {guideLang === 'zh' ? '四大核心面板功能与快捷键' : 'Core Panes & Keyboard Shortcuts'}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13 }}>◧ {guideLang === 'zh' ? '左侧主侧边栏 (Primary Sidebar)' : 'Primary Sidebar'}</strong>
                              <kbd className="welcome-kbd">Ctrl+B</kbd>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                              {guideLang === 'zh'
                                ? '包含文件管理器 (Explorer)、全局代码搜索 (Search)、Git 源代码管理、Open VSX 扩展市场。'
                                : 'Includes Project Explorer, Global Search, Git Source Control, and Open VSX Extensions.'}
                            </div>
                            <button className="btn" style={{ marginTop: 8, padding: '3px 8px', fontSize: 11 }} onClick={() => setShowLeftSidebar((v) => !v)}>
                              {guideLang === 'zh' ? '切换左侧栏显示' : 'Toggle Left Sidebar'}
                            </button>
                          </div>

                          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13 }}>◨ {guideLang === 'zh' ? '底部面板 (Bottom Panel)' : 'Bottom Panel'}</strong>
                              <kbd className="welcome-kbd">Ctrl+J</kbd>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                              {guideLang === 'zh'
                                ? '内置集成终端 (Terminal)、代码语法与编译问题 (Problems)、高危命令审计日志 (Audit)、Extension Host 运行时输出。'
                                : 'Integrated Terminal, Problems, Security Audit Logs, and Extension Host Runtime Output.'}
                            </div>
                            <button className="btn" style={{ marginTop: 8, padding: '3px 8px', fontSize: 11 }} onClick={() => setShowBottomPanel((v) => !v)}>
                              {guideLang === 'zh' ? '切换底部面板显示' : 'Toggle Bottom Panel'}
                            </button>
                          </div>

                          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13 }}>✨ {guideLang === 'zh' ? '右侧 AI Agent 面板' : 'AI Agent Dock'}</strong>
                              <kbd className="welcome-kbd">Ctrl+L</kbd>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                              {guideLang === 'zh'
                                ? '多轮对话 Composer、结构化制品 (Artifacts)、历史会话切换、审批卡片、执行模式切换。'
                                : 'AI Composer, Structured Artifacts, Session History, Human-in-the-Loop Approvals, and Execution Modes.'}
                            </div>
                            <button className="btn primary" style={{ marginTop: 8, padding: '3px 8px', fontSize: 11 }} onClick={() => setShowRightAiDock((v) => !v)}>
                              {guideLang === 'zh' ? '切换右侧 AI 栏显示' : 'Toggle AI Dock'}
                            </button>
                          </div>

                          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13 }}>🌐 {guideLang === 'zh' ? '内置 Web 实时预览' : 'Live Web Preview'}</strong>
                              <span className="badge success">Preview</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                              {guideLang === 'zh'
                                ? '在主编辑区一键打开本地项目（如 http://localhost:3000/）内嵌预览，支持网页交互与 AI 审查。'
                                : 'Preview local web apps (e.g. http://localhost:3000/) directly in an editor tab with AI inspection.'}
                            </div>
                            <button className="btn" style={{ marginTop: 8, padding: '3px 8px', fontSize: 11 }} onClick={() => openWebPreviewTab()}>
                              {guideLang === 'zh' ? '打开 Web 预览标签页' : 'Open Web Preview'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Section 3: AI Modes */}
                  {guideSection === 'modes' && (
                    <div>
                      <div className="settings-section-title">
                        {guideLang === 'zh' ? '🤖 3. 三大 AI 执行模式与安全边界 (AI Execution Modes)' : '🤖 3. Three AI Execution Modes & Security'}
                      </div>
                      <div className="settings-section-desc">
                        {guideLang === 'zh'
                          ? 'DeepAutoCode 严格遵循 ADR-008 安全架构，提供基于角色的三级执行权限，确保代码生成的安全与可控。'
                          : 'DeepAutoCode strictly enforces ADR-008 security architecture, providing 3 distinct execution permission tiers.'}
                      </div>

                      <div className="settings-card">
                        <div className="settings-row" style={{ alignItems: 'flex-start', paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span className="badge success" style={{ fontSize: 11 }}>∞ Agent (Auto)</span>
                              <strong style={{ fontSize: 13.5 }}>{guideLang === 'zh' ? '自动执行模式 (默认推荐)' : 'Auto Mode (Default)'}</strong>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {guideLang === 'zh'
                                ? 'AI 可自主执行只读探查、文件修改，并免审运行安全白名单命令（如 git status、git diff、npm test、npm run build 等）。对于高危终端命令或工作区外写入，依然会弹出人工审批卡片。'
                                : 'AI autonomously explores, writes files, and executes allowlisted safe commands (git status, npm test, etc.). High-risk commands still require explicit approval.'}
                            </div>
                          </div>
                          <button
                            className={`btn ${executionMode === 'auto' ? 'primary' : ''}`}
                            onClick={() => {
                              setExecutionMode('auto');
                              setStatusNotice('Switched Execution Mode -> Auto (Agent)');
                            }}
                          >
                            {executionMode === 'auto' ? '✓ ' + (guideLang === 'zh' ? '当前模式' : 'Active') : guideLang === 'zh' ? '设为自动模式' : 'Select Auto'}
                          </button>
                        </div>

                        <div className="settings-row" style={{ alignItems: 'flex-start', padding: '16px 0', borderBottom: '1px solid var(--border)' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span className="badge info" style={{ fontSize: 11 }}>📖 Plan (Read-Only)</span>
                              <strong style={{ fontSize: 13.5 }}>{guideLang === 'zh' ? '规划模式 (严格只读)' : 'Plan Mode (Strictly Read-Only)'}</strong>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {guideLang === 'zh'
                                ? '只允许读取文件、扫描目录、生成结构化 Artifact 实施计划与派发只读子智能体 (invoke_subagent)。阻断任何源代码修改与终端命令，适合大型项目架构设计与安全审计。'
                                : 'Strictly read-only. Allows file reading, write_artifact planning, and invoke_subagent research. Blocks all code mutations until you approve.'}
                            </div>
                          </div>
                          <button
                            className={`btn ${executionMode === 'plan' ? 'primary' : ''}`}
                            onClick={() => {
                              setExecutionMode('plan');
                              setStatusNotice('Switched Execution Mode -> Plan (Read-Only)');
                            }}
                          >
                            {executionMode === 'plan' ? '✓ ' + (guideLang === 'zh' ? '当前模式' : 'Active') : guideLang === 'zh' ? '设为规划模式' : 'Select Plan'}
                          </button>
                        </div>

                        <div className="settings-row" style={{ alignItems: 'flex-start', paddingTop: 16 }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span className="badge warning" style={{ fontSize: 11 }}>🛡️ Manual</span>
                              <strong style={{ fontSize: 13.5 }}>{guideLang === 'zh' ? '手动审批模式 (最高防护)' : 'Manual Mode (Strict Approval)'}</strong>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {guideLang === 'zh'
                                ? 'AI 执行的每一项文件写入、代码修改或终端命令都必须经过用户在界面上点击 Approve 确认后方可执行。'
                                : 'Every single file mutation or shell command requires your explicit approval via the interactive approval card.'}
                            </div>
                          </div>
                          <button
                            className={`btn ${executionMode === 'manual' ? 'primary' : ''}`}
                            onClick={() => {
                              setExecutionMode('manual');
                              setStatusNotice('Switched Execution Mode -> Manual');
                            }}
                          >
                            {executionMode === 'manual' ? '✓ ' + (guideLang === 'zh' ? '当前模式' : 'Active') : guideLang === 'zh' ? '设为手动模式' : 'Select Manual'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Section 4: Slash & Mentions */}
                  {guideSection === 'workflows' && (
                    <div>
                      <div className="settings-section-title">
                        {guideLang === 'zh' ? '⚡ 4. 斜杠 / 工作流与 @ 上下文引用 (/ Slash & @ Mentions)' : '⚡ 4. / Slash Workflows & @ Context Mentions'}
                      </div>
                      <div className="settings-section-desc">
                        {guideLang === 'zh'
                          ? 'DeepAutoCode 内置了 Antigravity 2.0 的交互式 Slash 命令与 @ 上下文引用系统，在 AI Composer 输入框中键入即可自动弹出候选菜单。'
                          : 'DeepAutoCode features Antigravity 2.0 interactive slash workflows and context mentions. Type / or @ in the AI Composer to trigger.'}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10, fontSize: 14 }}>
                          {guideLang === 'zh' ? '常用斜杠工作流命令 (/ Slash Workflows)' : 'Built-in Slash Workflows'}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
                          {[
                            { cmd: '/plan', title: guideLang === 'zh' ? '架构与实施规划' : 'Architectural Plan', desc: guideLang === 'zh' ? '生成结构化实施计划 Artifact，不改动源码' : 'Generate structured implementation plan without editing files' },
                            { cmd: '/goal', title: guideLang === 'zh' ? '长程自主执行' : 'Autonomous Goal', desc: guideLang === 'zh' ? '自主推进代码落地、自动编译并修复错误直至验证完成' : 'End-to-end execution: code, build, test, and self-heal errors' },
                            { cmd: '/fix', title: guideLang === 'zh' ? '排查并修复错误' : 'Bug & Error Fix', desc: guideLang === 'zh' ? '分析错误根因，应用最小可控修复方案并重新验证' : 'Diagnose compiler/test errors, apply minimal fix, re-verify' },
                            { cmd: '/review', title: guideLang === 'zh' ? '代码与安全审查' : 'Code & Security Review', desc: guideLang === 'zh' ? '审查安全、性能与代码质量，给出文件与行号建议' : 'Review security, performance, and defects with file:line tags' },
                            { cmd: '/test', title: guideLang === 'zh' ? '生成与运行测试' : 'Generate & Run Tests', desc: guideLang === 'zh' ? '为当前模块编写单元/集成测试并执行测试套件' : 'Write unit/integration tests and run the test suite' },
                            { cmd: '/learn', title: guideLang === 'zh' ? '沉淀项目规则' : 'Persist AI Rules', desc: guideLang === 'zh' ? '将成功经验或架构约束沉淀到 .agents/rules/*.md' : 'Persist project conventions into .agents/rules/*.md' },
                            { cmd: '/compact', title: guideLang === 'zh' ? '压缩会话上下文' : 'Compact Context', desc: guideLang === 'zh' ? '提炼长会话关键状态，释放上下文窗口空间' : 'Summarize history into a checkpoint to free context window' },
                          ].map((item) => (
                            <div
                              key={item.cmd}
                              style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)', cursor: 'pointer' }}
                              onClick={() => {
                                setShowRightAiDock(true);
                                setAiTab('composer');
                                setPromptInput(`${item.cmd} `);
                                setStatusNotice(`Inserted ${item.cmd} into AI Composer`);
                              }}
                              title={guideLang === 'zh' ? `点击将 ${item.cmd} 填入 AI 对话框` : `Click to insert ${item.cmd} into AI Composer`}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                <span className="context-pill" style={{ color: 'var(--accent-bright)' }}><code>{item.cmd}</code></span>
                                <span style={{ fontSize: 11, opacity: 0.8 }}>{item.title}</span>
                              </div>
                              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{item.desc}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10, fontSize: 14 }}>
                          {guideLang === 'zh' ? '常用 @ 上下文引用 (@ Context Mentions)' : '@ Context Mentions'}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {[
                            { tag: '@git', desc: guideLang === 'zh' ? '自动抓取 git status 与最近变更 diff 注入上下文' : 'Injects live git status & git diff' },
                            { tag: '@terminal', desc: guideLang === 'zh' ? '将最近的终端命令执行结果与退出码注入上下文' : 'Injects recent terminal logs and exit codes' },
                            { tag: '@rules', desc: guideLang === 'zh' ? '将 .agents/rules/*.md 与项目规范规则注入提示词' : 'Injects .agents/rules/*.md conventions' },
                            { tag: '@problems', desc: guideLang === 'zh' ? '将当前工作区的语法、编译报错与警告注入' : 'Injects compiler & linter diagnostics' },
                            { tag: '@<filepath>', desc: guideLang === 'zh' ? '实时搜索工作区文件，并将目标代码内容精确注入' : 'Filters & injects exact file content' },
                          ].map((item) => (
                            <div
                              key={item.tag}
                              className="settings-card"
                              style={{ flex: '1 1 240px', margin: 0, padding: 10 }}
                            >
                              <span className="context-pill" style={{ marginBottom: 4, display: 'inline-block' }}>
                                <code>{item.tag}</code>
                              </span>
                              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{item.desc}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Section 5: Inline AI */}
                  {guideSection === 'inline' && (
                    <div>
                      <div className="settings-section-title">
                        {guideLang === 'zh' ? '✨ 5. 行内 AI (Ctrl+I) 与快捷 Code Lenses' : '✨ 5. Inline AI (Ctrl+I) & Code Lenses'}
                      </div>
                      <div className="settings-section-desc">
                        {guideLang === 'zh'
                          ? '除了右侧独立 AI 面板，DeepAutoCode 还提供了直接在代码编辑器内原位触发的 AI 指令系统。'
                          : 'DeepAutoCode provides in-editor AI commands directly anchored to your active file and cursor position.'}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10, fontSize: 14 }}>
                          {guideLang === 'zh' ? '两大行内交互方式' : 'Two Inline Modalities'}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                          <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13.5 }}>⌨️ {guideLang === 'zh' ? '行内指令悬浮窗 (Ctrl+I)' : 'Inline Command Widget (Ctrl+I)'}</strong>
                              <kbd className="welcome-kbd">Ctrl+I</kbd>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {guideLang === 'zh'
                                ? '在任意代码文件中按下 Ctrl+I，即可在光标行弹出浮动指令框，直接输入针对当前行/函数的修改或生成需求，无需移开视线。'
                                : 'Press Ctrl+I in any code tab to pop up a floating instruction bar anchored to your cursor line.'}
                            </div>
                            <button
                              className="btn primary"
                              style={{ marginTop: 10 }}
                              onClick={() => {
                                setShowInlineCommand(true);
                                setStatusNotice('Opened Inline Command Widget (Ctrl+I)');
                              }}
                            >
                              ✨ {guideLang === 'zh' ? '立即体验 Ctrl+I' : 'Try Ctrl+I Now'}
                            </button>
                          </div>

                          <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13.5 }}>⚡ {guideLang === 'zh' ? '编辑器顶部快捷 Code Lens' : 'Code Lens Bar'}</strong>
                              <span className="badge">CodeLens</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {guideLang === 'zh'
                                ? '代码编辑器顶部常驻快捷按钮：✨ Explain（解释当前代码）、🛠️ Refactor（重构与优化）、🧪 Write Tests（编写单元测试）。'
                                : 'Quick actions at the top of the code editor: ✨ Explain, 🛠️ Refactor, and 🧪 Write Tests.'}
                            </div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                              <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => triggerCodeLensAction('explain')}>
                                ✨ Explain
                              </button>
                              <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => triggerCodeLensAction('refactor')}>
                                🛠️ Refactor
                              </button>
                              <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => triggerCodeLensAction('tests')}>
                                🧪 Tests
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Section 6: Artifacts & .agents */}
                  {guideSection === 'artifacts' && (
                    <div>
                      <div className="settings-section-title">
                        {guideLang === 'zh' ? '📑 6. 结构化 Artifacts、子智能体与 .agents 定制' : '📑 6. Artifacts, Subagents & .agents Ecosystem'}
                      </div>
                      <div className="settings-section-desc">
                        {guideLang === 'zh'
                          ? 'DeepAutoCode 具备完整的工程级交付管理体系：独立持久化的 Artifacts 制品、并行子智能体委派与标准 .agents 定制生态。'
                          : 'DeepAutoCode provides structured Artifacts, parallel subagent orchestration, and native .agents customizations.'}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {guideLang === 'zh' ? '📑 Artifacts 制品面板与一键执行计划' : 'Artifacts Pane & Plan Execution'}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {guideLang === 'zh'
                            ? 'AI 生成的实施计划 (Plan)、任务清单 (Task List)、技术报告 (Report) 会独立保存为 Artifact。在右侧 📑 Artifacts 标签页中审阅后，点击 ▶ Proceed & Execute Plan 即可自动将计划转化为代码落地。'
                            : 'Plans, Task Lists, and Reports are persisted as Artifacts. Review them in the 📑 Artifacts dock and click ▶ Proceed & Execute Plan to implement.'}
                        </p>
                        <button
                          className="btn primary"
                          onClick={() => {
                            setShowRightAiDock(true);
                            setAiTab('artifacts');
                            void refreshArtifactsAndCustomizations();
                          }}
                        >
                          📑 {guideLang === 'zh' ? '打开右侧 Artifacts 面板' : 'Open Artifacts Panel'}
                        </button>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {guideLang === 'zh' ? '📜 .agents/ 规范化定制（Rules / Skills / Workflows）' : '.agents/ Workspace Customizations'}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {guideLang === 'zh'
                            ? '系统自动扫描当前工作区的 .agents/rules/*.md（规则）、.agents/skills/*/SKILL.md（技能）、.agents/workflows/*.md（工作流）以及 AGENTS.md，并将其注入 Agent 提示词。'
                            : 'DeepAutoCode automatically scans and loads .agents/rules, .agents/skills, .agents/workflows, and AGENTS.md in your repository.'}
                        </p>
                        <button className="btn" onClick={() => openSettingsCenter('rules')}>
                          📜 {guideLang === 'zh' ? '管理工作区 .agents 规则与技能' : 'Manage .agents Customizations'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Section 7: Web Preview & SSH */}
                  {guideSection === 'preview-ssh' && (
                    <div>
                      <div className="settings-section-title">
                        {guideLang === 'zh' ? '🌐 7. 内置实时 Web 预览与远程 SSH 开发' : '🌐 7. Live Web Preview & Remote SSH'}
                      </div>
                      <div className="settings-section-desc">
                        {guideLang === 'zh'
                          ? '无需频繁切换外部浏览器或第三方终端，在同一个 IDE 窗口内完成前端页面预览与远程 Linux 服务器开发。'
                          : 'Preview web apps and develop on remote Linux clusters directly inside DeepAutoCode.'}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {guideLang === 'zh' ? '🌐 内置 Web 预览 (默认 http://localhost:3000/)' : 'Live Web Preview Tab'}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {guideLang === 'zh'
                            ? '点击顶栏右侧的 🌐 Preview 按钮，或在 View 菜单中选择 Open Live Web Preview，即可在编辑器标签页中实时渲染本地前端项目，支持地址栏跳转、强制刷新，以及点击 ✨ Ask AI to Inspect 让 AI 自动检查页面端点。'
                            : 'Click 🌐 Preview in the titlebar to inspect local dev servers (http://localhost:3000/). Supports reload, browser opening, and AI inspection.'}
                        </p>
                        <button className="btn primary" onClick={() => openWebPreviewTab('http://localhost:3000/')}>
                          🌐 {guideLang === 'zh' ? '打开 http://localhost:3000/ 预览' : 'Open http://localhost:3000/ Preview'}
                        </button>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {guideLang === 'zh' ? '🌐 Remote - SSH 远程连接管理器' : 'Remote - SSH Connection Manager'}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {guideLang === 'zh'
                            ? '点击状态栏左侧的 >< SSH Remote 按钮或按 Ctrl+Alt+O，输入类似 ssh -p 22 root@10.0.62.83 的快捷命令或保存连接配置，即可浏览远程目录并将整套 AI Agent 部署于远程机运行。'
                            : 'Click the >< SSH Remote badge or press Ctrl+Alt+O. Supports fast parsing, password/identity files, and full remote file trees.'}
                        </p>
                        <button className="btn" onClick={() => void openSshConnectionModal()}>
                          🌐 {guideLang === 'zh' ? '打开 SSH 连接管理器 (Ctrl+Alt+O)' : 'Open SSH Connection Manager (Ctrl+Alt+O)'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Section 8: Shortcuts */}
                  {guideSection === 'shortcuts' && (
                    <div>
                      <div className="settings-section-title">
                        {guideLang === 'zh' ? '⌨️ 8. 常用快捷键速查表 (Keyboard Shortcuts Reference)' : '⌨️ 8. Keyboard Shortcuts & Reference'}
                      </div>
                      <div className="settings-section-desc">
                        {guideLang === 'zh'
                          ? '熟练使用快捷键可大幅提升在 DeepAutoCode 中的结对编程效率。'
                          : 'Master keyboard shortcuts to maximize your pair-programming speed.'}
                      </div>

                      <div className="settings-card">
                        <table className="md-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left', padding: '8px 12px' }}>{guideLang === 'zh' ? '快捷键' : 'Shortcut'}</th>
                              <th style={{ textAlign: 'left', padding: '8px 12px' }}>{guideLang === 'zh' ? '功能说明' : 'Action'}</th>
                              <th style={{ textAlign: 'left', padding: '8px 12px' }}>{guideLang === 'zh' ? '快速触发' : 'Trigger'}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              { k: 'F1', d: guideLang === 'zh' ? '打开完整使用说明中心' : 'Open User Guide Center', a: () => openUserGuide('quickstart') },
                              { k: 'Ctrl+Shift+P / Ctrl+P', d: guideLang === 'zh' ? '打开命令面板 / 快速搜索文件' : 'Command Palette / Quick File Open', a: () => setShowPalette(true) },
                              { k: 'Ctrl+I', d: guideLang === 'zh' ? '弹出编辑器行内 AI 指令浮窗' : 'Toggle Inline AI Command Widget', a: () => setShowInlineCommand(true) },
                              { k: 'Ctrl+L', d: guideLang === 'zh' ? '展开/收起右侧 AI 对话栏' : 'Toggle AI Agent & Artifacts Dock', a: () => setShowRightAiDock((v) => !v) },
                              { k: 'Ctrl+B', d: guideLang === 'zh' ? '展开/收起左侧主侧边栏' : 'Toggle Primary Left Sidebar', a: () => setShowLeftSidebar((v) => !v) },
                              { k: 'Ctrl+J', d: guideLang === 'zh' ? '展开/收起底部终端与问题面板' : 'Toggle Bottom Terminal Panel', a: () => setShowBottomPanel((v) => !v) },
                              { k: 'Ctrl+O', d: guideLang === 'zh' ? '打开本地项目文件夹' : 'Open Project Folder', a: () => void handleOpenProjectAction() },
                              { k: 'Ctrl+Alt+O', d: guideLang === 'zh' ? '打开远程 SSH 连接管理器' : 'Connect via SSH', a: () => void openSshConnectionModal() },
                              { k: 'Ctrl+S', d: guideLang === 'zh' ? '保存当前活动文件' : 'Save Current File', a: () => void saveCurrentTab() },
                              { k: 'Ctrl+,', d: guideLang === 'zh' ? '打开 DeepAutoCode 设置中心' : 'Open Settings Center', a: () => openSettingsCenter('general') },
                              { k: 'Ctrl+Shift+J', d: guideLang === 'zh' ? '打开 AI 模型与 Provider 设置' : 'Configure AI Models', a: () => openSettingsCenter('models') },
                              { k: 'Alt+T', d: guideLang === 'zh' ? '切换深色 / 浅色主题' : 'Toggle Dark / Light Theme', a: () => toggleColorTheme() },
                            ].map((row) => (
                              <tr key={row.k} style={{ borderTop: '1px solid var(--border)' }}>
                                <td style={{ padding: '8px 12px' }}><kbd className="welcome-kbd">{row.k}</kbd></td>
                                <td style={{ padding: '8px 12px', fontSize: 12.5 }}>{row.d}</td>
                                <td style={{ padding: '8px 12px' }}>
                                  <button className="btn" style={{ padding: '2px 8px', fontSize: 10.5 }} onClick={row.a}>
                                    {guideLang === 'zh' ? '立即执行' : 'Run'}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : activeTab?.kind === 'settings' ? (
              <div
                className="settings-center-layout"
                style={{ gridTemplateColumns: `${settingsNavWidth}px 5px 1fr` }}
              >
                {/* Left Settings Navigation Rail (Cursor / Antigravity style) */}
                <aside className="settings-nav">
                  <div
                    className="settings-nav-title"
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <BrandMark size={16} radius={4} />
                    <span>DeepAutoCode Settings</span>
                  </div>
                  {[
                    { id: 'general', icon: '⚙️', label: 'General & Project' },
                    { id: 'models', icon: '🤖', label: 'Models & Providers' },
                    { id: 'security', icon: '🛡️', label: 'Agent & Security' },
                    { id: 'rules', icon: '📜', label: 'Rules for AI' },
                    { id: 'mcp', icon: '🔌', label: 'MCP & Capabilities' },
                    { id: 'runtime', icon: '⚡', label: 'Cline SDK Runtime' },
                    { id: 'extensions', icon: '🧩', label: 'Extensions & VSIX' },
                  ].map((nav) => (
                    <div
                      key={nav.id}
                      className={`settings-nav-item ${
                        settingsCategory === nav.id ? 'active' : ''
                      }`}
                      onClick={() => setSettingsCategory(nav.id as SettingsCategory)}
                    >
                      <span>{nav.icon}</span>
                      <span>{nav.label}</span>
                    </div>
                  ))}
                </aside>

                {/* Resizable Sash inside Settings Center */}
                <div
                  className={`resizer-col ${draggingSash === 'settings' ? 'dragging' : ''}`}
                  title="Drag to resize Settings navigation"
                  onMouseDown={(e) => startPaneResize('settings', e)}
                />

                {/* Right Settings Content Pane */}
                <div className="settings-content">
                  {settingsCategory === 'general' && (
                    <div>
                      <div className="settings-section-title">General, Project & Editor Settings</div>
                      <div className="settings-section-desc">
                        Manage active project workspace folder, recent projects, and Code - OSS editor preferences.
                      </div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">Current Project Workspace</div>
                            <div className="settings-sublabel">{workspaceRoot}</div>
                          </div>
                          <button
                            className="btn primary"
                            onClick={() => void handleOpenProjectAction()}
                          >
                            📂 Open / Switch Folder...
                          </button>
                        </div>

                        <div style={{ marginTop: 12 }}>
                          <div className="settings-sublabel" style={{ marginBottom: 8 }}>
                            Quick Switch Recent Workspaces:
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {(ideSettings.recentWorkspaces ?? []).map((ws: string) => (
                              <button
                                key={ws}
                                className={`btn ${ws === workspaceRoot ? 'primary' : ''}`}
                                onClick={() => void switchProjectFolder(ws)}
                              >
                                📁 {ws}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">Editor Font Size</div>
                            <div className="settings-sublabel">
                              Controls font size in pixels in the code editor.
                            </div>
                          </div>
                          <input
                            type="number"
                            className="settings-input"
                            style={{ minWidth: 90, width: 90 }}
                            value={ideSettings.editor?.fontSize ?? 13}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                editor: {
                                  ...ideSettings.editor,
                                  fontSize: Number(e.target.value),
                                },
                              })
                            }
                          />
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">Tab Size</div>
                            <div className="settings-sublabel">
                              The number of spaces a tab is equal to.
                            </div>
                          </div>
                          <select
                            className="settings-select"
                            style={{ minWidth: 120 }}
                            value={ideSettings.editor?.tabSize ?? 2}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                editor: {
                                  ...ideSettings.editor,
                                  tabSize: Number(e.target.value),
                                },
                              })
                            }
                          >
                            <option value={2}>2 Spaces</option>
                            <option value={4}>4 Spaces</option>
                          </select>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">Auto Save</div>
                            <div className="settings-sublabel">
                              Controls automatic saving of dirty editor files.
                            </div>
                          </div>
                          <select
                            className="settings-select"
                            value={ideSettings.editor?.autoSave ?? 'afterDelay'}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                editor: { ...ideSettings.editor, autoSave: e.target.value },
                              })
                            }
                          >
                            <option value="afterDelay">afterDelay (1000ms)</option>
                            <option value="onFocusChange">onFocusChange</option>
                            <option value="off">off</option>
                          </select>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">IDE Color Theme</div>
                            <div className="settings-sublabel">
                              Select workbench color theme or click the ☀️/🌙 button in the top titlebar.
                            </div>
                          </div>
                          <select
                            className="settings-select"
                            value={ideSettings.editor?.theme ?? 'cursor-dark'}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                editor: { ...ideSettings.editor, theme: e.target.value },
                              })
                            }
                          >
                            <option value="cursor-dark">🌙 Cursor Dark (Default)</option>
                            <option value="cursor-light">☀️ Cursor Light (Clean Daylight)</option>
                            <option value="antigravity-midnight">🌌 Antigravity Midnight</option>
                            <option value="high-contrast">⚡ High Contrast Dark</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'models' && (
                    <div>
                      <div className="settings-section-title">
                        Models & Provider Configuration (Section 7 / ADR-005)
                      </div>
                      <div className="settings-section-desc">
                        DeepSeek is configured as the out-of-the-box default Provider without vendor lock-in. API Keys are stored in OS Credential Storage (SecretStorage).
                      </div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">Active Model Provider</div>
                            <div className="settings-sublabel">
                              Switch between DeepSeek, OpenAI-Compatible (Ollama / vLLM / Enterprise Gateway), and Anthropic.
                            </div>
                          </div>
                          <select
                            className="settings-select"
                            value={selectedProviderId}
                            onChange={(e) => {
                              const id = e.target.value;
                              setSelectedProviderId(id);
                              const found = providerData?.providers?.find(
                                (p: any) => p.providerId === id
                              );
                              if (found) {
                                setEndpointInput(found.apiEndpoint);
                                setModelInput(found.defaultModelId);
                              }
                            }}
                          >
                            <option value="deepseek">DeepSeek (Default)</option>
                            <option value="openai-compatible">
                              OpenAI-Compatible (Ollama / vLLM / Gateway)
                            </option>
                            <option value="anthropic">Anthropic Claude</option>
                          </select>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">API Base Endpoint</div>
                            <div className="settings-sublabel">
                              Base URL for chat completions and tool calling.
                            </div>
                          </div>
                          <input
                            className="settings-input"
                            value={endpointInput}
                            onChange={(e) => setEndpointInput(e.target.value)}
                          />
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">Default Model ID</div>
                            <div className="settings-sublabel">
                              e.g. deepseek-chat, deepseek-reasoner, qwen2.5-coder:14b
                            </div>
                          </div>
                          <input
                            className="settings-input"
                            value={modelInput}
                            onChange={(e) => setModelInput(e.target.value)}
                          />
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">
                              API Key (OS Credential Storage)
                            </div>
                            <div className="settings-sublabel">
                              Never written to plaintext config or logs. Click "⚡ Test AI Key" to verify live model connectivity.
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                              type="password"
                              className="settings-input"
                              placeholder={
                                providerData?.active?.hasApiKeyConfigured
                                  ? '•••••••• (Configured in SecretStorage)'
                                  : 'sk-...'
                              }
                              value={apiKeyInput}
                              onChange={(e) => setApiKeyInput(e.target.value)}
                            />
                            <button
                              className="btn success"
                              style={{ whiteSpace: 'nowrap', padding: '6px 12px' }}
                              disabled={isTestingKey}
                              onClick={() => void handleTestAiKey()}
                            >
                              {isTestingKey ? '⏳ Testing...' : '⚡ Test AI Key'}
                            </button>
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                          <button
                            className="btn primary"
                            onClick={async () => {
                              const res = await bridge.request('provider.update', {
                                providerId: selectedProviderId,
                                apiEndpoint: endpointInput,
                                modelId: modelInput,
                                apiKey: apiKeyInput || undefined,
                              });
                              setProviderData({ ...providerData, active: res.active });
                              setApiKeyInput('');
                              setStatusNotice(`Saved Provider "${selectedProviderId}"`);
                            }}
                          >
                            Save Provider Configuration
                          </button>
                          <button
                            className="btn"
                            disabled={isTestingKey}
                            onClick={() => void handleTestAiKey()}
                          >
                            {isTestingKey
                              ? '⏳ Verifying AI Model...'
                              : '⚡ Test AI Key & Model Connectivity'}
                          </button>
                        </div>

                        {smokeResult && (
                          <div
                            className={`ai-key-test-banner ${
                              smokeResult.ok ? 'ok' : 'fail'
                            }`}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                              }}
                            >
                              <strong style={{ fontSize: 13 }}>
                                {smokeResult.ok
                                  ? `✅ AI Connectivity Verified (${smokeResult.providerId} / ${smokeResult.modelId})`
                                  : `❌ AI Connectivity Failed (${smokeResult.providerId} / ${smokeResult.modelId})`}
                              </strong>
                              <span
                                className={`badge ${
                                  smokeResult.ok ? 'success' : 'danger'
                                }`}
                              >
                                {smokeResult.ok
                                  ? `${smokeResult.latencyMs} ms`
                                  : smokeResult.diagnostic?.code || 'ERROR'}
                              </span>
                            </div>
                            {smokeResult.ok ? (
                              <div style={{ color: 'var(--text-primary)', fontSize: 12 }}>
                                Model Response Preview:
                                <code
                                  className="md-inline-code"
                                  style={{ marginLeft: 6 }}
                                >
                                  {smokeResult.replyPreview || 'Connected'}
                                </code>
                              </div>
                            ) : (
                              <div style={{ color: 'var(--text-primary)', fontSize: 12 }}>
                                <div>
                                  Reason: {smokeResult.diagnostic?.userMessage || 'Unable to connect to model service'}
                                </div>
                                {smokeResult.diagnostic?.remediation && (
                                  <div style={{ marginTop: 4, opacity: 0.9 }}>
                                    Remediation: {smokeResult.diagnostic.remediation}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'security' && (
                    <div>
                      <div className="settings-section-title">
                        Agent Execution & Security Policies (Section 9 / ADR-008)
                      </div>
                      <div className="settings-section-desc">
                        Configure Plan read-only boundaries, Auto mode command allowlists, human-in-the-loop approval timeouts, and symlink escape protection.
                      </div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">Default Agent Execution Mode</div>
                            <div className="settings-sublabel">
                              Plan Mode enforces strict read-only; Auto Mode allows low-risk allowlisted operations; Manual requires approval for all mutations.
                            </div>
                          </div>
                          <select
                            className="settings-select"
                            value={executionMode}
                            onChange={(e) => {
                              const m = e.target.value as any;
                              setExecutionMode(m);
                              void persistIdeSettings({
                                ...ideSettings,
                                agent: { ...ideSettings.agent, defaultExecutionMode: m },
                              });
                            }}
                          >
                            <option value="auto">∞ Agent (Auto Allowlist)</option>
                            <option value="plan">📖 Plan (Strictly Read-Only)</option>
                            <option value="manual">🛡️ Manual Approval</option>
                          </select>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">Approval Expiration Timeout (Seconds)</div>
                            <div className="settings-sublabel">
                              Unanswered high-risk tool approval cards automatically expire and reject after this duration.
                            </div>
                          </div>
                          <input
                            type="number"
                            className="settings-input"
                            style={{ minWidth: 100, width: 100 }}
                            value={ideSettings.agent?.approvalTimeoutSeconds ?? 120}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                agent: {
                                  ...ideSettings.agent,
                                  approvalTimeoutSeconds: Number(e.target.value),
                                },
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 6 }}>
                          Auto Mode Command Allowlist (Section 9.2)
                        </div>
                        <div className="settings-sublabel" style={{ marginBottom: 10 }}>
                          Commands matching these prefixes run without blocking in Auto Mode; all other commands trigger explicit user approval.
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                          {(ideSettings.agent?.commandAllowlist ?? []).map((cmd: string) => (
                            <span key={cmd} className="context-pill">
                              <code>{cmd}</code>
                              <span
                                style={{ cursor: 'pointer', marginLeft: 4 }}
                                onClick={() => {
                                  const next = (
                                    ideSettings.agent?.commandAllowlist ?? []
                                  ).filter((c: string) => c !== cmd);
                                  void persistIdeSettings({
                                    ...ideSettings,
                                    agent: { ...ideSettings.agent, commandAllowlist: next },
                                  });
                                }}
                              >
                                ✕
                              </span>
                            </span>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            className="settings-input"
                            placeholder="Add safe command prefix (e.g. npm run lint)"
                            value={newAllowlistCmd}
                            onChange={(e) => setNewAllowlistCmd(e.target.value)}
                          />
                          <button
                            className="btn primary"
                            onClick={() => {
                              if (!newAllowlistCmd.trim()) return;
                              const next = [
                                ...(ideSettings.agent?.commandAllowlist ?? []),
                                newAllowlistCmd.trim(),
                              ];
                              setNewAllowlistCmd('');
                              void persistIdeSettings({
                                ...ideSettings,
                                agent: { ...ideSettings.agent, commandAllowlist: next },
                              });
                            }}
                          >
                            + Add Allowlist Rule
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'rules' && (
                    <div>
                      <div className="settings-section-title">
                        Antigravity Customizations: .agents/ Rules, Skills & Workflows
                      </div>
                      <div className="settings-section-desc">
                        DeepAutoCode automatically discovers <code>.agents/rules/*.md</code>,{' '}
                        <code>.agents/skills/*/SKILL.md</code>, <code>.agents/workflows/*.md</code>, and{' '}
                        <code>AGENTS.md</code> in the active workspace and injects them into Agent sessions.
                      </div>

                      <div className="settings-card">
                        <div className="settings-row" style={{ marginBottom: 12 }}>
                          <div>
                            <div className="settings-label">
                              Workspace .agents/ Customizations ({workspaceCustomizations.rules.length} Rules,{' '}
                              {workspaceCustomizations.skills.length} Skills,{' '}
                              {workspaceCustomizations.workflows.length} Workflows)
                            </div>
                            <div className="settings-sublabel">
                              Scaffold standard Antigravity customization files directly into your active repository.
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              className="btn primary"
                              onClick={() => void handleScaffoldCustomization('rule')}
                            >
                              + New .agents Rule
                            </button>
                            <button
                              className="btn"
                              onClick={() => void handleScaffoldCustomization('skill')}
                            >
                              + New .agents Skill
                            </button>
                            <button
                              className="btn"
                              onClick={() => void handleScaffoldCustomization('workflow')}
                            >
                              + New .agents Workflow
                            </button>
                          </div>
                        </div>

                        {(workspaceCustomizations.rules.length > 0 ||
                          workspaceCustomizations.skills.length > 0 ||
                          workspaceCustomizations.workflows.length > 0) && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                            {workspaceCustomizations.rules.map((r) => (
                              <div
                                key={r.path}
                                className="settings-row"
                                style={{ cursor: 'pointer' }}
                                onClick={() => void openFileInTab(r.path, true)}
                              >
                                <div>
                                  <span className="badge info" style={{ marginRight: 8 }}>RULE</span>
                                  <strong>{r.name}</strong>
                                </div>
                                <code className="md-inline-code">{r.path}</code>
                              </div>
                            ))}
                            {workspaceCustomizations.skills.map((s) => (
                              <div
                                key={s.path}
                                className="settings-row"
                                style={{ cursor: 'pointer' }}
                                onClick={() => void openFileInTab(s.path, true)}
                              >
                                <div>
                                  <span className="badge success" style={{ marginRight: 8 }}>SKILL</span>
                                  <strong>{s.name}</strong> — <span style={{ fontSize: 12, opacity: 0.8 }}>{s.description}</span>
                                </div>
                                <code className="md-inline-code">{s.path}</code>
                              </div>
                            ))}
                            {workspaceCustomizations.workflows.map((w) => (
                              <div
                                key={w.path}
                                className="settings-row"
                                style={{ cursor: 'pointer' }}
                                onClick={() => void openFileInTab(w.path, true)}
                              >
                                <div>
                                  <span className="badge warning" style={{ marginRight: 8 }}>WORKFLOW</span>
                                  <strong>{w.name}</strong> — <span style={{ fontSize: 12, opacity: 0.8 }}>{w.description}</span>
                                </div>
                                <code className="md-inline-code">{w.path}</code>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="settings-label" style={{ marginBottom: 8 }}>
                          Global / Fallback Project Rules
                        </div>
                        <textarea
                          style={{
                            width: '100%',
                            minHeight: 160,
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            color: 'var(--text-primary)',
                            padding: 12,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            lineHeight: 1.6,
                          }}
                          value={ideSettings.agent?.projectRules ?? ''}
                          onChange={(e) =>
                            setIdeSettings({
                              ...ideSettings,
                              agent: { ...ideSettings.agent, projectRules: e.target.value },
                            })
                          }
                        />
                        <div style={{ marginTop: 12 }}>
                          <button
                            className="btn primary"
                            onClick={() => void persistIdeSettings(ideSettings)}
                          >
                            Save Project AI Rules
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'mcp' && (
                    <div>
                      <div className="settings-section-title">
                        MCP Servers & Registered Host Capabilities (Appendix B)
                      </div>
                      <div className="settings-section-desc">
                        Inspect the 5 core Code - OSS Host Capabilities registered in CapabilityRegistry and manage Model Context Protocol (MCP) servers.
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10 }}>
                          Verified Capability → Code - OSS API Mapping Table (ADR-010)
                        </div>
                        {(registeredCapabilities ?? []).map((cap: any) => (
                          <div key={cap.name} className="settings-row">
                            <div>
                              <div className="settings-label">
                                <code>{cap.name}</code>{' '}
                                <span
                                  className={`badge ${
                                    cap.requiresApprovalByDefault ? 'warning' : 'success'
                                  }`}
                                >
                                  {cap.requiresApprovalByDefault
                                    ? 'Requires Approval'
                                    : 'Safe / Auto'}
                                </span>
                              </div>
                              <div className="settings-sublabel">{cap.description}</div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: '#60a5fa',
                                  fontFamily: 'var(--font-mono)',
                                  marginTop: 2,
                                }}
                              >
                                Host API: {cap.codeOssApi}
                              </div>
                            </div>
                            <span className="badge">Timeout: {cap.defaultTimeoutMs}ms</span>
                          </div>
                        ))}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10 }}>
                          Configured MCP Servers
                        </div>
                        {(ideSettings.mcpServers ?? []).map((srv: any) => (
                          <div key={srv.id} className="settings-row">
                            <div>
                              <div className="settings-label">{srv.name}</div>
                              <div
                                className="settings-sublabel"
                                style={{ fontFamily: 'var(--font-mono)' }}
                              >
                                [{srv.transport}] {srv.commandOrUrl}
                              </div>
                            </div>
                            <span className="badge success">Enabled</span>
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                          <input
                            className="settings-input"
                            placeholder="MCP Server Name"
                            value={newMcpName}
                            onChange={(e) => setNewMcpName(e.target.value)}
                          />
                          <input
                            className="settings-input"
                            placeholder="Command or URL (npx -y ...)"
                            value={newMcpCmd}
                            onChange={(e) => setNewMcpCmd(e.target.value)}
                          />
                          <button
                            className="btn primary"
                            onClick={() => {
                              if (!newMcpName.trim() || !newMcpCmd.trim()) return;
                              const next = [
                                ...(ideSettings.mcpServers ?? []),
                                {
                                  id: `mcp_${Date.now()}`,
                                  name: newMcpName.trim(),
                                  transport: 'stdio',
                                  commandOrUrl: newMcpCmd.trim(),
                                  enabled: true,
                                },
                              ];
                              setNewMcpName('');
                              setNewMcpCmd('');
                              void persistIdeSettings({ ...ideSettings, mcpServers: next });
                            }}
                          >
                            + Add MCP
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'runtime' && (
                    <div>
                      <div className="settings-section-title">
                        Cline SDK Runtime & Hub-Spoke Topology (Section 5 / ADR-006 / ADR-009)
                      </div>
                      <div className="settings-section-desc">
                        Configure backendMode (local / auto / hub / remote) and verify PoC-L1 (disk write) & PoC-L2 (cross-instance session recovery).
                      </div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">Runtime Backend Mode</div>
                            <div className="settings-sublabel">
                              local is the Phase 0/1 baseline; auto probes local Hub and falls back to local.
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {(['local', 'auto', 'hub', 'remote'] as const).map((m) => (
                              <button
                                key={m}
                                className={`btn ${
                                  backendStatus?.diagnostics?.configuredMode === m
                                    ? 'primary'
                                    : ''
                                }`}
                                onClick={async () => {
                                  try {
                                    await bridge.request(
                                      'backend.switch',
                                      { mode: m },
                                      activeSessionId
                                    );
                                    const back = await bridge.request('backend.status');
                                    setBackendStatus(back);
                                    setStatusNotice(
                                      `Backend mode -> ${back.diagnostics.effectiveMode}`
                                    );
                                  } catch (err) {
                                    setStatusNotice((err as Error).message);
                                  }
                                }}
                              >
                                {m.toUpperCase()}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">
                              PoC-L2 Cross-Instance Session Recovery Test
                            </div>
                            <div className="settings-sublabel">
                              Destroys the active ClineCore instance and boots a new instance to verify persisted sessions are automatically discovered and restored.
                            </div>
                          </div>
                          <button
                            className="btn primary"
                            onClick={() => void handleSimulateExtensionHostRestart()}
                          >
                            ↻ Simulate Extension Host Restart
                          </button>
                        </div>

                        <pre
                          style={{
                            marginTop: 12,
                            padding: 12,
                            background: 'var(--bg-input)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11.5,
                          }}
                        >
                          {JSON.stringify(backendStatus ?? {}, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'extensions' && (
                    <div>
                      <div className="settings-section-title">
                        Open VSX Compatibility Matrix & Legal VSIX Installer (Section 8 / DA-005)
                      </div>
                      <div className="settings-section-desc">
                        {extensionsCatalog?.policyNote}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8 }}>
                          Manual Local VSIX Package Installer
                        </div>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <input
                            className="settings-input"
                            value={vsixFileName}
                            onChange={(e) => setVsixFileName(e.target.value)}
                          />
                          <label style={{ display: 'flex', gap: 6, fontSize: 12 }}>
                            <input
                              type="checkbox"
                              checked={vsixConfirmed}
                              onChange={(e) => setVsixConfirmed(e.target.checked)}
                            />
                            I confirm I hold a valid license for this VSIX extension
                          </label>
                          <button
                            className="btn primary"
                            onClick={async () => {
                              const res = await fetch('/api/extensions/install-vsix', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  vsixFileName,
                                  userConfirmedLicense: vsixConfirmed,
                                }),
                              }).then((r) => r.json());
                              setStatusNotice(res.message || res.error);
                            }}
                          >
                            Install VSIX
                          </button>
                        </div>
                      </div>

                      <div className="settings-card">
                        {(extensionsCatalog?.extensions ?? []).map((ext: any) => (
                          <div key={ext.id} className="settings-row">
                            <div>
                              <div className="settings-label">
                                {ext.displayName}{' '}
                                <span className="badge">{ext.id}</span>{' '}
                                <span
                                  className={`badge ${
                                    ext.openVsxAvailable ? 'success' : 'warning'
                                  }`}
                                >
                                  {ext.openVsxAvailable
                                    ? 'Open VSX Verified'
                                    : 'Proprietary Restricted'}
                                </span>
                              </div>
                              <div className="settings-sublabel">{ext.notes}</div>
                            </div>
                            {ext.openVsxAvailable ? (
                              <button
                                className={`btn ${ext.installed ? '' : 'primary'}`}
                                onClick={async () => {
                                  await fetch('/api/extensions/install-openvsx', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ extensionId: ext.id }),
                                  });
                                  const updated = await fetch('/api/extensions').then((r) =>
                                    r.json()
                                  );
                                  setExtensionsCatalog(updated);
                                  setStatusNotice(`Installed ${ext.id}`);
                                }}
                              >
                                {ext.installed ? 'Installed ✓' : 'Install from Open VSX'}
                              </button>
                            ) : (
                              <span className="badge warning">Use Open-Source Alternative</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : activeTab?.kind === 'diff' ? (
              diffViewMode === 'split' ? (
                <div className="ag-split-diff-wrapper">
                  <div className="ag-split-diff-header">
                    <div className="ag-split-header-col original">
                      <span>🔴 Original ({activeTab.diffRecord?.filePath || activeTab.name} — Before)</span>
                    </div>
                    <div className="ag-split-header-col modified">
                      <span>🟢 Modified (Proposed AI Changes — After)</span>
                    </div>
                  </div>
                  <div className="ag-split-diff-body">
                    {parseDiffToSplitRows(activeTab.content).map((row, rIdx) => {
                      if (row.leftType === 'hdr') {
                        return (
                          <div key={rIdx} className="ag-split-row hdr">
                            <span style={{ width: '100%', textAlign: 'center', display: 'block' }}>
                              {row.leftText}
                            </span>
                          </div>
                        );
                      }
                      return (
                        <div key={rIdx} className="ag-split-row">
                          <div className={`ag-split-cell left ${row.leftType || 'empty'}`}>
                            <span className="ag-split-line-num">{row.leftLine != null ? row.leftLine : ''}</span>
                            <span className="ag-split-line-text">{row.leftText != null ? row.leftText : ''}</span>
                          </div>
                          <div className="ag-split-divider" />
                          <div className={`ag-split-cell right ${row.rightType || 'empty'}`}>
                            <span className="ag-split-line-num">{row.rightLine != null ? row.rightLine : ''}</span>
                            <span className="ag-split-line-text">{row.rightText != null ? row.rightText : ''}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }}>
                  {activeTab.content.split('\n').map((line, i) => {
                    const cls = line.startsWith('+')
                      ? 'add'
                      : line.startsWith('-')
                        ? 'del'
                        : line.startsWith('@@')
                          ? 'hdr'
                          : '';
                    return (
                      <div key={i} className={`diff-line ${cls}`}>
                        <span
                          style={{
                            display: 'inline-block',
                            width: 38,
                            color: '#586069',
                            userSelect: 'none',
                          }}
                        >
                          {i + 1}
                        </span>
                        {line}
                      </div>
                    );
                  })}
                </div>
              )
            ) : activeTab?.kind === 'preview' ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  width: '100%',
                  height: '100%',
                  background: 'var(--bg-surface)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--bg-elevated)',
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600 }}>🌐 Live Preview:</span>
                  <input
                    className="settings-input"
                    style={{ flex: 1, minWidth: 180, padding: '5px 10px', fontSize: 12 }}
                    value={previewUrlInput}
                    onChange={(e) => setPreviewUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        openWebPreviewTab(previewUrlInput);
                        setPreviewReloadKey((k) => k + 1);
                      }
                    }}
                    placeholder="http://localhost:3000/"
                  />
                  <button
                    type="button"
                    className="btn primary"
                    style={{ padding: '4px 10px', fontSize: 11.5 }}
                    onClick={() => {
                      openWebPreviewTab(previewUrlInput);
                      setPreviewReloadKey((k) => k + 1);
                    }}
                  >
                    ↻ Go / Reload
                  </button>
                  <a
                    className="btn"
                    style={{ padding: '4px 10px', fontSize: 11.5, textDecoration: 'none' }}
                    href={activeTab.content || 'http://localhost:3000/'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    ↗ Open in Browser
                  </a>
                  <button
                    type="button"
                    className="btn"
                    style={{ padding: '4px 10px', fontSize: 11.5 }}
                    onClick={() => {
                      setShowRightAiDock(true);
                      setAiTab('composer');
                      void handleSendPrompt(
                        `Inspect the running web application at ${activeTab.content || 'http://localhost:3000/'} and verify its UI and server endpoints.`,
                        'auto'
                      );
                    }}
                  >
                    ✨ Ask AI to Inspect
                  </button>
                </div>
                <iframe
                  key={`${activeTab.content}_${previewReloadKey}`}
                  title="Live Web Preview"
                  src={activeTab.content || 'http://localhost:3000/'}
                  style={{
                    flex: 1,
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    background: '#ffffff',
                  }}
                />
              </div>
            ) : /\.pdf$/i.test(activeTab?.path || '') ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  width: '100%',
                  height: '100%',
                  background: 'var(--bg-surface)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 14px',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--bg-elevated)',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12.5,
                      fontWeight: 600,
                    }}
                  >
                    <span>📕 PDF Preview:</span>
                    <code className="md-inline-code">{activeTab?.path}</code>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      type="button"
                      className="btn primary"
                      style={{ padding: '4px 10px', fontSize: 11.5 }}
                      onClick={() =>
                        void fetch('/api/workspace/open-external', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ targetPath: activeTab?.path }),
                        })
                      }
                    >
                      📂 Open in System PDF Viewer
                    </button>
                    <a
                      className="btn"
                      style={{ padding: '4px 10px', fontSize: 11.5, textDecoration: 'none' }}
                      href={
                        activeTab?.content?.startsWith('blob:')
                          ? activeTab.content
                          : `/api/workspace/raw?path=${encodeURIComponent(activeTab?.path || '')}&download=1`
                      }
                      download={(activeTab?.path || 'document.pdf').split('/').pop()}
                    >
                      ⬇️ Download PDF
                    </a>
                  </div>
                </div>
                <iframe
                  title={activeTab?.name || 'PDF Preview'}
                  src={
                    activeTab?.content?.startsWith('blob:')
                      ? activeTab.content
                      : `/api/workspace/raw?path=${encodeURIComponent(activeTab?.path || '')}`
                  }
                  style={{
                    flex: 1,
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    background: '#525659',
                  }}
                />
              </div>
            ) : activeTab?.kind === 'image' || IMAGE_FILE_EXT_PATTERN.test(activeTab?.path || '') ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  width: '100%',
                  height: '100%',
                  background: 'var(--bg-surface)',
                  overflow: 'hidden',
                }}
              >
                {/* Image Viewer Toolbar */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 14px',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--bg-elevated)',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>🖼️ Image Viewer:</span>
                    <code className="md-inline-code">{activeTab?.path}</code>
                    {imageDimensions && (
                      <span className="badge success" style={{ fontSize: 11 }}>
                        {imageDimensions.width} × {imageDimensions.height} px
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {/* Zoom Controls */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        background: 'var(--bg-input)',
                        padding: '2px 6px',
                        borderRadius: 4,
                        border: '1px solid var(--border)',
                      }}
                    >
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: '2px 6px', fontSize: 11 }}
                        title="Zoom Out"
                        onClick={() => setImageZoom((z) => Math.max(0.1, Number((z - 0.25).toFixed(2))))}
                      >
                        －
                      </button>
                      <span style={{ fontSize: 11, minWidth: 42, textAlign: 'center', fontWeight: 600 }}>
                        {Math.round(imageZoom * 100)}%
                      </span>
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: '2px 6px', fontSize: 11 }}
                        title="Zoom In"
                        onClick={() => setImageZoom((z) => Math.min(16, Number((z + 0.25).toFixed(2))))}
                      >
                        ＋
                      </button>
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: '2px 6px', fontSize: 11 }}
                        title="Reset Zoom to 100%"
                        onClick={() => setImageZoom(1)}
                      >
                        100%
                      </button>
                      {[2, 4, 8].map((mul) => (
                        <button
                          key={mul}
                          type="button"
                          className={`btn ${imageZoom === mul ? 'primary' : ''}`}
                          style={{ padding: '2px 5px', fontSize: 10.5 }}
                          title={`Scale ${mul}x (Pixel Perfect for Icons)`}
                          onClick={() => setImageZoom(mul)}
                        >
                          {mul}x
                        </button>
                      ))}
                    </div>

                    {/* Background Pattern Toggle (Checkerboard / Dark / Light) */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <button
                        type="button"
                        className={`btn ${imageBgPattern === 'checker' ? 'primary' : ''}`}
                        style={{ padding: '3px 8px', fontSize: 11 }}
                        title="Transparent Checkerboard Background"
                        onClick={() => setImageBgPattern('checker')}
                      >
                        🏁 Grid
                      </button>
                      <button
                        type="button"
                        className={`btn ${imageBgPattern === 'dark' ? 'primary' : ''}`}
                        style={{ padding: '3px 8px', fontSize: 11 }}
                        title="Dark Background"
                        onClick={() => setImageBgPattern('dark')}
                      >
                        ⬛ Dark
                      </button>
                      <button
                        type="button"
                        className={`btn ${imageBgPattern === 'light' ? 'primary' : ''}`}
                        style={{ padding: '3px 8px', fontSize: 11 }}
                        title="Light Background"
                        onClick={() => setImageBgPattern('light')}
                      >
                        ⬜ Light
                      </button>
                    </div>

                    {/* Download & AI Actions */}
                    <a
                      className="btn"
                      style={{ padding: '3px 8px', fontSize: 11, textDecoration: 'none' }}
                      href={
                        activeTab?.content?.startsWith('data:')
                          ? activeTab.content
                          : `/api/workspace/raw?path=${encodeURIComponent(activeTab?.path || '')}&download=1`
                      }
                      download={(activeTab?.path || 'image.png').split('/').pop()}
                      title="Download Image Asset"
                    >
                      ⬇️ Download
                    </a>
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: '3px 8px', fontSize: 11 }}
                      onClick={() => {
                        setShowRightAiDock(true);
                        setAiTab('composer');
                        void handleSendPrompt(
                          `Inspect the image asset at ${activeTab?.path} (format: ${(activeTab?.path || '').split('.').pop()}, dimensions: ${imageDimensions ? `${imageDimensions.width}x${imageDimensions.height}px` : 'detected'}). Analyze its visual composition, resolution, and design recommendations.`,
                          'auto'
                        );
                      }}
                    >
                      ✨ Ask AI to Analyze
                    </button>
                  </div>
                </div>

                {/* Canvas Surface with Checkerboard Background */}
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'auto',
                    position: 'relative',
                    padding: 28,
                    background:
                      imageBgPattern === 'dark'
                        ? '#0d1117'
                        : imageBgPattern === 'light'
                          ? '#ffffff'
                          : 'repeating-conic-gradient(#80808020 0% 25%, transparent 0% 50%) 50% / 16px 16px',
                    backgroundColor: imageBgPattern === 'checker' ? 'var(--bg-canvas, #1a1d24)' : undefined,
                  }}
                  onWheel={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault();
                      const delta = e.deltaY < 0 ? 0.25 : -0.25;
                      setImageZoom((z) => Math.max(0.1, Math.min(16, Number((z + delta).toFixed(2)))));
                    }
                  }}
                >
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
                      borderRadius: 4,
                      overflow: 'hidden',
                      background: 'transparent',
                      transform: `scale(${imageZoom})`,
                      transformOrigin: 'center center',
                      transition: 'transform 0.08s ease-out',
                    }}
                  >
                    <img
                      key={`${activeTab?.path}_${activeTab?.content}`}
                      src={activeTab?.content || `/api/workspace/raw?path=${encodeURIComponent(activeTab?.path || '')}`}
                      alt={activeTab?.name || 'Image'}
                      style={{
                        maxWidth: 'none',
                        display: 'block',
                        imageRendering:
                          imageZoom > 1.5 || /\.ico$/i.test(activeTab?.path || '') ? 'pixelated' : 'auto',
                      }}
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
                      }}
                      onError={(e) => {
                        const img = e.currentTarget;
                        const fallbackSrc = `/api/workspace/raw?path=${encodeURIComponent(activeTab?.path || '')}`;
                        if (img.src !== fallbackSrc && !img.src.includes('/api/workspace/raw')) {
                          img.src = fallbackSrc;
                        } else {
                          setStatusNotice(`Failed to render image ${activeTab?.path}. Check if file is corrupt.`);
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            ) : !activeTab ? (
              <div className="welcome-surface">
                <div className="welcome-container">
                  {/* Antigravity / Cursor Hero Header */}
                  <div className="welcome-hero">
                    <div className="welcome-logo-glow">
                      <BrandMark size={56} radius={14} />
                    </div>
                    <div className="welcome-hero-text">
                      <div className="welcome-title-row">
                        <h1 className="welcome-title">DeepAutoCode</h1>
                        <span className="welcome-version-pill">v1.1 Agentic IDE</span>
                      </div>
                      <p className="welcome-subtitle">
                        {workspaceRoot
                          ? `Active Workspace: ${workspaceName} — Select a file from Explorer or press Ctrl+P to jump to code`
                          : 'AI-Native Agentic IDE — Open a local folder or connect to a remote SSH host to start building'}
                      </p>
                    </div>
                  </div>

                  {/* Primary Action Cards (3-Card Horizontal Grid like Cursor / Antigravity) */}
                  <div className="welcome-action-cards">
                    <button
                      type="button"
                      className="welcome-action-card primary"
                      onClick={() => void handleOpenProjectAction()}
                    >
                      <div className="welcome-card-top">
                        <span className="welcome-card-icon">📂</span>
                        <kbd className="welcome-kbd">Ctrl+O</kbd>
                      </div>
                      <div className="welcome-card-title">Open Folder</div>
                      <div className="welcome-card-desc">
                        Open a local repository or project directory
                      </div>
                    </button>

                    <button
                      type="button"
                      className="welcome-action-card"
                      onClick={() => void openSshConnectionModal()}
                    >
                      <div className="welcome-card-top">
                        <span className="welcome-card-icon">🌐</span>
                        <kbd className="welcome-kbd">Ctrl+Alt+O</kbd>
                      </div>
                      <div className="welcome-card-title">Connect via SSH</div>
                      <div className="welcome-card-desc">
                        Develop on a remote Linux server or GPU cluster
                      </div>
                    </button>

                    <button
                      type="button"
                      className="welcome-action-card"
                      onClick={() => openSettingsCenter('models')}
                    >
                      <div className="welcome-card-top">
                        <span className="welcome-card-icon">🤖</span>
                        <kbd className="welcome-kbd">Ctrl+Shift+J</kbd>
                      </div>
                      <div className="welcome-card-title">Configure AI Models</div>
                      <div className="welcome-card-desc">
                        Set up DeepSeek, OpenAI-Compatible, or Claude keys
                      </div>
                    </button>
                  </div>

                  {/* Two-Column Bottom Section: Recent Workspaces & Keyboard Shortcuts */}
                  <div className="welcome-bottom-grid">
                    {/* Left Column: Recent Workspaces & SSH Hosts */}
                    <div className="welcome-section">
                      <div className="welcome-section-header">
                        <span>Recent Workspaces & Remote Hosts</span>
                        {((ideSettings.recentWorkspaces ?? []).length > 0 ||
                          sshProfiles.length > 0) && (
                          <span className="welcome-section-count">
                            {(ideSettings.recentWorkspaces ?? []).length + sshProfiles.length}
                          </span>
                        )}
                      </div>
                      {(ideSettings.recentWorkspaces ?? []).length === 0 &&
                      sshProfiles.length === 0 ? (
                        <div className="welcome-empty-recent">
                          No recent workspaces yet. Choose <strong>Open Folder</strong> or{' '}
                          <strong>Connect via SSH</strong> above to open your first project.
                        </div>
                      ) : (
                        <div className="welcome-recent-list">
                          {(ideSettings.recentWorkspaces ?? []).slice(0, 5).map((ws: string) => {
                            const folderLabel = ws.split(/[\\/]/).pop() || ws;
                            return (
                              <div
                                key={ws}
                                className="welcome-recent-item"
                                onClick={() => void switchProjectFolder(ws)}
                              >
                                <div className="welcome-recent-main">
                                  <span className="welcome-recent-badge local">LOCAL</span>
                                  <span className="welcome-recent-name">{folderLabel}</span>
                                </div>
                                <div className="welcome-recent-path" title={ws}>
                                  {ws}
                                </div>
                              </div>
                            );
                          })}
                          {sshProfiles.slice(0, 3).map((prof: any) => (
                            <div
                              key={prof.id || `${prof.host}:${prof.remotePath}`}
                              className="welcome-recent-item"
                              onClick={() => void openSshConnectionModal()}
                            >
                              <div className="welcome-recent-main">
                                <span className="welcome-recent-badge ssh">SSH</span>
                                <span className="welcome-recent-name">
                                  {prof.name || `${prof.username}@${prof.host}`}
                                </span>
                              </div>
                              <div className="welcome-recent-path">
                                {prof.username}@{prof.host}:{prof.remotePath}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Right Column: Quick Shortcuts & Essential Commands */}
                    <div className="welcome-section">
                      <div className="welcome-section-header">
                        <span>Quick Shortcuts & Navigation</span>
                      </div>
                      <div className="welcome-shortcuts-list">
                        <div
                          className="welcome-shortcut-row"
                          onClick={() => setShowPalette(true)}
                        >
                          <span>Command Palette</span>
                          <kbd className="welcome-kbd">Ctrl+Shift+P</kbd>
                        </div>
                        <div
                          className="welcome-shortcut-row"
                          onClick={() => setShowRightAiDock((v) => !v)}
                        >
                          <span>Toggle AI Agent Dock</span>
                          <kbd className="welcome-kbd">Ctrl+L</kbd>
                        </div>
                        <div
                          className="welcome-shortcut-row"
                          onClick={() => setShowBottomPanel((v) => !v)}
                        >
                          <span>Toggle Terminal & Output</span>
                          <kbd className="welcome-kbd">Ctrl+`</kbd>
                        </div>
                        <div
                          className="welcome-shortcut-row"
                          onClick={() => setShowLeftSidebar((v) => !v)}
                        >
                          <span>Toggle Project Explorer</span>
                          <kbd className="welcome-kbd">Ctrl+B</kbd>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                {/* Antigravity Inline Code Lenses & Quick Symbol Bar */}
                <div className="ag-codelens-bar">
                  <div className="ag-codelens-actions">
                    <span className="ag-codelens-label">⚡ CodeLens (Ln {cursorPos.line}):</span>
                    <button
                      type="button"
                      className="ag-codelens-btn"
                      onClick={() =>
                        handleInlineCommandSubmit(
                          `Explain the logic and invariants around line ${cursorPos.line} in ${activeTab?.path}`
                        )
                      }
                    >
                      ✨ Explain
                    </button>
                    <button
                      type="button"
                      className="ag-codelens-btn"
                      onClick={() =>
                        handleInlineCommandSubmit(
                          `Refactor and optimize the function around line ${cursorPos.line} in ${activeTab?.path}`
                        )
                      }
                    >
                      🛠️ Refactor
                    </button>
                    <button
                      type="button"
                      className="ag-codelens-btn"
                      onClick={() =>
                        handleInlineCommandSubmit(
                          `Write unit/verification tests for the code around line ${cursorPos.line} in ${activeTab?.path}`
                        )
                      }
                    >
                      🧪 Write Tests
                    </button>
                    <button
                      type="button"
                      className="ag-codelens-btn"
                      onClick={() => setShowInlineCommand((v) => !v)}
                    >
                      ⌨️ Inline Command (Ctrl+I)
                    </button>
                  </div>
                </div>

                {/* Antigravity Floating Inline Command Bar (Ctrl+I) */}
                {showInlineCommand && (
                  <div className="ag-inline-command-widget">
                    <div className="ag-inline-command-header">
                      <span>
                        ✨ <strong>Antigravity Inline Command</strong> —{' '}
                        <code>
                          {activeTab?.path}:{cursorPos.line}
                        </code>
                      </span>
                      <button
                        type="button"
                        className="icon-btn"
                        style={{ padding: '1px 6px' }}
                        onClick={() => setShowInlineCommand(false)}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="ag-inline-command-row">
                      <input
                        autoFocus
                        className="settings-input"
                        style={{ flex: 1, fontSize: 12.5 }}
                        placeholder="Instruct AI to edit, refactor, document, or explain this code section (Enter to run, Esc to close)..."
                        value={inlineCommandInput}
                        onChange={(e) => setInlineCommandInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleInlineCommandSubmit();
                          } else if (e.key === 'Escape') {
                            setShowInlineCommand(false);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => handleInlineCommandSubmit()}
                      >
                        Run ⏎
                      </button>
                    </div>
                  </div>
                )}

              <div
                className={`ag-code-editor-surface ${
                  ideSettings.editor?.minimap !== false ? 'with-minimap' : ''
                }`}
                style={
                  {
                    '--editor-font-size': `${ideSettings.editor?.fontSize ?? 13}px`,
                  } as React.CSSProperties
                }
              >
                {/* Synchronized Line Gutter with Active Line Highlight & Fold Chevrons */}
                <div className="ag-line-gutter" ref={codeGutterRef}>
                  {codeLines.map((lineText, idx) => {
                    const lineNumber = idx + 1;
                    const isActive = cursorPos.line === lineNumber;
                    const isFoldable =
                      /(\{\s*$|<\w+[^/>]*>\s*$)/.test(lineText.trim()) &&
                      !lineText.trim().startsWith('//');
                    return (
                      <div
                        key={idx}
                        className={`ag-gutter-row ${isActive ? 'active' : ''}`}
                      >
                        <span className="ag-gutter-num">{lineNumber}</span>
                        <span className="ag-gutter-fold">{isFoldable ? '▾' : ''}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Live Syntax-Highlighted Code Layer + Transparent Editable Textarea */}
                <div className="ag-code-stage">
                  <div
                    className="ag-code-highlight-layer"
                    ref={codeHighlightRef}
                    aria-hidden="true"
                  >
                    {codeLines.map((line, idx) =>
                      renderSyntaxHighlightedLine(
                        line,
                        idx,
                        cursorPos.line === idx + 1
                      )
                    )}
                  </div>
                  <textarea
                    ref={codeTextareaRef}
                    className="ag-code-textarea"
                    spellCheck={false}
                    wrap="off"
                    value={activeTab?.content ?? ''}
                    onScroll={(e) => {
                      const target = e.currentTarget;
                      if (codeGutterRef.current) {
                        codeGutterRef.current.scrollTop = target.scrollTop;
                      }
                      if (codeHighlightRef.current) {
                        codeHighlightRef.current.scrollTop = target.scrollTop;
                        codeHighlightRef.current.scrollLeft = target.scrollLeft;
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Tab' && ghostText) {
                        e.preventDefault();
                        const textarea = e.currentTarget;
                        const pos = textarea.selectionStart;
                        const oldVal = textarea.value;
                        const newVal = oldVal.slice(0, pos) + ghostText + oldVal.slice(pos);
                        setTabs((prev) =>
                          prev.map((t) => (t.path === activeTabPath ? { ...t, content: newVal } : t))
                        );
                        const newPos = pos + ghostText.length;
                        setGhostText('');
                        setTimeout(() => {
                          textarea.selectionStart = newPos;
                          textarea.selectionEnd = newPos;
                        }, 0);
                        setStatusNotice('Accepted Ghost Text Autocomplete (Tab ⇥)');
                        return;
                      }
                      if (e.key === 'Escape' && ghostText) {
                        setGhostText('');
                        return;
                      }
                    }}
                    onChange={(e) => {
                      const val = e.target.value;
                      const selStart = e.currentTarget.selectionStart;
                      setTabs((prev) =>
                        prev.map((t) =>
                          t.path === activeTabPath ? { ...t, content: val } : t
                        )
                      );
                      triggerDebouncedGhostAutocomplete(val, selStart);
                    }}
                    onKeyUp={(e) => {
                      const target = e.currentTarget;
                      const upto = target.value.slice(0, target.selectionStart);
                      const lines = upto.split('\n');
                      setCursorPos({
                        line: lines.length,
                        col: (lines[lines.length - 1]?.length ?? 0) + 1,
                      });
                      triggerDebouncedGhostAutocomplete(target.value, target.selectionStart);
                    }}
                    onClick={(e) => {
                      const target = e.target as HTMLTextAreaElement;
                      const upto = target.value.slice(0, target.selectionStart);
                      const lines = upto.split('\n');
                      setCursorPos({
                        line: lines.length,
                        col: (lines[lines.length - 1]?.length ?? 0) + 1,
                      });
                      triggerDebouncedGhostAutocomplete(target.value, target.selectionStart);
                    }}
                  />
                </div>

                {/* Antigravity Right Minimap Rail */}
                {ideSettings.editor?.minimap !== false && (
                  <aside className="ag-minimap" aria-hidden="true">
                    <div className="ag-minimap-viewport" />
                    {codeLines.slice(0, 140).map((line, idx) => {
                      const indent = Math.min(24, (line.match(/^\s*/)?.[0]?.length ?? 0) * 1.5);
                      const len = Math.min(46, Math.max(4, line.trim().length * 0.75));
                      const isComment = line.trim().startsWith('//') || line.trim().startsWith('/*');
                      const isKw = /^(import|export|function|class|const|let|return)\b/.test(
                        line.trim()
                      );
                      return (
                        <div
                          key={idx}
                          className={`ag-minimap-line ${
                            cursorPos.line === idx + 1 ? 'active' : ''
                          }`}
                        >
                          {line.trim().length > 0 && (
                            <span
                              className={`ag-minimap-bar ${
                                isComment ? 'comment' : isKw ? 'kw' : ''
                              }`}
                              style={{ marginLeft: indent, width: len }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </aside>
                )}
              </div>
              </div>
            )}
          </div>

          {/* Resizable Horizontal Sash between Editor and Bottom Terminal Panel */}
          <div
            className={`resizer-row ${draggingSash === 'bottom' ? 'dragging' : ''}`}
            style={{ display: showBottomPanel ? 'block' : 'none' }}
            title="Drag to resize Bottom Terminal Panel"
            onMouseDown={(e) => startPaneResize('bottom', e)}
          />

          {/* Bottom Integrated Panel (Terminal / Security Audit / Runtime Output / Problems) */}
          <section
            className="bottom-panel"
            style={{ display: showBottomPanel ? 'flex' : 'none' }}
          >
            <div className="bottom-panel-header">
              <div className="bottom-tabs">
                {[
                  { id: 'terminal', label: 'Terminal' },
                  { id: 'audit', label: 'Security & Capability Audit' },
                  { id: 'output', label: `Runtime Output (${runtimeLogs.length})` },
                  { id: 'problems', label: 'Problems (0)' },
                ].map((t) => (
                  <div
                    key={t.id}
                    className={`bottom-tab ${activeBottomTab === t.id ? 'active' : ''}`}
                    onClick={() => setActiveBottomTab(t.id as any)}
                  >
                    {t.label}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn"
                  onClick={() => void handleRunTerminalCommand('node -v && git status -s')}
                >
                  Run Quick Check
                </button>
                <button className="icon-btn" onClick={() => setShowBottomPanel(false)}>
                  ✕
                </button>
              </div>
            </div>

            {activeBottomTab === 'terminal' && (
              <div className="terminal-body">
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  {terminalHistory.map((item) => (
                    <div key={item.id} style={{ marginBottom: 8 }}>
                      <div style={{ color: 'var(--accent-bright)' }}>
                        PS {workspaceRoot}&gt;{' '}
                        <span style={{ color: 'var(--text-heading)', fontWeight: 600 }}>{item.cmd}</span>{' '}
                        <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                          (exit={item.exitCode}, {item.durationMs}ms)
                        </span>
                      </div>
                      <pre style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap', marginTop: 2 }}>
                        {item.output}
                      </pre>
                    </div>
                  ))}
                </div>
                <div className="terminal-input-row">
                  <span style={{ color: '#3fb950' }}>PS {workspaceName}&gt;</span>
                  <input
                    placeholder="Type shell command (e.g. node -v, git status, npm test) and press Enter..."
                    value={terminalInput}
                    onChange={(e) => setTerminalInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void handleRunTerminalCommand();
                      }
                    }}
                  />
                </div>
              </div>
            )}

            {activeBottomTab === 'audit' && (
              <div className="terminal-body">
                <pre style={{ color: '#93c5fd', whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(
                    diagnosticsDump ??
                      backendStatus ?? {
                        tip: 'Click 🛡️ or Help -> Export Redacted Security Diagnostics to view full Capability Audit Log',
                      },
                    null,
                    2
                  )}
                </pre>
              </div>
            )}

            {activeBottomTab === 'output' && (
              <div className="terminal-body">
                {runtimeLogs.map((l, idx) => (
                  <div key={idx} style={{ color: '#8b949e', lineHeight: 1.5 }}>
                    {l}
                  </div>
                ))}
              </div>
            )}

            {activeBottomTab === 'problems' && (
              <div
                className="terminal-body"
                style={{
                  color: '#3fb950',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <span>✓ No TypeScript or workspace security policy violations detected.</span>
                <button
                  className="btn primary"
                  style={{ padding: '4px 10px', fontSize: 11.5 }}
                  onClick={() =>
                    void handleSendPrompt(
                      'Check all issues in the current project (code defects, build configs, and failing tests), directly apply fixes to the project files, and automatically build and run verification tests.',
                      'auto'
                    )
                  }
                >
                  🛠️ Auto-Fix All Issues
                </button>
              </div>
            )}
          </section>
        </main>

        {/* Resizable Sash between Center Editor and Right AI Composer Dock */}
        <div
          className={`resizer-col ${draggingSash === 'right' ? 'dragging' : ''}`}
          style={{ display: showRightAiDock ? 'block' : 'none' }}
          title="Drag to resize Right AI Agent Dock"
          onMouseDown={(e) => startPaneResize('right', e)}
        />

        {/* Pane D: Right Docked AI Agent & Composer Panel */}
        <aside className="ai-dock" style={{ display: showRightAiDock ? 'flex' : 'none' }}>
          <div className="ai-dock-header">
            <div className="ai-dock-tabs">
              <button
                type="button"
                className={`ai-dock-tab ${aiTab === 'composer' ? 'active' : ''}`}
                onClick={() => setAiTab('composer')}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <BrandMark size={14} radius={3} />
                  <span>Agent</span>
                </span>
              </button>
              <button
                type="button"
                className={`ai-dock-tab ${aiTab === 'artifacts' ? 'active' : ''}`}
                onClick={() => {
                  setAiTab('artifacts');
                  void refreshArtifactsAndCustomizations();
                }}
              >
                <span>📑 Artifacts</span>
                <span className="ai-dock-count">{artifactsList.length}</span>
              </button>
              <button
                type="button"
                className={`ai-dock-tab ${aiTab === 'sessions' ? 'active' : ''}`}
                onClick={() => setAiTab('sessions')}
              >
                <span>🕒 History</span>
                <span className="ai-dock-count">{sessions.length}</span>
              </button>
            </div>
            <div className="ai-dock-actions">
              <button
                className="icon-btn"
                title="AI Agent & Model Settings"
                onClick={() => openSettingsCenter('models')}
              >
                ⚙️
              </button>
              <button
                className="btn primary"
                style={{ padding: '3px 9px', fontSize: 11.5 }}
                onClick={() => void handleCreateSession()}
              >
                + New
              </button>
            </div>
          </div>

          {aiTab === 'artifacts' ? (
            <div className="ai-messages-stream">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 700 }}>
                  Antigravity Plans & Artifacts ({artifactsList.length})
                </span>
                <button
                  type="button"
                  className="btn primary"
                  style={{ padding: '3px 9px', fontSize: 11.5 }}
                  onClick={() => {
                    setAiTab('composer');
                    void handleSendPrompt(
                      '/plan Analyze the active workspace and create a structured step-by-step Implementation Plan artifact.',
                      'plan'
                    );
                  }}
                >
                  + Generate Plan (/plan)
                </button>
              </div>

              {artifactsList.length === 0 ? (
                <div className="ai-empty-state">
                  <div className="ai-empty-title">No Artifacts Yet</div>
                  <div className="ai-empty-desc">
                    Use <code>/plan</code> or click <strong>+ Generate Plan (/plan)</strong> above to generate an Antigravity Implementation Plan, Task Checklist, or Walkthrough.
                  </div>
                </div>
              ) : (
                artifactsList.map((art: any) => (
                  <div key={art.id} className="chat-bubble assistant">
                    <div className="chat-bubble-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="badge info">
                          {String(art.artifactType || 'plan').toUpperCase()}
                        </span>
                        <strong>{art.title}</strong>
                      </div>
                      {art.artifactType === 'plan' && (
                        <button
                          type="button"
                          className="btn success"
                          style={{ padding: '3px 9px', fontSize: 11 }}
                          onClick={() => {
                            setAiTab('composer');
                            void handleSendPrompt(
                              `Execute the approved Implementation Plan "${art.title}" step by step, apply the code changes via edit_file/write_file, and run build & verification tests:\n\n${art.content}`,
                              'auto'
                            );
                          }}
                        >
                          ▶ Proceed & Execute Plan
                        </button>
                      )}
                    </div>
                    <div style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
                      {renderFormattedMarkdown(String(art.content || ''), art.id, 'assistant')}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : aiTab === 'sessions' ? (
            <div className="ai-messages-stream">
              {sessions.map((s) => (
                <div
                  key={s.sessionId}
                  className="chat-bubble"
                  style={{
                    cursor: 'pointer',
                    borderColor:
                      s.sessionId === activeSessionId ? 'var(--accent-bright)' : 'var(--border)',
                  }}
                  onClick={() => {
                    void selectAndResumeSession(s.sessionId);
                    setAiTab('composer');
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>{s.title}</div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 11,
                      color: '#8b949e',
                    }}
                  >
                    <span>Status: {s.status}</span>
                    <span>Mode: {s.executionMode}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="ai-messages-stream">
                {messages.length === 0 && !isSendingPrompt && !streamingText && (
                  <div className="ai-empty-state">
                    <div className="ai-empty-hero">
                      <BrandMark size={34} radius={8} />
                      <div className="ai-empty-title">DeepAutoCode Agent</div>
                      <div className="ai-empty-desc">
                        Ask questions about the codebase, inspect architecture, or automatically edit, build, and verify changes.
                      </div>
                    </div>
                    <div className="ai-quick-actions-grid">
                      <button
                        type="button"
                        className="ai-quick-card"
                        onClick={() =>
                          void handleSendPrompt(
                            'Analyze the architecture, entry points, and core modules of this workspace.',
                            'plan'
                          )
                        }
                      >
                        <span className="ai-quick-icon">🔍</span>
                        <div>
                          <div className="ai-quick-label">Analyze Architecture</div>
                          <div className="ai-quick-sub">Read-only overview of modules & entry points</div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="ai-quick-card"
                        onClick={() =>
                          void handleSendPrompt(
                            'Check all issues in the current project (code defects, build configs, and failing tests), directly apply fixes to the project files, and automatically build and run verification tests.',
                            'auto'
                          )
                        }
                      >
                        <span className="ai-quick-icon">🛠️</span>
                        <div>
                          <div className="ai-quick-label">Auto-Fix All Issues</div>
                          <div className="ai-quick-sub">Inspect, patch files, and run verification</div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="ai-quick-card"
                        onClick={() =>
                          void handleSendPrompt(
                            `Read ${
                              activeTab?.kind === 'code'
                                ? activeTab.path
                                : files[0] || 'package.json'
                            }`
                          )
                        }
                      >
                        <span className="ai-quick-icon">📖</span>
                        <div>
                          <div className="ai-quick-label">Read Active File</div>
                          <div className="ai-quick-sub">Summarize and review current editor tab</div>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="ai-quick-card"
                        onClick={() => void handleSendPrompt('Build and run verification tests', 'auto')}
                      >
                        <span className="ai-quick-icon">🚀</span>
                        <div>
                          <div className="ai-quick-label">Build & Run</div>
                          <div className="ai-quick-sub">Compile project and execute test suite</div>
                        </div>
                      </button>
                    </div>
                  </div>
                )}

                {messages.map((m, msgIdx) => {
                  const completedSteps = Array.isArray(m.toolCalls)
                    ? m.toolCalls.length
                    : 0;
                  const stepSummaryText =
                    completedSteps > 0
                      ? m.toolCalls
                          .slice(0, 4)
                          .map((tc: any) => formatToolStepLabel(tc))
                          .join(' → ') +
                        (completedSteps > 4 ? ` (+${completedSteps - 4} more)` : '')
                      : '';
                  const prevUserMsgContent =
                    msgIdx > 0 ? String(messages[msgIdx - 1]?.content || '') : '';
                  const wasTriggeredByAutoFixButton =
                    prevUserMsgContent.includes('请按你上面分析定位的根因与方案') ||
                    prevUserMsgContent.includes('Apply the root-cause analysis') ||
                    prevUserMsgContent.includes('[FORCE_AUTO_ACTION]');
                  const alreadyExecutedWriteOrBuild = Boolean(
                    m.toolCalls?.some((tc: any) =>
                      [
                        'edit_file',
                        'write_file',
                        'editor',
                        'write-file',
                        'reveal-diff',
                        'run-build',
                        'run_command',
                        'auto_build_and_test',
                      ].includes(String(tc?.toolName || ''))
                    )
                  );
                  const alreadyReportsCompletedFix =
                    /(?:🛠️\s*\*{0,2}(?:修改内容|Changes)|✅\s*\*{0,2}(?:验证结果|Verification))/.test(
                      String(m.content || '')
                    );
                  const canOfferOneClickAutoFix =
                    m.role === 'assistant' &&
                    msgIdx === messages.length - 1 &&
                    !isSendingPrompt &&
                    typeof m.content === 'string' &&
                    m.content.length > 40 &&
                    !wasTriggeredByAutoFixButton &&
                    !alreadyExecutedWriteOrBuild &&
                    !alreadyReportsCompletedFix;

                  return (
                    <div key={m.id} className={`chat-bubble ${m.role}`}>
                      <div className="chat-bubble-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              fontWeight: 700,
                              color: m.role === 'user' ? '#93c5fd' : '#60a5fa',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 5,
                            }}
                          >
                            {m.role === 'user' ? (
                              '👤 YOU'
                            ) : (
                              <>
                                <BrandMark size={14} radius={3} />
                                <span>DEEPAUTOCODE AI</span>
                              </>
                            )}
                          </span>
                          {m.role === 'assistant' && (
                            <span className="badge info" style={{ fontSize: 9.5 }}>
                              {modelInput}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button
                            className="btn"
                            style={{ padding: '1px 6px', fontSize: 10 }}
                            title="Copy message content to clipboard"
                            onClick={() => {
                              void navigator.clipboard.writeText(String(m.content ?? ''));
                              setStatusNotice('Copied AI message to clipboard');
                            }}
                          >
                            📋 Copy
                          </button>
                          <span>#{m.sequence}</span>
                        </div>
                      </div>

                      {completedSteps > 0 && (
                        <div
                          className="progress-summary-pill"
                          style={{ marginTop: 0, marginBottom: 8 }}
                        >
                          <span style={{ color: '#4ade80', fontWeight: 600 }}>
                            ✓ Completed {completedSteps} file/tool action(s)
                          </span>
                          <span
                            style={{
                              color: '#8b949e',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 260,
                            }}
                            title={stepSummaryText}
                          >
                            {stepSummaryText}
                          </span>
                        </div>
                      )}

                      <div style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
                        {renderFormattedMarkdown(m.content, m.id, m.role)}
                      </div>

                      {canOfferOneClickAutoFix && (
                          <div
                            style={{
                              marginTop: 8,
                              paddingTop: 6,
                              borderTop: '1px dashed var(--border)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'flex-end',
                              gap: 8,
                            }}
                          >
                            <button
                              className="btn primary"
                              style={{ fontSize: 11.5, padding: '3px 10px' }}
                              title="Automatically apply the fixes identified above and run build & verification tests"
                              onClick={() =>
                                void handleSendPrompt(
                                  'Apply the root-cause analysis and fix plan above: immediately call edit_file to modify the target source files, and run auto_build_and_test (or run_command) to verify the build and tests.',
                                  'auto'
                                )
                              }
                            >
                              🛠️ Apply Fix & Verify
                            </button>
                          </div>
                        )}
                    </div>
                  );
                })}

                {(isSendingPrompt || liveToolCalls.length > 0) && (
                  <div className="progress-live-card">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ fontWeight: 600, color: '#93c5fd' }}>
                        {liveToolCalls.length > 0
                          ? `⏳ Processing workspace files (${
                              liveToolCalls.filter((t) => t.status === 'completed').length
                            }/${liveToolCalls.length})`
                          : `⏳ Analyzing workspace (${modelInput})...`}
                      </span>
                      <span className="badge info">
                        {liveToolCalls.length > 0
                          ? formatToolStepLabel(liveToolCalls[liveToolCalls.length - 1])
                          : 'PROCESSING'}
                      </span>
                    </div>
                    <div className="progress-bar-track">
                      <div
                        className="progress-bar-fill"
                        style={{
                          width:
                            liveToolCalls.length > 0
                              ? `${Math.min(
                                  95,
                                  Math.max(
                                    25,
                                    Math.round(
                                      (liveToolCalls.filter((t) => t.status === 'completed')
                                        .length /
                                        liveToolCalls.length) *
                                        100
                                    )
                                  )
                                )}%`
                              : '45%',
                        }}
                      />
                    </div>
                  </div>
                )}

                {streamingText && (
                  <div className="chat-bubble assistant">
                    <div className="chat-bubble-header">
                      <span
                        style={{
                          fontWeight: 700,
                          color: '#60a5fa',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                        }}
                      >
                        <BrandMark size={14} radius={3} />
                        <span>DEEPAUTOCODE AI (Generating...)</span>
                      </span>
                    </div>
                    <div>{renderFormattedMarkdown(streamingText)}</div>
                  </div>
                )}

                {pendingApprovals.map((appr) => (
                  <div key={appr.approvalId} className="approval-banner">
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <strong>🛡️ Approval Required: {appr.toolName}</strong>
                      <span className="badge danger">{appr.risk.toUpperCase()} RISK</span>
                    </div>
                    <div style={{ fontSize: 12 }}>{appr.summary}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn success"
                        onClick={() => void handleApprovalDecision(appr.approvalId, true)}
                      >
                        Approve Execution
                      </button>
                      <button
                        className="btn danger"
                        onClick={() => void handleApprovalDecision(appr.approvalId, false)}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
                <div ref={aiMessagesEndRef} />
              </div>

              <div className="composer-box">
                <div className="context-pills">
                  {(() => {
                    const uiIntent = detectUiPromptIntent(promptInput);
                    const activeChoice: 'query-only' | 'auto-action' =
                      manualIntentChoice === 'query-only' || manualIntentChoice === 'auto-action'
                        ? manualIntentChoice
                        : uiIntent.isQueryOnly
                          ? 'query-only'
                          : 'auto-action';
                    const isQueryActive = activeChoice === 'query-only';
                    const isAutoActionActive = activeChoice === 'auto-action';

                    return (
                      <>
                        <span
                          className="intent-mode-chip"
                          data-tooltip="🔍 Query & Analysis Only (Read-Only)"
                          title="🔍 Query & Analysis Only (Read-Only)"
                          style={{
                            background: isQueryActive
                              ? 'rgba(14, 165, 233, 0.22)'
                              : 'rgba(14, 165, 233, 0.06)',
                            color: isQueryActive ? '#38bdf8' : 'var(--text-muted)',
                            border: isQueryActive
                              ? '1px solid #0284c7'
                              : '1px solid rgba(14, 165, 233, 0.22)',
                            opacity: isQueryActive ? 1 : 0.72,
                          }}
                          onClick={() => {
                            setManualIntentChoice((prev) => {
                              const next = prev === 'query-only' ? null : 'query-only';
                              if (next === 'query-only') setExecutionMode('plan');
                              return next;
                            });
                          }}
                        >
                          <span>🔍</span>
                          <span>Query Only</span>
                        </span>

                        <span
                          className="intent-mode-chip"
                          data-tooltip="🛠️ Auto-Edit + Build & Verify"
                          title="🛠️ Auto-Edit + Build & Verify"
                          style={{
                            background: isAutoActionActive
                              ? 'rgba(16, 185, 129, 0.22)'
                              : 'rgba(16, 185, 129, 0.06)',
                            color: isAutoActionActive ? '#34d399' : 'var(--text-muted)',
                            border: isAutoActionActive
                              ? '1px solid #059669'
                              : '1px solid rgba(16, 185, 129, 0.22)',
                            opacity: isAutoActionActive ? 1 : 0.72,
                          }}
                          onClick={() => {
                            setManualIntentChoice((prev) => {
                              const next = prev === 'auto-action' ? null : 'auto-action';
                              if (next === 'auto-action') setExecutionMode('auto');
                              return next;
                            });
                          }}
                        >
                          <span>🛠️</span>
                          <span>Auto-Edit & Verify</span>
                        </span>

                        <span
                          className="intent-mode-chip"
                          title="Insert / Slash Workflow (/plan, /goal, /fix, /review, /test)"
                          style={{
                            background: 'var(--bg-card)',
                            border: '1px solid var(--border)',
                            color: 'var(--text-secondary)',
                          }}
                          onClick={() =>
                            setPromptInput((prev) => (prev.startsWith('/') ? prev : `/${prev}`))
                          }
                        >
                          <span>/</span>
                          <span>Workflows</span>
                        </span>

                        <span
                          className="intent-mode-chip"
                          title="Attach @ Context (@git, @terminal, @rules, @file)"
                          style={{
                            background: 'var(--bg-card)',
                            border: '1px solid var(--border)',
                            color: 'var(--text-secondary)',
                          }}
                          onClick={() =>
                            setPromptInput((prev) =>
                              prev.endsWith('@') ? prev : `${prev}${prev ? ' ' : ''}@`
                            )
                          }
                        >
                          <span>@</span>
                          <span>Context</span>
                        </span>
                      </>
                    );
                  })()}
                </div>

                {/* Antigravity Interactive / Slash Commands & @ Context Mentions Popup */}
                {(() => {
                  const trimmedStart = promptInput.trimStart();
                  const slashMatch = trimmedStart.match(/^\/([a-zA-Z0-9_-]*)$/);
                  const mentionMatch = promptInput.match(/(?:^|\s)@([a-zA-Z0-9_./\\-]*)$/);

                  if (slashMatch) {
                    const q = slashMatch[1].toLowerCase();
                    const slashItems = [
                      {
                        cmd: '/browser',
                        desc: 'Autonomous web inspection, DOM testing & UI verification for running apps',
                      },
                      {
                        cmd: '/plan',
                        desc: 'Create a step-by-step Implementation Plan artifact before editing',
                      },
                      {
                        cmd: '/goal',
                        desc: 'Autonomous multi-step goal loop until build & verification tests pass',
                      },
                      {
                        cmd: '/fix',
                        desc: 'Inspect compiler/test diagnostics and auto-fix all issues',
                      },
                      {
                        cmd: '/review',
                        desc: 'Deep code review & security audit of active file and git diff',
                      },
                      {
                        cmd: '/test',
                        desc: 'Run or generate verification tests for the active module',
                      },
                      {
                        cmd: '/learn',
                        desc: 'Save project coding conventions to .agents/rules/',
                      },
                      {
                        cmd: '/compact',
                        desc: 'Summarize and compact conversation context',
                      },
                      ...workspaceCustomizations.workflows.map((w) => ({
                        cmd: w.name,
                        desc: w.description,
                      })),
                    ].filter((item) => item.cmd.slice(1).toLowerCase().includes(q));

                    if (slashItems.length > 0) {
                      return (
                        <div className="ag-composer-popup">
                          <div className="ag-composer-popup-title">
                            Antigravity Slash Workflows
                          </div>
                          {slashItems.map((item) => (
                            <div
                              key={item.cmd}
                              className="ag-composer-popup-item"
                              onClick={() => {
                                setPromptInput(`${item.cmd} `);
                              }}
                            >
                              <code>{item.cmd}</code>
                              <span>{item.desc}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }
                  }

                  if (mentionMatch) {
                    const q = mentionMatch[1].toLowerCase();
                    const builtinMentions = [
                      { tag: '@git', desc: 'Attach Git working tree status & diff' },
                      { tag: '@terminal', desc: 'Attach recent terminal command output' },
                      { tag: '@rules', desc: 'Attach workspace .agents/rules & AGENTS.md' },
                      { tag: '@problems', desc: 'Attach workspace compiler/linter diagnostics' },
                    ];
                    const fileMentions = files
                      .filter((f) => f.toLowerCase().includes(q))
                      .slice(0, 6)
                      .map((f) => ({ tag: `@${f}`, desc: 'Workspace file' }));
                    const allMentions = [
                      ...builtinMentions.filter((m) => m.tag.slice(1).includes(q)),
                      ...fileMentions,
                    ];

                    if (allMentions.length > 0) {
                      return (
                        <div className="ag-composer-popup">
                          <div className="ag-composer-popup-title">
                            Antigravity @ Context Mentions
                          </div>
                          {allMentions.map((item) => (
                            <div
                              key={item.tag}
                              className="ag-composer-popup-item"
                              onClick={() => {
                                setPromptInput((prev) =>
                                  prev.replace(/@([a-zA-Z0-9_./\\-]*)$/, `${item.tag} `)
                                );
                              }}
                            >
                              <code>{item.tag}</code>
                              <span>{item.desc}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }
                  }

                  return null;
                })()}

                <textarea
                  className="composer-textarea"
                  placeholder="Type / for workflows (/plan, /goal, /fix), @ to attach context (@git, @terminal, @file), or ask anything..."
                  value={promptInput}
                  onChange={(e) => {
                    if (manualIntentChoice === 'build-fix') {
                      setManualIntentChoice(null);
                    }
                    setPromptInput(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendPrompt();
                    }
                  }}
                />

                <div className="composer-footer">
                  <div className="composer-controls-left">
                    <select
                      className="composer-select"
                      value={executionMode}
                      onChange={(e) => setExecutionMode(e.target.value as any)}
                    >
                      <option value="auto">∞ Agent (Auto)</option>
                      <option value="plan">📖 Plan (Read)</option>
                      <option value="manual">🛡️ Manual</option>
                    </select>

                    <select
                      className="composer-select model"
                      value={modelInput}
                      onChange={(e) => setModelInput(e.target.value)}
                      title="AI Model Routing: deepseek-auto automatically routes file discovery & build turns to deepseek-chat and root-cause/self-heal turns to deepseek-reasoner"
                    >
                      <option value="deepseek-auto">⚡ deepseek-auto (Smart Router)</option>
                      <option value="deepseek-chat">deepseek-chat (Fast V3)</option>
                      <option value="deepseek-reasoner">deepseek-reasoner (Reasoning R1)</option>
                      <option value="qwen2.5-coder:14b">qwen2.5-coder</option>
                      <option value="claude-3-7-sonnet-latest">claude-3.7-sonnet</option>
                    </select>
                  </div>

                  <div className="composer-controls-right">
                    <button
                      className="btn danger"
                      onClick={() => activeSessionId && void bridge.cancelSession(activeSessionId)}
                    >
                      Stop
                    </button>
                    <button
                      className="btn primary"
                      disabled={isSendingPrompt || !promptInput.trim()}
                      onClick={() => void handleSendPrompt()}
                    >
                      Send ⏎
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>

      {/* 3. Modal: Open / Switch Project Folder */}
      {showProjectModal && (
        <div className="palette-backdrop" onClick={() => setShowProjectModal(false)}>
          <div className="palette-modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontWeight: 700 }}>
              📂 Open / Switch Project Workspace Folder
            </div>
            <div style={{ padding: 14 }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <input
                  className="settings-input"
                  style={{ flex: 1 }}
                  value={customFolderInput}
                  onChange={(e) => setCustomFolderInput(e.target.value)}
                  placeholder="Enter absolute path (e.g. E:\DeepAudoCode)"
                />
                <button
                  className="btn primary"
                  onClick={() => void switchProjectFolder(customFolderInput)}
                >
                  Open Folder
                </button>
              </div>
              <div style={{ fontSize: 11.5, color: '#8b949e', marginBottom: 8 }}>
                Recent Project Workspaces:
              </div>
              <div className="palette-list">
                {(ideSettings.recentWorkspaces ?? []).map((ws: string) => (
                  <div
                    key={ws}
                    className="palette-item"
                    onClick={() => void switchProjectFolder(ws)}
                  >
                    <span>📁 {ws}</span>
                    <span className="badge">Open</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. Modal: Create New File or Folder */}
      {showCreateModal && (
        <div className="palette-backdrop" onClick={() => setShowCreateModal(null)}>
          <div className="palette-modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontWeight: 700 }}>
              {showCreateModal === 'file' ? '📄 Create New File in Project' : '📁 Create New Folder in Project'}
            </div>
            <div style={{ padding: 14, display: 'flex', gap: 8 }}>
              <input
                autoFocus
                className="settings-input"
                style={{ flex: 1 }}
                value={createTargetName}
                onChange={(e) => setCreateTargetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateFileOrFolder();
                }}
              />
              <button className="btn primary" onClick={() => void handleCreateFileOrFolder()}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Modal: Command Palette (Ctrl+Shift+P) */}
      {showPalette && (
        <div className="palette-backdrop" onClick={() => setShowPalette(false)}>
          <div className="palette-modal" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="palette-input"
              placeholder="Type a command, setting, or file name..."
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
            />
            <div className="palette-list">
              {[
                {
                  label: 'Help: Open DeepAutoCode User Guide & Manual (使用说明中心)',
                  hint: 'F1',
                  run: () => openUserGuide('quickstart'),
                },
                {
                  label: 'Help: Quick Start & Project Setup (快速上手与项目打开)',
                  hint: 'Guide 1',
                  run: () => openUserGuide('quickstart'),
                },
                {
                  label: 'Help: Workbench Layout & Navigation (工作台布局说明)',
                  hint: 'Guide 2',
                  run: () => openUserGuide('workbench'),
                },
                {
                  label: 'Help: AI Execution Modes (Plan / Auto / Manual)',
                  hint: 'Guide 3',
                  run: () => openUserGuide('modes'),
                },
                {
                  label: 'Help: / Slash Workflows & @ Context Mentions',
                  hint: 'Guide 4',
                  run: () => openUserGuide('workflows'),
                },
                {
                  label: 'Help: Inline AI Command (Ctrl+I) & Code Lenses',
                  hint: 'Guide 5',
                  run: () => openUserGuide('inline'),
                },
                {
                  label: 'Help: Keyboard Shortcuts Reference (快捷键速查表)',
                  hint: 'Guide 8',
                  run: () => openUserGuide('shortcuts'),
                },
                {
                  label: 'Antigravity: Open Live Web Preview (http://localhost:3000/)',
                  hint: 'Preview',
                  run: () => openWebPreviewTab(),
                },
                {
                  label: 'Antigravity: Inline AI Edit / Explain Command',
                  hint: 'Ctrl+I',
                  run: () => setShowInlineCommand(true),
                },
                {
                  label: 'Antigravity: View Implementation Plans & Artifacts',
                  hint: 'Artifacts',
                  run: () => {
                    setShowRightAiDock(true);
                    setAiTab('artifacts');
                    void refreshArtifactsAndCustomizations();
                  },
                },
                {
                  label: 'Preferences: Toggle Dark / Light Color Theme',
                  hint: 'Theme',
                  run: () => toggleColorTheme(),
                },
                {
                  label: 'Remote-SSH: Connect to Remote Host / Manage SSH Connections...',
                  hint: 'Ctrl+Alt+O',
                  run: () => void openSshConnectionModal(),
                },
                {
                  label: 'Remote-SSH: Disconnect Current Remote SSH Host',
                  hint: 'SSH',
                  run: () => void handleDisconnectSshHost(),
                },
                {
                  label: 'Preferences: Open DeepAutoCode Settings (General & Project)',
                  hint: 'Ctrl+,',
                  run: () => openSettingsCenter('general'),
                },
                {
                  label: 'Preferences: Configure AI Models & Providers (DeepSeek / OpenAI)',
                  hint: 'Ctrl+Shift+J',
                  run: () => openSettingsCenter('models'),
                },
                {
                  label: 'Preferences: Agent Security & Approval Policies',
                  hint: 'Section 9',
                  run: () => openSettingsCenter('security'),
                },
                {
                  label: 'Preferences: Edit Project AI Rules (.deepautocode/rules)',
                  hint: 'Rules',
                  run: () => openSettingsCenter('rules'),
                },
                {
                  label: 'Preferences: MCP Servers & Host Capabilities',
                  hint: 'Appendix B',
                  run: () => openSettingsCenter('mcp'),
                },
                {
                  label: 'Project: Open / Switch Workspace Folder...',
                  hint: 'Ctrl+O',
                  run: () => void handleOpenProjectAction(),
                },
                {
                  label: 'Project: Create New File...',
                  hint: 'Ctrl+N',
                  run: () => {
                    setCreateTargetName('src/new-file.ts');
                    setShowCreateModal('file');
                  },
                },
                {
                  label: 'DeepAutoCode: Simulate Extension Host Restart (PoC-L2)',
                  hint: 'PoC-L2',
                  run: () => void handleSimulateExtensionHostRestart(),
                },
                {
                  label: 'DeepAutoCode: Export Redacted Security Diagnostics',
                  hint: 'Section 9.1',
                  run: () => void handleExportDiagnostics(),
                },
              ]
                .filter((item) =>
                  item.label.toLowerCase().includes(paletteQuery.toLowerCase())
                )
                .map((item) => (
                  <div
                    key={item.label}
                    className="palette-item"
                    onClick={() => {
                      setShowPalette(false);
                      item.run();
                    }}
                  >
                    <span>{item.label}</span>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>{item.hint}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* 5b. Modal: Remote - SSH Connection Manager (Visual Studio & Cursor Remote-SSH) */}
      {showSshModal && (
        <div className="palette-backdrop" onClick={() => setShowSshModal(false)}>
          <div className="ssh-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ssh-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 16 }}>🌐</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-heading)' }}>
                    Remote - SSH Connection Manager
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    Connect to remote Linux / macOS / Windows servers via OpenSSH (Cursor & Visual Studio Remote-SSH compatible)
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {sshStatus?.connected && (
                  <span className="badge success">
                    ● Connected: {sshStatus.activeProfile?.username}@{sshStatus.activeProfile?.host}
                  </span>
                )}
                <button className="btn" onClick={() => setShowSshModal(false)}>
                  ✕ Close
                </button>
              </div>
            </div>

            {/* Quick SSH Command Bar (Cursor style: ssh user@host -p 22) */}
            <div className="ssh-quick-bar">
              <span style={{ fontSize: 11.5, color: '#93c5fd', fontWeight: 600, whiteSpace: 'nowrap' }}>
                ⚡ Quick SSH Command:
              </span>
              <input
                className="settings-input"
                style={{ flex: 1, minWidth: 220 }}
                placeholder="e.g. ssh root@192.168.1.100 -p 22  or  ubuntu@10.0.0.5:/home/ubuntu/nccl"
                value={sshQuickCmd}
                onChange={(e) => setSshQuickCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') parseQuickSshCommand();
                }}
              />
              <button className="btn" onClick={() => parseQuickSshCommand()}>
                Parse & Fill
              </button>
            </div>

            <div className="ssh-modal-body">
              {/* Left Column: Discovered ~/.ssh/config + Saved SSH Profiles */}
              <div className="ssh-host-list">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#8b949e' }}>
                    SSH TARGETS ({sshProfiles.length})
                  </span>
                  <button
                    className="btn"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() => {
                      setSshForm({
                        id: undefined,
                        name: 'New SSH Server',
                        host: '10.0.62.83',
                        port: 22,
                        username: 'root',
                        authMethod: 'password',
                        password: '',
                        identityFile: '~/.ssh/id_rsa',
                        remotePath: '/root',
                      });
                      setSshTestResult(null);
                      setSshBrowseData(null);
                    }}
                  >
                    + Add Host
                  </button>
                </div>

                {sshProfiles.length === 0 && (
                  <div style={{ fontSize: 11.5, color: '#6b7280', padding: '12px 4px' }}>
                    No saved hosts or ~/.ssh/config entries found yet. Fill in the connection form on the right.
                  </div>
                )}

                {sshProfiles.map((p) => {
                  const isSelected =
                    (sshForm.id && sshForm.id === p.id) ||
                    (sshForm.host === p.host &&
                      sshForm.username === p.username &&
                      sshForm.remotePath === p.remotePath);
                  return (
                    <div
                      key={p.id}
                      className={`ssh-host-card ${isSelected ? 'active' : ''}`}
                      onClick={() => {
                        setSshForm({
                          id: p.id,
                          name: p.name || `${p.username}@${p.host}`,
                          host: p.host,
                          port: p.port || 22,
                          username: p.username || 'root',
                          authMethod: p.authMethod || 'password',
                          password: p.password || '',
                          identityFile: p.identityFile || '~/.ssh/id_rsa',
                          remotePath: p.remotePath || '~',
                        });
                        setSshTestResult(null);
                        setSshBrowseData(null);
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <strong style={{ fontSize: 12.5, color: 'var(--text-heading)' }}>
                          🖥️ {p.name}
                        </strong>
                        <span
                          className={`badge ${p.source === 'ssh-config' ? 'info' : 'success'}`}
                          style={{ fontSize: 9.5 }}
                        >
                          {p.source === 'ssh-config' ? '~/.ssh/config' : 'SAVED'}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                        {p.username}@{p.host}:{p.port}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          fontSize: 10.5,
                          color: '#60a5fa',
                        }}
                      >
                        <span>📁 {p.remotePath}</span>
                        {p.source === 'user' && (
                          <span
                            style={{ color: '#f87171', cursor: 'pointer' }}
                            title="Delete saved SSH host"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteSshProfile(p.id);
                            }}
                          >
                            Delete
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Right Column: Visual Studio Connection Manager Configuration & Test */}
              <div className="ssh-form-pane">
                <div className="ssh-form-grid">
                  <div className="ssh-field">
                    <label>Connection Alias / Label</label>
                    <input
                      className="settings-input"
                      style={{ minWidth: 'unset', width: '100%' }}
                      value={sshForm.name}
                      onChange={(e) => setSshForm({ ...sshForm, name: e.target.value })}
                      placeholder="e.g. GPU Cluster A100"
                    />
                  </div>
                  <div className="ssh-field">
                    <label>Authentication Mode</label>
                    <select
                      className="settings-select"
                      style={{ minWidth: 'unset', width: '100%' }}
                      value={sshForm.authMethod}
                      onChange={(e) =>
                        setSshForm({ ...sshForm, authMethod: e.target.value as any })
                      }
                    >
                      <option value="password">
                        🔒 Password / SSH Key (Auto-deploy Public Key)
                      </option>
                      <option value="agent-or-default-key">
                        🔑 SSH Agent / Default Key (~/.ssh/id_rsa, id_ed25519)
                      </option>
                      <option value="identity-file">
                        📄 Custom Private Key File (-i IdentityFile)
                      </option>
                      <option value="local-loopback">
                        🧪 Local SSH Loopback (Local Workspace Simulation)
                      </option>
                    </select>
                  </div>
                </div>

                <div className="ssh-form-grid">
                  <div className="ssh-field">
                    <label>Host / IP Address</label>
                    <input
                      className="settings-input"
                      style={{ minWidth: 'unset', width: '100%' }}
                      value={sshForm.host}
                      onChange={(e) => setSshForm({ ...sshForm, host: e.target.value })}
                      placeholder="10.0.62.83 or dev.example.com"
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 8 }}>
                    <div className="ssh-field">
                      <label>Username</label>
                      <input
                        className="settings-input"
                        style={{ minWidth: 'unset', width: '100%' }}
                        value={sshForm.username}
                        onChange={(e) => setSshForm({ ...sshForm, username: e.target.value })}
                        placeholder="root / ubuntu"
                      />
                    </div>
                    <div className="ssh-field">
                      <label>Port</label>
                      <input
                        type="number"
                        className="settings-input"
                        style={{ minWidth: 'unset', width: '100%' }}
                        value={sshForm.port}
                        onChange={(e) =>
                          setSshForm({ ...sshForm, port: Number(e.target.value) || 22 })
                        }
                      />
                    </div>
                  </div>
                </div>

                {sshForm.authMethod !== 'local-loopback' && (
                  <div className="ssh-field">
                    <label>
                      SSH Password (Required if key-based authentication is not configured)
                    </label>
                    <input
                      type="password"
                      className="settings-input"
                      style={{ minWidth: 'unset', width: '100%' }}
                      value={sshForm.password || ''}
                      onChange={(e) =>
                        setSshForm({ ...sshForm, password: e.target.value })
                      }
                      placeholder={`Enter password for ${sshForm.username || 'root'}@${sshForm.host || '10.0.62.83'}...`}
                    />
                  </div>
                )}

                {sshForm.authMethod === 'identity-file' && (
                  <div className="ssh-field">
                    <label>Private Key Path (IdentityFile)</label>
                    <input
                      className="settings-input"
                      style={{ minWidth: 'unset', width: '100%' }}
                      value={sshForm.identityFile}
                      onChange={(e) =>
                        setSshForm({ ...sshForm, identityFile: e.target.value })
                      }
                      placeholder="~/.ssh/id_rsa or C:\Users\you\.ssh\id_ed25519"
                    />
                  </div>
                )}

                <div className="ssh-field">
                  <label>Remote Project / Workspace Directory</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="settings-input"
                      style={{ minWidth: 'unset', flex: 1 }}
                      value={sshForm.remotePath}
                      onChange={(e) => setSshForm({ ...sshForm, remotePath: e.target.value })}
                      placeholder="/root/nccl or /home/ubuntu/project"
                    />
                    <button
                      className="btn"
                      onClick={() => void handleBrowseRemoteSsh(sshForm.remotePath)}
                    >
                      📂 Browse Remote...
                    </button>
                  </div>
                </div>

                {sshBrowseData && (
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 11,
                        color: '#93c5fd',
                        marginBottom: 4,
                      }}
                    >
                      <span>Remote Directory: {sshBrowseData.currentDir}</span>
                      <span
                        style={{ cursor: 'pointer', textDecoration: 'underline' }}
                        onClick={() =>
                          void handleBrowseRemoteSsh(`${sshBrowseData.currentDir}/..`)
                        }
                      >
                        ⬆ Parent Directory (..)
                      </span>
                    </div>
                    <div className="ssh-browser-box">
                      {sshBrowseData.directories.map((dir) => (
                        <span
                          key={dir}
                          className="context-pill"
                          style={{ cursor: 'pointer' }}
                          onClick={() =>
                            void handleBrowseRemoteSsh(
                              sshBrowseData.currentDir.endsWith('/') ||
                                sshBrowseData.currentDir.endsWith('\\')
                                ? `${sshBrowseData.currentDir}${dir}`
                                : `${sshBrowseData.currentDir}/${dir}`
                            )
                          }
                        >
                          📁 {dir}
                        </span>
                      ))}
                      {sshBrowseData.directories.length === 0 && (
                        <span style={{ fontSize: 11, color: '#8b949e' }}>
                          No subdirectories found in this folder.
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {sshTestResult && (
                  <div
                    className={`ai-key-test-banner ${sshTestResult.ok ? 'ok' : 'fail'}`}
                    style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <strong>
                        {sshTestResult.ok
                          ? `✅ SSH Connection Verified (${sshForm.username}@${sshForm.host}:${sshForm.port})`
                          : `❌ SSH Connection Failed`}
                      </strong>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {sshTestResult.latencyMs != null && (
                          <span className={`badge ${sshTestResult.ok ? 'success' : 'danger'}`}>
                            {sshTestResult.latencyMs} ms
                          </span>
                        )}
                        <button
                          className="btn"
                          style={{ padding: '1px 6px', fontSize: 10 }}
                          onClick={() => {
                            const textToCopy = [
                              sshTestResult.message,
                              sshTestResult.remoteOsInfo
                                ? `OS: ${sshTestResult.remoteOsInfo}`
                                : '',
                              sshTestResult.remediation || '',
                            ]
                              .filter(Boolean)
                              .join('\n');
                            void navigator.clipboard.writeText(textToCopy);
                            setStatusNotice('Copied SSH diagnostic info to clipboard');
                          }}
                        >
                          📋 Copy
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, userSelect: 'text', WebkitUserSelect: 'text' }}>
                      {sshTestResult.message}
                    </div>
                    {sshTestResult.remoteOsInfo && (
                      <div style={{ fontSize: 11.5, color: '#93c5fd', userSelect: 'text' }}>
                        Remote Kernel: <code>{sshTestResult.remoteOsInfo}</code>
                      </div>
                    )}
                    {sshTestResult.remediation && (
                      <div
                        style={{
                          fontSize: 11.5,
                          opacity: 0.9,
                          whiteSpace: 'pre-line',
                          userSelect: 'text',
                          WebkitUserSelect: 'text',
                        }}
                      >
                        {sshTestResult.remediation}
                      </div>
                    )}
                  </div>
                )}

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: 'auto',
                    paddingTop: 10,
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn"
                      disabled={isTestingSsh}
                      onClick={() => void handleTestSshConnection()}
                    >
                      {isTestingSsh ? '⏳ Testing SSH...' : '⚡ Test SSH Connection'}
                    </button>
                    <button className="btn" onClick={() => void handleSaveSshProfile()}>
                      💾 Save Host
                    </button>
                    <button
                      className="btn"
                      title="Copy SSH command string to clipboard"
                      onClick={() => {
                        const cmdStr = `ssh -p ${sshForm.port || 22}${
                          sshForm.authMethod === 'identity-file' && sshForm.identityFile
                            ? ` -i ${sshForm.identityFile}`
                            : ''
                        } ${sshForm.username}@${sshForm.host}`;
                        void navigator.clipboard.writeText(cmdStr);
                        setStatusNotice(`Copied: ${cmdStr}`);
                      }}
                    >
                      📋 Copy SSH Cmd
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    {sshStatus?.connected && (
                      <button
                        className="btn danger"
                        onClick={() => void handleDisconnectSshHost()}
                      >
                        🔌 Disconnect Remote
                      </button>
                    )}
                    <button
                      className="btn primary"
                      disabled={isConnectingSsh}
                      onClick={() => void handleConnectSshHost()}
                    >
                      {isConnectingSsh
                        ? '⏳ Connecting & Syncing...'
                        : '🚀 Connect & Open Remote Workspace'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 6. Bottom IDE Statusbar */}
      <footer className="ide-statusbar">
        <div className="status-group">
          <button
            className={`status-remote-btn ${sshStatus?.connected ? 'connected' : ''}`}
            title="Remote - SSH: Click to connect or manage remote SSH servers (Ctrl+Alt+O)"
            onClick={() => void openSshConnectionModal()}
          >
            {sshStatus?.connected
              ? `🌐 SSH: ${sshStatus.activeProfile?.username}@${sshStatus.activeProfile?.host}`
              : '>< SSH Remote'}
          </button>
          <span
            style={{ cursor: 'pointer', color: '#60a5fa', fontWeight: 600 }}
            onClick={() => setShowProjectModal(true)}
          >
            📂 {workspaceName}
          </span>
          <span>🌿 {gitState.branch}*</span>
          <span>ⓘ 0 Errors</span>
          <span>Backend: {backendStatus?.diagnostics?.effectiveMode ?? 'local'}</span>
          <span>Status: {statusNotice}</span>
        </div>
        <div className="status-group">
          <span
            style={{
              cursor: 'pointer',
              color: autocompleteEnabled ? '#34d399' : 'var(--text-muted)',
              fontWeight: autocompleteEnabled ? 600 : 400,
            }}
            onClick={() => {
              const next = !autocompleteEnabled;
              setAutocompleteEnabled(next);
              setGhostText('');
              setStatusNotice(`Inline Ghost Autocomplete: ${next ? 'Enabled' : 'Disabled'}`);
            }}
            title="Click to toggle Inline Ghost Text / Tab Autocomplete"
          >
            ⚡ Autocomplete: {autocompleteEnabled ? 'ON' : 'OFF'}
          </span>
          <span>
            Ln {cursorPos.line}, Col {cursorPos.col}
          </span>
          <span>UTF-8</span>
          <span
            style={{ cursor: 'pointer' }}
            onClick={() => toggleColorTheme()}
            title="Click to toggle Dark / Light Theme"
          >
            {isLightTheme ? '☀️ Light' : '🌙 Dark'}
          </span>
          <span
            style={{ cursor: 'pointer' }}
            onClick={() => openSettingsCenter('models')}
          >
            ⚡ {modelInput} ({executionMode})
          </span>
          <span
            style={{ cursor: 'pointer' }}
            onClick={() => openSettingsCenter('general')}
          >
            ⚙️ Settings
          </span>
        </div>
      </footer>
    </div>
  );
}
