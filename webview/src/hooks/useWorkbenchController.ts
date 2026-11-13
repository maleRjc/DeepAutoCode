import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { marksFromDiffRecord, type DiffLineKind } from '../../../src/diff-line-marks';
import {
  parseDiffHunks,
  rebuildProposedAfterHunkDecision,
  type DiffHunkView,
} from '../../../src/diff-hunks';
import {
  buildInlineAgentPrompt,
  selectionFromOffsets,
} from '../../../src/inline-agent-prompt';
import { WebviewBridgeClient, type UIEventMessage } from '../bridgeClient';
import {
  APP_LOCALES,
  createTranslator,
  normalizeLocale,
  resolveInitialLocale,
  type AppLocale,
} from '../i18n/index.js';
import type {
  OpenTab,
  TerminalEntry,
  SettingsCategory,
  GuideSectionId,
} from '../types/workbench';
import {
  formatCompactTokens,
  IMAGE_FILE_EXT_PATTERN,
  getImageMimeType,
  wordAtCursor,
  detectUiPromptIntent as detectUiPromptIntentUtil,
  promptWantsWorkspaceArtifact,
  buildCheckpointContentDiff,
  formatToolStepLabel,
  parseDiffToSplitRows,
  parseSourceReferenceToken as parseSourceReferenceTokenUtil,
  findBestLineMatchInContent,
  formatLatexMathText,
  extractLatestSourceRefFromText as extractLatestSourceRefFromTextUtil,
  extractCompactExecutiveSummary as extractCompactExecutiveSummaryUtil,
  getFileVisualMeta,
  renderSyntaxHighlightedLine as renderSyntaxHighlightedLineUtil,
} from '../utils/workbenchUtils';
import { usePaneLayout } from './usePaneLayout';
import { useSshManager } from './useSshManager';
import { createMarkdownRenderer } from '../components/MarkdownRenderer';

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

export function useWorkbenchController() {
  const {
    showLeftSidebar,
    setShowLeftSidebar,
    showBottomPanel,
    setShowBottomPanel,
    showRightAiDock,
    setShowRightAiDock,
    leftSidebarWidth,
    setLeftSidebarWidth,
    rightAiDockWidth,
    setRightAiDockWidth,
    bottomPanelHeight,
    setBottomPanelHeight,
    settingsNavWidth,
    setSettingsNavWidth,
    draggingSash,
    startPaneResize,
    bodyGridStyle,
    centerGridStyle,
  } = usePaneLayout();

  const [isSendingPrompt, setIsSendingPrompt] = useState<boolean>(false);
  /** Stage U: sessions currently running Agent turns (parallel-safe) */
  const [runningSessionIds, setRunningSessionIds] = useState<string[]>([]);
  const runningSessionIdsRef = useRef<Set<string>>(new Set());
  /** Pinned composer tabs for quick parallel switching (max 4) */
  const [composerSessionTabs, setComposerSessionTabs] = useState<string[]>([]);
  const [agentMemoryEntries, setAgentMemoryEntries] = useState<
    Array<{ id: string; title: string; summary: string; source: string; createdAt: string }>
  >([]);
  const [activeActivity, setActiveActivity] = useState<
    'explorer' | 'search' | 'git' | 'extensions'
  >('explorer');
  const [activeBottomTab, setActiveBottomTab] = useState<
    'terminal' | 'problems' | 'audit' | 'output'
  >('terminal');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showGearPopup, setShowGearPopup] = useState(false);
  const [showLangPopup, setShowLangPopup] = useState(false);

  // Modals: Command Palette, Open Project Dialog, Create File/Folder Dialog
  const [showPalette, setShowPalette] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'commands' | 'symbols' | 'definitions'>(
    'commands'
  );
  const [symbolPaletteItems, setSymbolPaletteItems] = useState<
    Array<{ label: string; hint: string; run: () => void }>
  >([]);
  const [workspaceProblems, setWorkspaceProblems] = useState<
    Array<{
      file: string;
      line: number;
      column?: number;
      severity: string;
      message: string;
      source: string;
    }>
  >([]);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [customFolderInput, setCustomFolderInput] = useState('');
  const [showCreateModal, setShowCreateModal] = useState<null | 'file' | 'directory'>(null);
  const [createTargetName, setCreateTargetName] = useState('src/new-module.ts');

  // Workspace & Multi-Tab Editor states (Antigravity first-launch: no folder opened by default)
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('');
  const [workspaceName, setWorkspaceName] = useState<string>('');
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
  const [appLocale, setAppLocaleState] = useState<AppLocale>(() => resolveInitialLocale());
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
      minimap: false,
      autoSave: 'afterDelay',
      theme: initialStartupTheme,
    },
    ui: {
      locale: resolveInitialLocale(),
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
      userRules: '',
      projectRules:
        '1. Follow TypeScript strict mode and ESM import conventions.\n2. Keep Cline SDK internal types isolated inside deepautocode-agent.\n3. Enforce workspace path canonicalization and never store plaintext API keys.',
      verifyBuildCommand: 'npm run build',
      verifyTestCommand: 'npm test',
      enableEvolveSandbox: true,
    },
    mcpServers: [],
    recentWorkspaces: [],
  });
  const [newAllowlistCmd, setNewAllowlistCmd] = useState('');
  const [newMcpName, setNewMcpName] = useState('');
  const [newMcpCmd, setNewMcpCmd] = useState('');
  const [newMcpEnv, setNewMcpEnv] = useState('');
  const [newMcpTransport, setNewMcpTransport] = useState<'stdio' | 'sse' | 'http'>('stdio');
  const [newMcpHeaders, setNewMcpHeaders] = useState('');
  const [mcpTestResult, setMcpTestResult] = useState<{
    ok: boolean;
    tools: Array<{ qualifiedName: string; description?: string; serverName?: string }>;
    error?: string | null;
    serverCount?: number;
  } | null>(null);
  const [isTestingMcp, setIsTestingMcp] = useState(false);
  const [checkpointPreviewDiffs, setCheckpointPreviewDiffs] = useState<
    Array<{ path: string; summary: string; preview: string }>
  >([]);
  const [problemGutterLines, setProblemGutterLines] = useState<Map<number, string>>(new Map());
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
  const [streamingThinking, setStreamingThinking] = useState<string>('');
  const [liveToolCalls, setLiveToolCalls] = useState<any[]>([]);
  const [liveTimeline, setLiveTimeline] = useState<any[]>([]);
  /** Click-to-expand live processing steps (PROCESSING card) */
  const [showLiveSteps, setShowLiveSteps] = useState<boolean>(true);
  const [pendingApprovals, setPendingApprovals] = useState<any[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<any[]>([]);
  const [questionSelections, setQuestionSelections] = useState<
    Record<string, Record<string, string[]>>
  >({});
  const [questionCustomInputs, setQuestionCustomInputs] = useState<
    Record<string, Record<string, string>>
  >({});
  const [backgroundTasks, setBackgroundTasks] = useState<any[]>([]);
  const [carouselSlideIndices, setCarouselSlideIndices] = useState<Record<string, number>>({});
  const [artifactComments, setArtifactComments] = useState<Record<string, string[]>>({});
  const [artifactCommentInput, setArtifactCommentInput] = useState<Record<string, string>>({});
  const [installedCatalogPlugins, setInstalledCatalogPlugins] = useState<Record<string, boolean>>({});
  const [attachedImages, setAttachedImages] = useState<
    Array<{ id: string; name: string; dataUrl: string; mimeType: string }>
  >([]);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);
  const [diffs, setDiffs] = useState<any[]>([]);
  const [recoveredFlag, setRecoveredFlag] = useState<boolean>(false);
  const [executionMode, setExecutionMode] = useState<'plan' | 'auto' | 'manual'>('auto');
  const [manualIntentChoice, setManualIntentChoice] = useState<
    null | 'query-only' | 'auto-action' | 'build-fix'
  >(null);
  const [promptInput, setPromptInput] = useState<string>('');
  const [attachActiveFile, setAttachActiveFile] = useState<boolean>(true);
  const [aiTab, setAiTab] = useState<
    'composer' | 'artifacts' | 'sessions' | 'changes' | 'trace'
  >('composer');
  const [contextChips, setContextChips] = useState<
    Array<{ id: string; kind: string; label: string; value: string }>
  >([]);
  const [sessionCheckpoints, setSessionCheckpoints] = useState<any[]>([]);
  const [lastModelTier, setLastModelTier] = useState<{
    effectiveModelId?: string;
    tier?: string;
    reason?: string;
    thinkingEnabled?: boolean;
    reasoningEffort?: string | null;
    peakHour?: boolean;
  } | null>(null);
  const [goalTokenUsage, setGoalTokenUsage] = useState<{
    tokensUsed: number;
    tokenBudget: number;
    remaining: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostCnyTotal: number;
    peakHour: boolean;
  } | null>(null);
  const [activeTaskTrace, setActiveTaskTrace] = useState<any | null>(null);
  const [pendingPromptQueue, setPendingPromptQueue] = useState<
    Array<{ prompt: string; mode?: 'plan' | 'auto' | 'manual' }>
  >([]);
  const [hunkDecisions, setHunkDecisions] = useState<
    Record<string, Array<'pending' | 'accepted' | 'rejected'>>
  >({});
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [composerSymbols, setComposerSymbols] = useState<
    Array<{ name: string; kind: string; startLine: number; endLine: number; filePath: string }>
  >([]);
  const [checkpointPreviewId, setCheckpointPreviewId] = useState<string>('');
  const ghostAbortRef = useRef<AbortController | null>(null);
  const ghostRequestSeqRef = useRef(0);
  const liveDiagTimerRef = useRef<any>(null);
  const liveDiagAbortRef = useRef<AbortController | null>(null);
  const liveDiagSeqRef = useRef(0);
  const drainPromptQueueRef = useRef(false);

  // Antigravity Inline Command (Ctrl+I), Artifacts, .agents Customizations & Web Preview states
  const [showInlineCommand, setShowInlineCommand] = useState<boolean>(false);
  const [inlineCommandInput, setInlineCommandInput] = useState<string>('');
  const [editorSelection, setEditorSelection] = useState<{
    startLine: number;
    endLine: number;
    text: string;
    hasSelection: boolean;
  }>({ startLine: 1, endLine: 1, text: '', hasSelection: false });
  const inlinePendingTargetRef = useRef<string>('');
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
  const [modelInput, setModelInput] = useState<string>('deepseek-flash');
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [smokeResult, setSmokeResult] = useState<any>(null);
  const [isTestingKey, setIsTestingKey] = useState<boolean>(false);
  const [backendStatus, setBackendStatus] = useState<any>(null);
  const [extensionsCatalog, setExtensionsCatalog] = useState<any>(null);
  const [vsixFileName, setVsixFileName] = useState<string>('enterprise-linter-1.0.0.vsix');
  const [vsixConfirmed, setVsixConfirmed] = useState<boolean>(false);
  const [diagnosticsDump, setDiagnosticsDump] = useState<any>(null);
  const [statusNotice, setStatusNotice] = useState<string>('Ready');


  const lastSeqRef = useRef<number>(0);
  const lastSeqBySessionRef = useRef<Record<string, number>>({});
  const activeSessionIdRef = useRef<string>('');
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
  const locale = normalizeLocale(ideSettings.ui?.locale ?? appLocale);
  const i18n = useMemo(() => createTranslator(locale), [locale]);
  const { t, tr } = i18n;
  const displayWorkspaceName = workspaceName.trim() || t('welcome.noFolder');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', currentTheme);
    try {
      localStorage.setItem('dac.theme', currentTheme);
    } catch {
      // ignore storage errors
    }
    void window.deepAutoCodeDesktop?.setThemeOverlay?.(isLightTheme ? 'light' : 'dark');
  }, [currentTheme, isLightTheme]);

  useEffect(() => {
    setAppLocaleState(locale);
    document.documentElement.setAttribute('lang', locale);
    try {
      localStorage.setItem('dac.locale', locale);
    } catch {
      // ignore
    }
  }, [locale]);

  function setAppLocale(next: AppLocale) {
    const normalized = normalizeLocale(next);
    setAppLocaleState(normalized);
    void persistIdeSettings({
      ...ideSettings,
      ui: {
        ...(ideSettings.ui ?? {}),
        locale: normalized,
      },
    });
    setStatusNotice(getMessageForLocale(normalized, 'settings.saveNotice'));
  }

  function getMessageForLocale(loc: AppLocale, key: string): string {
    return createTranslator(loc).t(key);
  }

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
      nextTheme === 'cursor-light' ? t('status.theme.light') : t('status.theme.dark')
    );
  }


  const {
    showSshModal,
    setShowSshModal,
    sshStatus,
    setSshStatus,
    sshProfiles,
    setSshProfiles,
    sshQuickCmd,
    setSshQuickCmd,
    sshForm,
    setSshForm,
    sshTestResult,
    setSshTestResult,
    isTestingSsh,
    isConnectingSsh,
    sshBrowseData,
    setSshBrowseData,
    openSshConnectionModal,
    parseQuickSshCommand,
    handleTestSshConnection,
    handleSaveSshProfile,
    handleDeleteSshProfile,
    handleBrowseRemoteSsh,
    handleConnectSshHost,
    handleDisconnectSshHost,
  } = useSshManager({
    setStatusNotice,
    appendLog,
    setWorkspaceRoot,
    setWorkspaceName,
    setFileTree,
    setExpandedDirs,
    setShowLeftSidebar,
    setShowRightAiDock,
    setActiveActivity,
    setWorkspaceSectionOpen,
    setTabs,
    setActiveTabPath,
    openFileInTab,
    bridge,
    executionMode,
    setSessions,
    selectAndResumeSession,
    refreshGitStatus,
  });

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!bootstrappedRef.current) {
      bootstrappedRef.current = true;
      void bootstrapIde();
    }
    const unsub = bridge.onEvent((ev: UIEventMessage) => {
      const sid = String(ev.sessionId || '');
      if (sid) {
        const prev = lastSeqBySessionRef.current[sid] || 0;
        if (ev.sequence > prev) lastSeqBySessionRef.current[sid] = ev.sequence;
      }
      if (ev.sequence > lastSeqRef.current) {
        lastSeqRef.current = ev.sequence;
      }
      handleRealtimeEvent(ev);
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPaletteMode('commands');
        setShowPalette((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPaletteMode('commands');
        setShowPalette((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        openSettingsCenter('general');
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        openSettingsCenter('models');
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openGoToSymbolPalette();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void handleOpenProjectAction();
      } else if (e.key === 'F12') {
        e.preventDefault();
        void jumpToDefinitionAtCursor();
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
        setShowLangPopup(false);
        setShowProjectModal(false);
        setShowCreateModal(null);
        setShowSshModal(false);
        setShowInlineCommand(false);
        setPaletteMode('commands');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unsub();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeTabPath, tabs, cursorPos.line, cursorPos.col]);

  // Stage Q: keep gutter diagnostic dots in sync with Problems for the active file
  useEffect(() => {
    if (!activeTabPath) {
      setProblemGutterLines(new Map());
      return;
    }
    const norm = activeTabPath.replace(/\\/g, '/');
    const marks = new Map<number, string>();
    for (const p of workspaceProblems) {
      const pf = String(p.file || '').replace(/\\/g, '/');
      if (!pf) continue;
      if (pf === norm || norm.endsWith(pf) || pf.endsWith(norm)) {
        const sev = String(p.severity || 'info');
        marks.set(Number(p.line) || 1, `${sev}: ${p.message}`);
      }
    }
    setProblemGutterLines(marks);
  }, [activeTabPath, workspaceProblems]);

  // Stage R: cache active-file outline for @symbol mentions
  useEffect(() => {
    const tab = tabs.find((t) => t.path === activeTabPath && t.kind === 'code');
    if (!tab?.path) {
      setComposerSymbols([]);
      return;
    }
    let cancelled = false;
    void fetch('/api/workspace/outline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: tab.path }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (cancelled) return;
        const symbols = Array.isArray(res?.symbols) ? res.symbols : [];
        setComposerSymbols(
          symbols.slice(0, 80).map((s: any) => ({
            name: String(s.name || ''),
            kind: String(s.kind || 'symbol'),
            startLine: Number(s.startLine) || 1,
            endLine: Number(s.endLine) || Number(s.startLine) || 1,
            filePath: tab.path.replace(/\\/g, '/'),
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setComposerSymbols([]);
      });
    return () => {
      cancelled = true;
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

  function syncEditorSelectionFromTextarea(textarea?: HTMLTextAreaElement | null) {
    const el = textarea ?? codeTextareaRef.current;
    const content = activeTab?.kind === 'code' ? activeTab.content ?? '' : '';
    if (!el) {
      setEditorSelection({
        startLine: cursorPos.line,
        endLine: cursorPos.line,
        text: '',
        hasSelection: false,
      });
      return;
    }
    const next = selectionFromOffsets(content, el.selectionStart, el.selectionEnd);
    if (!next.hasSelection) {
      next.startLine = cursorPos.line || next.startLine;
      next.endLine = cursorPos.line || next.endLine;
    }
    setEditorSelection(next);
    return next;
  }

  function handleInlineCommandSubmit(overrideInstruction?: string) {
    const instruction = (overrideInstruction ?? inlineCommandInput).trim();
    if (!instruction) return;
    const currentFile = activeTab?.kind === 'code' ? activeTab.path : files[0] || '';
    const liveSelection =
      syncEditorSelectionFromTextarea(codeTextareaRef.current) || editorSelection;
    const startLine = liveSelection.hasSelection
      ? liveSelection.startLine
      : cursorPos.line || 1;
    const endLine = liveSelection.hasSelection
      ? liveSelection.endLine
      : cursorPos.line || startLine;
    const built = buildInlineAgentPrompt({
      instruction,
      filePath: currentFile,
      startLine,
      endLine,
      selectedText: liveSelection.hasSelection ? liveSelection.text : '',
    });
    inlinePendingTargetRef.current = built.filePath;
    setShowRightAiDock(true);
    setAiTab('composer');
    setShowInlineCommand(false);
    setInlineCommandInput('');
    setStatusNotice(
      built.isExplain
        ? `Inline Query → Agent tools on ${built.filePath || 'workspace'} (${built.startLine === built.endLine ? `L${built.startLine}` : `L${built.startLine}-L${built.endLine}`})`
        : `Inline Edit → Agent tool chain on ${built.filePath || 'workspace'} (${built.startLine === built.endLine ? `L${built.startLine}` : `L${built.startLine}-L${built.endLine}`})`
    );
    void handleSendPrompt(built.prompt, built.mode);
  }

  function triggerCodeLensAction(kind: 'explain' | 'refactor' | 'tests') {
    const file = activeTab?.kind === 'code' ? activeTab.path : '';
    const line = cursorPos.line || 1;
    if (kind === 'explain') {
      handleInlineCommandSubmit(
        `Explain the logic and invariants around line ${line}${file ? ` in ${file}` : ''}`
      );
      return;
    }
    if (kind === 'refactor') {
      handleInlineCommandSubmit(
        `Refactor and optimize the function around line ${line}${file ? ` in ${file}` : ''}`
      );
      return;
    }
    handleInlineCommandSubmit(
      `Write unit/verification tests for the code around line ${line}${file ? ` in ${file}` : ''}`
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
      setWorkspaceName(wsData.workspaceName || '');
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
      refreshWorkspaceProblems(),
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
        const mergedLocale = normalizeLocale(
          res.settings.ui?.locale ?? resolveInitialLocale()
        );
        setIdeSettings({
          ...res.settings,
          ui: { ...(res.settings.ui ?? {}), locale: mergedLocale },
        });
        setAppLocaleState(mergedLocale);
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
    setWorkspaceName('');
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
      // Stage Q: save → LSP diagnostics → Problems + gutter dots
      try {
        const diagRes = await fetch('/api/lsp/diagnostics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: current.path, content: current.content }),
        }).then((r) => r.json());
        const diags = Array.isArray(diagRes?.diagnostics) ? diagRes.diagnostics : [];
        const marks = new Map<number, string>();
        for (const d of diags) {
          if (String(d.severity) === 'error' || String(d.severity) === 'warning') {
            const line = Number(d.line) || 1;
            marks.set(line, `${d.severity}: ${d.message}`);
          }
        }
        setProblemGutterLines(marks);
        if (Array.isArray(diagRes?.problems)) {
          setWorkspaceProblems(diagRes.problems);
        } else {
          void refreshWorkspaceProblems();
        }
        if (marks.size > 0) {
          setStatusNotice(`Saved ${current.path} · ${marks.size} diagnostic mark(s)`);
        }
      } catch {
        // non-fatal
      }
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

  async function refreshWorkspaceProblems() {
    try {
      const res = await fetch('/api/workspace/problems').then((r) => r.json());
      if (Array.isArray(res?.problems)) {
        setWorkspaceProblems(res.problems);
      }
    } catch {
      // ignore
    }
  }


  async function openGoToSymbolPalette() {
    const filePath = activeTab?.kind === 'code' ? activeTab.path : '';
    if (!filePath) {
      setStatusNotice('Open a source file to use Go to Symbol');
      return;
    }
    try {
      const res = await fetch('/api/workspace/outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      }).then((r) => r.json());
      const symbols = Array.isArray(res?.symbols) ? res.symbols : [];
      setSymbolPaletteItems(
        symbols.map((s: any) => ({
          label: `${s.kind} ${s.name}`,
          hint: `L${s.startLine}${s.endLine > s.startLine ? `-L${s.endLine}` : ''}`,
          run: () => {
            void openFileInTab(filePath, true, false, Number(s.startLine) || 1, Number(s.endLine) || undefined);
          },
        }))
      );
      setPaletteQuery('');
      setPaletteMode('symbols');
      setShowPalette(true);
      setStatusNotice(`Go to Symbol: ${symbols.length} symbols in ${filePath}`);
    } catch (err) {
      setStatusNotice(`Go to Symbol failed: ${(err as Error).message}`);
    }
  }

  async function jumpToDefinitionAtCursor() {
    const filePath = activeTab?.kind === 'code' ? activeTab.path : '';
    const content = activeTab?.kind === 'code' ? activeTab.content : '';
    if (!filePath || !content) {
      setStatusNotice('Open a source file to jump to definition');
      return;
    }
    const symbol = wordAtCursor(content, cursorPos.line, cursorPos.col);
    if (!symbol) {
      setStatusNotice('No identifier under cursor');
      return;
    }
    try {
      // Prefer real LSP (TS Language Service / clangd) before heuristic search
      const lspRes = await fetch('/api/lsp/definition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath,
          line: cursorPos.line,
          character: cursorPos.col,
          content,
        }),
      }).then((r) => r.json());
      let matches = Array.isArray(lspRes?.matches) ? lspRes.matches : [];
      if (matches.length === 0) {
        const res = await fetch('/api/workspace/definition', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, currentFile: filePath }),
        }).then((r) => r.json());
        matches = Array.isArray(res?.matches) ? res.matches : [];
      }
      if (matches.length === 0) {
        setStatusNotice(`No definition found for "${symbol}"`);
        return;
      }
      if (matches.length === 1) {
        const m = matches[0];
        await openFileInTab(m.file, true, false, Number(m.line) || 1);
        setStatusNotice(
          `Definition (${lspRes?.matches?.length ? 'LSP' : 'search'}): ${m.file}:${m.line}`
        );
        return;
      }
      setSymbolPaletteItems(
        matches.map((m: any) => ({
          label: `${m.file}:${m.line}  ${m.preview || ''}`,
          hint: m.score != null ? `score ${m.score}` : 'LSP',
          run: () => {
            void openFileInTab(m.file, true, false, Number(m.line) || 1);
          },
        }))
      );
      setPaletteQuery('');
      setPaletteMode('definitions');
      setShowPalette(true);
      setStatusNotice(`Definitions for "${symbol}": ${matches.length} candidates`);
    } catch (err) {
      setStatusNotice(`Go to Definition failed: ${(err as Error).message}`);
    }
  }

  async function refreshLspDiagnosticsForActiveFile() {
    const filePath = activeTab?.kind === 'code' ? activeTab.path : '';
    const content = activeTab?.kind === 'code' ? activeTab.content : '';
    if (!filePath) return;
    try {
      const res = await fetch('/api/lsp/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, content }),
      }).then((r) => r.json());
      if (Array.isArray(res?.problems)) {
        setWorkspaceProblems(res.problems);
      } else if (Array.isArray(res?.diagnostics) && res.diagnostics.length > 0) {
        setWorkspaceProblems(res.diagnostics);
        setShowBottomPanel(true);
        setActiveBottomTab('problems');
      }
    } catch {
      // ignore
    }
  }

  async function handleSshReconnect() {
    try {
      setStatusNotice('Reconnecting SSH…');
      const res = await fetch('/api/ssh/reconnect', { method: 'POST' }).then((r) => r.json());
      if (!res?.ok) throw new Error(res?.error || 'Reconnect failed');
      if (res.workspaceRoot) setWorkspaceRoot(res.workspaceRoot);
      if (res.workspaceName) setWorkspaceName(res.workspaceName);
      if (res.status) setSshStatus(res.status);
      await refreshWorkspaceTree();
      setStatusNotice(`SSH reconnected: ${res.workspaceName || res.workspaceRoot}`);
    } catch (err) {
      setStatusNotice(`SSH reconnect failed: ${(err as Error).message}`);
    }
  }

  async function handleSshConflictCheck(filePath?: string) {
    const target = filePath || (activeTab?.kind === 'code' ? activeTab.path : '');
    if (!target) return;
    try {
      const res = await fetch('/api/ssh/conflict-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: target }),
      }).then((r) => r.json());
      if (!res?.ok) throw new Error(res?.error || 'check failed');
      if (res.conflict) {
        const takeRemote = window.confirm(
          `SSH conflict on ${target}: local and remote both changed.\nOK = Take Remote (overwrite local)\nCancel = Keep Local`
        );
        if (takeRemote) {
          const pull = await fetch('/api/ssh/pull-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: target, allowOverwriteDirty: true }),
          }).then((r) => r.json());
          if (pull?.ok && typeof pull.content === 'string') {
            await openFileInTab(target, true, true);
            setStatusNotice(`Took remote version: ${target}`);
          } else {
            setStatusNotice(pull?.error || 'Pull failed');
          }
        } else {
          setStatusNotice(`Kept local version: ${target}`);
        }
      } else if (res.dirtyLocal) {
        setStatusNotice(`Local mirror dirty (not pulled): ${target}`);
      } else if (res.remoteChanged) {
        setStatusNotice(`Remote changed since last pull: ${target}`);
      } else {
        setStatusNotice(`No SSH conflict: ${target}`);
      }
    } catch (err) {
      setStatusNotice(`SSH conflict check failed: ${(err as Error).message}`);
    }
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
    if (Array.isArray(res?.problems)) {
      setWorkspaceProblems(res.problems);
      if (res.problems.length > 0 && (res.exitCode ?? 0) !== 0) {
        setActiveBottomTab('problems');
        setStatusNotice(`Problems updated: ${res.problems.length} issue(s) from build/terminal`);
      }
    } else {
      void refreshWorkspaceProblems();
    }
    void refreshWorkspaceTree();
    void refreshGitStatus();
  }

  function markSessionRunning(sessionId: string, running: boolean) {
    if (!sessionId) return;
    if (running) {
      runningSessionIdsRef.current.add(sessionId);
    } else {
      runningSessionIdsRef.current.delete(sessionId);
    }
    setRunningSessionIds((prev) => {
      const set = new Set(prev);
      if (running) set.add(sessionId);
      else set.delete(sessionId);
      return [...set];
    });
  }

  function pinComposerSession(sessionId: string) {
    if (!sessionId) return;
    setComposerSessionTabs((prev) => {
      const next = [sessionId, ...prev.filter((id) => id !== sessionId)];
      return next.slice(0, 4);
    });
  }

  async function refreshAgentMemory() {
    try {
      const res = await fetch('/api/agent-memory').then((r) => r.json());
      setAgentMemoryEntries(Array.isArray(res?.entries) ? res.entries : []);
    } catch {
      // ignore
    }
  }

  function handleRealtimeEvent(ev: UIEventMessage) {
    appendLog(`[Event #${ev.sequence}] ${ev.type}`);
    const sid = String(ev.sessionId || '');
    const isActive = !sid || sid === activeSessionIdRef.current;

    // Stage U: background sessions update running badge without clobbering active Composer
    if (!isActive) {
      if (
        ev.type === 'assistant.text.delta' ||
        ev.type === 'assistant.thinking.delta' ||
        ev.type === 'tool.call.started' ||
        ev.type === 'session.state.changed' ||
        (ev as { type: string }).type === 'session.state'
      ) {
        if (
          (ev.type === 'session.state.changed' ||
            (ev as { type: string }).type === 'session.state') &&
          ev.payload?.status &&
          ev.payload.status !== 'running'
        ) {
          markSessionRunning(sid, false);
        } else {
          markSessionRunning(sid, true);
        }
      }
      if (ev.type === 'assistant.text.done') {
        markSessionRunning(sid, false);
        void bridge.request<any[]>('session.list').then(setSessions);
        void refreshWorkspaceTree();
        void refreshGitStatus();
      }
      if (ev.type === 'diff.proposed' || ev.type === 'diff.updated') {
        setDiffs((prev) => {
          const exists = prev.some((d) => d.diffId === ev.payload.diffId);
          return exists
            ? prev.map((d) => (d.diffId === ev.payload.diffId ? { ...d, ...ev.payload } : d))
            : [ev.payload, ...prev];
        });
      }
      return;
    }

    switch (ev.type) {
      case 'assistant.thinking.delta': {
        markSessionRunning(sid, true);
        const delta = String(ev.payload.delta ?? '');
        if (!delta) break;
        setStreamingThinking((prev) => prev + delta);
        setLiveTimeline((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === 'thinking') {
            const next = [...prev];
            next[next.length - 1] = {
              ...last,
              thinking: String(last.thinking || '') + delta,
            };
            return next;
          }
          return [
            ...prev,
            {
              id: `live_think_${Date.now()}_${prev.length}`,
              kind: 'thinking',
              timestamp: new Date().toISOString(),
              startedAtMs: Date.now(),
              thinking: delta,
            },
          ];
        });
        break;
      }
      case 'assistant.text.delta': {
        markSessionRunning(sid, true);
        const delta = String(ev.payload.delta ?? '');
        if (!delta) break;
        setStreamingText((prev) => prev + delta);
        setLiveTimeline((prev) => {
          const finalized = prev.map((item) =>
            item.kind === 'thinking' && !item.durationMs && item.startedAtMs
              ? { ...item, durationMs: Math.max(100, Date.now() - item.startedAtMs) }
              : item
          );
          const last = finalized[finalized.length - 1];
          if (last && last.kind === 'text') {
            const next = [...finalized];
            next[next.length - 1] = {
              ...last,
              text: String(last.text || '') + delta,
            };
            return next;
          }
          return [
            ...finalized,
            {
              id: `live_text_${Date.now()}_${finalized.length}`,
              kind: 'text',
              timestamp: new Date().toISOString(),
              text: delta,
            },
          ];
        });
        break;
      }
      case 'assistant.text.done':
        setStreamingText('');
        setStreamingThinking('');
        setLiveToolCalls([]);
        setLiveTimeline([]);
        markSessionRunning(sid, false);
        setIsSendingPrompt(false);
        void selectAndResumeSession(ev.sessionId);
        void bridge.request<any[]>('session.list').then(setSessions);
        void refreshWorkspaceTree();
        void refreshGitStatus();
        void refreshAgentMemory();
        break;
      case 'session.state.changed':
        if (ev.payload?.status && ev.payload.status !== 'running') {
          markSessionRunning(sid, false);
          setIsSendingPrompt(false);
          setLiveToolCalls([]);
          setLiveTimeline([]);
          setStreamingText('');
          setStreamingThinking('');
        } else if (ev.payload?.status === 'running') {
          markSessionRunning(sid, true);
        }
        break;
      case 'tool.call.started':
        markSessionRunning(sid, true);
        setLiveToolCalls((prev) => [...prev, ev.payload]);
        setLiveTimeline((prev) => {
          const finalized = prev.map((item) =>
            item.kind === 'thinking' && !item.durationMs && item.startedAtMs
              ? { ...item, durationMs: Math.max(100, Date.now() - item.startedAtMs) }
              : item
          );
          return [
            ...finalized,
            {
              id: `live_tool_${ev.payload.toolCallId || Date.now()}`,
              kind: 'tool',
              timestamp: String(ev.payload.startedAt || new Date().toISOString()),
              toolCall: ev.payload,
            },
          ];
        });
        break;
      case 'tool.call.completed':
      case 'tool.call.failed':
        setLiveToolCalls((prev) =>
          prev.map((tc) => (tc.toolCallId === ev.payload.toolCallId ? ev.payload : tc))
        );
        setLiveTimeline((prev) =>
          prev.map((item) =>
            item.kind === 'tool' && item.toolCall?.toolCallId === ev.payload.toolCallId
              ? {
                  ...item,
                  toolCall: { ...item.toolCall, ...ev.payload },
                  durationMs: ev.payload.durationMs,
                }
              : item
          )
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
      case 'question.requested':
        setPendingQuestions((prev) => [
          ...prev.filter((q) => q.questionId !== ev.payload.questionId),
          ev.payload,
        ]);
        setStatusNotice('Agent is asking a clarification question — please select an option');
        break;
      case 'question.resolved':
        setPendingQuestions((prev) =>
          prev.filter((q) => q.questionId !== ev.payload.questionId)
        );
        break;
      case 'task.state.changed': {
        const taskSnap = ev.payload?.task || ev.payload;
        if (taskSnap?.taskId) {
          setBackgroundTasks((prev) => {
            const exists = prev.some((t) => t.taskId === taskSnap.taskId);
            return exists
              ? prev.map((t) => (t.taskId === taskSnap.taskId ? taskSnap : t))
              : [taskSnap, ...prev];
          });
        }
        break;
      }
      case 'diff.updated':
        setDiffs((prev) => {
          const exists = prev.some((d) => d.diffId === ev.payload.diffId);
          return exists
            ? prev.map((d) => (d.diffId === ev.payload.diffId ? { ...d, ...ev.payload } : d))
            : [ev.payload, ...prev];
        });
        break;
      case 'model.tier':
        setLastModelTier({
          effectiveModelId: String(ev.payload.effectiveModelId || ''),
          tier: String(ev.payload.tier || ''),
          reason: String(ev.payload.reason || ''),
          thinkingEnabled: Boolean(ev.payload.thinkingEnabled),
          reasoningEffort:
            ev.payload.reasoningEffort == null
              ? null
              : String(ev.payload.reasoningEffort),
          peakHour: Boolean(ev.payload.peakHour),
        });
        if (
          typeof ev.payload.tokensUsed === 'number' ||
          typeof ev.payload.tokenBudget === 'number'
        ) {
          setGoalTokenUsage((prev) => {
            const used = Number(ev.payload.tokensUsed ?? prev?.tokensUsed ?? 0);
            const budget = Number(ev.payload.tokenBudget ?? prev?.tokenBudget ?? 180000);
            return {
              tokensUsed: used,
              tokenBudget: budget,
              remaining: Math.max(0, budget - used),
              cacheReadTokens: prev?.cacheReadTokens ?? 0,
              cacheWriteTokens: prev?.cacheWriteTokens ?? 0,
              estimatedCostCnyTotal: prev?.estimatedCostCnyTotal ?? 0,
              peakHour: Boolean(ev.payload.peakHour ?? prev?.peakHour),
            };
          });
        }
        break;
      case 'goal.usage': {
        const used = Number(ev.payload.tokensUsed ?? 0);
        const budget = Number(ev.payload.tokenBudget ?? 180000);
        setGoalTokenUsage((prev) => {
          const turnCacheRead = Number(ev.payload.cacheReadTokens ?? 0);
          const turnCacheWrite = Number(ev.payload.cacheWriteTokens ?? 0);
          const totalRead =
            typeof ev.payload.cacheReadTokensTotal === 'number'
              ? Number(ev.payload.cacheReadTokensTotal)
              : (prev?.cacheReadTokens ?? 0) + turnCacheRead;
          const totalWrite =
            typeof ev.payload.cacheWriteTokensTotal === 'number'
              ? Number(ev.payload.cacheWriteTokensTotal)
              : (prev?.cacheWriteTokens ?? 0) + turnCacheWrite;
          const costTotal =
            typeof ev.payload.estimatedCostCnyTotal === 'number'
              ? Number(ev.payload.estimatedCostCnyTotal)
              : (prev?.estimatedCostCnyTotal ?? 0) +
                Number(ev.payload.estimatedCostCny ?? 0);
          return {
            tokensUsed: used,
            tokenBudget: budget,
            remaining: Number(ev.payload.remaining ?? Math.max(0, budget - used)),
            cacheReadTokens: totalRead,
            cacheWriteTokens: totalWrite,
            estimatedCostCnyTotal: costTotal,
            peakHour: Boolean(ev.payload.peakHour ?? prev?.peakHour),
          };
        });
        break;
      }
      case 'trace.updated': {
        if (isActive && ev.payload?.snapshot) {
          setActiveTaskTrace(ev.payload.snapshot);
        }
        break;
      }
      case 'checkpoint.created':
        setStatusNotice(
          `Checkpoint saved: ${ev.payload.label || ev.payload.checkpointId} (${ev.payload.fileCount || 0} files)`
        );
        if (activeSessionId) {
          void bridge
            .request<any[]>('session.checkpoint.list', { sessionId: activeSessionId }, activeSessionId)
            .then((list) => setSessionCheckpoints(Array.isArray(list) ? list : []))
            .catch(() => undefined);
        }
        break;
      case 'diff.proposed':
        setDiffs((prev) => {
          const exists = prev.some((d) => d.diffId === ev.payload.diffId);
          return exists
            ? prev.map((d) => (d.diffId === ev.payload.diffId ? ev.payload : d))
            : [ev.payload, ...prev];
        });
        setAiTab((tab) => (tab === 'composer' ? 'changes' : tab));
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
          const pending = inlinePendingTargetRef.current.replace(/\\/g, '/');
          if (pending && (modPath === pending || modPath.endsWith(`/${pending}`))) {
            setShowRightAiDock(true);
            setAiTab('artifacts');
            setStatusNotice(`Inline Edit proposed diff: ${modPath}`);
            inlinePendingTargetRef.current = '';
          } else {
            setStatusNotice(`Modified file: ${modPath}`);
          }
        }
        void refreshWorkspaceTree();
        void refreshGitStatus();
        break;
      case 'runtime.error':
        setStatusNotice(`Runtime error: ${ev.payload.message}`);
        break;
      case 'sandbox.branch.created':
        setStatusNotice(
          `Sandbox branch: ${ev.payload.branch || 'evolve/*'} (from ${ev.payload.previousBranch || 'HEAD'})`
        );
        appendLog(
          `[Sandbox] ${ev.payload.message || `Created ${ev.payload.branch}`}`
        );
        void refreshGitStatus();
        break;
      case 'circuit.breaker.triggered':
        setStatusNotice(
          `Circuit breaker: rolled back ${(ev.payload.rolledBackFiles as string[] | undefined)?.length ?? 0} file(s)`
        );
        appendLog(
          `[CircuitBreaker] ${ev.payload.message || 'Session mutations rolled back after repeated verify failures'}`
        );
        void refreshWorkspaceTree();
        void refreshGitStatus();
        break;
      case 'artifact.created':
        setStatusNotice(
          `Artifact saved: ${ev.payload.title || ev.payload.artifactId} (${ev.payload.artifactType || 'report'})`
        );
        appendLog(
          `[Artifact] ${ev.payload.artifactType || 'report'}: ${ev.payload.title || ev.payload.artifactId}`
        );
        void refreshArtifactsAndCustomizations();
        if (String(ev.payload.artifactType || '') === 'plan' || String(ev.payload.source || '').includes('research')) {
          setShowRightAiDock(true);
          setAiTab('artifacts');
          if (ev.payload.artifactId) {
            setActiveArtifactId(String(ev.payload.artifactId));
          }
        }
        break;
    }
  }

  async function selectAndResumeSession(sessionId: string) {
    setActiveSessionId(sessionId);
    activeSessionIdRef.current = sessionId;
    pinComposerSession(sessionId);
    const seq = lastSeqBySessionRef.current[sessionId] || 0;
    const snapshot = await bridge.resumeSession(sessionId, seq);
    setMessages(snapshot.messages ?? []);
    setDiffs(snapshot.diffs ?? []);
    setPendingApprovals(snapshot.pendingApprovals ?? []);
    setPendingQuestions(snapshot.pendingQuestions ?? []);
    setBackgroundTasks(snapshot.backgroundTasks ?? []);
    setRecoveredFlag(Boolean(snapshot.recoveredAcrossInstanceRestart));
    setStreamingText('');
    setStreamingThinking('');
    setLiveToolCalls([]);
    setLiveTimeline([]);
    setIsSendingPrompt(runningSessionIdsRef.current.has(sessionId));
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


  function detectUiPromptIntent(rawText: string) {
    return detectUiPromptIntentUtil(rawText, executionMode);
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

  async function handleQuestionResponseSubmit(questionPrompt: any, skipped = false) {
    const qId = String(questionPrompt?.questionId || '');
    if (!qId) return;
    const selMap = questionSelections[qId] || {};
    const customMap = questionCustomInputs[qId] || {};
    const answers: Record<string, string | string[]> = {};
    for (const q of questionPrompt.questions || []) {
      const qKey = String(q.question || '');
      const selected = selMap[qKey] || [];
      const custom = (customMap[qKey] || '').trim();
      const combined = custom ? [...selected, custom] : selected;
      if (q.isMultiSelect) {
        answers[qKey] = combined.length > 0 ? combined : [q.options?.[0] || 'Default'];
      } else {
        answers[qKey] = combined[0] || q.options?.[0] || 'Default';
      }
    }
    setPendingQuestions((prev) => prev.filter((p) => p.questionId !== qId));
    try {
      await bridge.request(
        'question.respond',
        { questionId: qId, answers, skipped },
        activeSessionId || undefined
      );
      setStatusNotice(skipped ? 'Skipped question (using recommended defaults)' : 'Submitted clarification answers');
    } catch (err) {
      setStatusNotice(`Failed to submit answer: ${(err as Error).message}`);
    }
  }

  async function handleManageBackgroundTask(
    action: 'kill' | 'send_input' | 'list',
    taskId?: string,
    input?: string
  ) {
    try {
      const res = await bridge.request<any>(
        'task.manage',
        { action, taskId, input, sessionId: activeSessionId },
        activeSessionId || undefined
      );
      if (Array.isArray(res?.tasks)) {
        setBackgroundTasks(res.tasks);
      } else if (res?.task?.taskId) {
        setBackgroundTasks((prev) =>
          prev.map((t) => (t.taskId === res.task.taskId ? res.task : t))
        );
      }
      if (action === 'kill' && taskId) {
        setStatusNotice(`Terminated background task ${taskId}`);
      }
    } catch (err) {
      setStatusNotice(`Task action failed: ${(err as Error).message}`);
    }
  }

  function handleAttachImageFiles(fileList: FileList | File[]) {
    const arr = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    for (const file of arr.slice(0, 4)) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        if (!dataUrl) return;
        setAttachedImages((prev) => [
          ...prev.slice(-3),
          {
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: file.name || 'clipboard-image.png',
            dataUrl,
            mimeType: file.type || 'image/png',
          },
        ]);
      };
      reader.readAsDataURL(file);
    }
  }

  async function handleSendPrompt(
    overridePrompt?: string,
    overrideMode?: 'plan' | 'auto' | 'manual'
  ) {
    const raw = (overridePrompt ?? promptInput).trim();
    if (!raw) return;
    // Stage U: only queue when the *active* session is busy; other sessions may run in parallel
    const sendSessionId = activeSessionIdRef.current || activeSessionId;
    const activeBusy = sendSessionId
      ? runningSessionIdsRef.current.has(sendSessionId)
      : isSendingPrompt;
    if (activeBusy) {
      setPendingPromptQueue((prev) => [...prev, { prompt: raw, mode: overrideMode }].slice(-5));
      if (!overridePrompt) setPromptInput('');
      setStatusNotice(
        `Queued follow-up for this Composer (${Math.min(5, pendingPromptQueue.length + 1)} waiting).`
      );
      return;
    }

    const autoIntent = detectUiPromptIntent(raw);
    // Sticky "query-only" must not block deliverable prompts (PDF/md/tutorials).
    const resolvedChoice: 'query-only' | 'auto-action' =
      manualIntentChoice === 'auto-action'
        ? 'auto-action'
        : manualIntentChoice === 'query-only' && autoIntent.isQueryOnly
          ? 'query-only'
          : autoIntent.isQueryOnly
            ? 'query-only'
            : 'auto-action';

    const effectiveMode =
      overrideMode ?? (resolvedChoice === 'query-only' ? 'plan' : 'auto');
    if (effectiveMode !== executionMode) {
      setExecutionMode(effectiveMode);
      if (effectiveMode === 'auto' && executionMode === 'plan') {
        setStatusNotice(
          promptWantsWorkspaceArtifact(raw)
            ? '检测到需要生成文档/PDF，已从 Plan 自动切换为 Auto'
            : '已从 Plan 自动切换为 Auto（允许写入工作区）'
        );
      }
    }
    const imagesToSend = attachedImages.map((img) => ({
      name: img.name,
      dataUrl: img.dataUrl,
      mimeType: img.mimeType,
    }));
    setAttachedImages([]);
    setPromptInput('');
    setStreamingText('');
    setStreamingThinking('');
    setLiveToolCalls([]);
    setLiveTimeline([]);
    setGoalTokenUsage(null);
    setIsSendingPrompt(true);
    // Capture the session this turn belongs to (parallel-safe finally cleanup)
    let turnSessionId = sendSessionId;
    if (turnSessionId) markSessionRunning(turnSessionId, true);
    setStatusNotice('Agent is thinking and executing tools...');

    let finalPrompt = raw;
    if (!overridePrompt) {
      if (resolvedChoice === 'query-only' && !/^\[READ_ONLY_ANALYSIS\]/i.test(finalPrompt)) {
        finalPrompt = `[READ_ONLY_ANALYSIS] ${finalPrompt}`;
      } else if (
        resolvedChoice === 'auto-action' &&
        !/^\[FORCE_AUTO_ACTION\]/i.test(finalPrompt) &&
        !/^\[READ_ONLY_ANALYSIS\]/i.test(finalPrompt)
      ) {
        finalPrompt = `[FORCE_AUTO_ACTION] ${finalPrompt}`;
      }
    }

    // Sticky context chips → ensure corresponding @ mentions are present
    for (const chip of contextChips) {
      if (chip.kind === 'file' && !finalPrompt.includes(`@${chip.value}`)) {
        finalPrompt = `@${chip.value} ${finalPrompt}`;
      } else if (chip.kind === 'folder' && !/@folder\//i.test(finalPrompt)) {
        finalPrompt = `@folder/${chip.value} ${finalPrompt}`;
      } else if (chip.kind === 'builtin' && !finalPrompt.includes(chip.value)) {
        finalPrompt = `${chip.value} ${finalPrompt}`;
      } else if (chip.kind === 'code' && !/(?:^|\s)@code\b/i.test(finalPrompt)) {
        finalPrompt = `@code ${finalPrompt}`;
      } else if (chip.kind === 'tabs' && !/(?:^|\s)@tabs\b/i.test(finalPrompt)) {
        finalPrompt = `@tabs ${finalPrompt}`;
      }
    }

    if (
      (/(?:^|\s)@terminal\b/i.test(finalPrompt) || contextChips.some((c) => c.value === '@terminal')) &&
      terminalHistory.length > 0
    ) {
      const recentTerm = terminalHistory
        .slice(-3)
        .map((t) => `$ ${t.cmd} (exit=${t.exitCode})\n${(t.output || '').slice(0, 1500)}`)
        .join('\n\n');
      finalPrompt = `${finalPrompt}\n\n<mentioned_terminal_output>\n${recentTerm}\n</mentioned_terminal_output>`;
    }
    if (
      (/(?:^|\s)@code\b/i.test(finalPrompt) || contextChips.some((c) => c.kind === 'code')) &&
      editorSelection.hasSelection &&
      editorSelection.text
    ) {
      finalPrompt = `${finalPrompt}\n\n<mentioned_code_selection file="${activeTab?.path || ''}">\n${editorSelection.text.slice(0, 4000)}\n</mentioned_code_selection>`;
    }
    if (/(?:^|\s)@tabs\b/i.test(finalPrompt) || contextChips.some((c) => c.kind === 'tabs')) {
      const tabDigest = tabs
        .filter((t) => t.kind === 'code')
        .slice(0, 6)
        .map((t) => `### ${t.path}\n${(t.content || '').slice(0, 1200)}`)
        .join('\n\n');
      finalPrompt = `${finalPrompt}\n\n<mentioned_open_tabs>\n${tabDigest}\n</mentioned_open_tabs>`;
    }
    // @symbol chips / @symbol:Name → inject function/class body range from active file
    const symbolChips = contextChips.filter((c) => c.kind === 'symbol');
    const symbolTagMatches = [...finalPrompt.matchAll(/(?:^|\s)@symbol:([A-Za-z0-9_$.]+)/g)].map(
      (m) => m[1]
    );
    if (symbolChips.length > 0 || symbolTagMatches.length > 0) {
      const activeCode = tabs.find((t) => t.path === activeTabPath && t.kind === 'code');
      const lines = (activeCode?.content || '').split(/\r?\n/);
      const blocks: string[] = [];
      const want = new Set([
        ...symbolChips.map((c) => c.value),
        ...symbolTagMatches,
      ]);
      for (const sym of composerSymbols) {
        const key = `${sym.filePath}#${sym.name}`;
        if (
          !want.has(key) &&
          !want.has(sym.name) &&
          !want.has(`@symbol:${sym.name}`) &&
          !symbolChips.some((c) => c.label.includes(sym.name))
        ) {
          continue;
        }
        const slice = lines
          .slice(Math.max(0, sym.startLine - 1), Math.min(lines.length, sym.endLine))
          .join('\n')
          .slice(0, 3500);
        blocks.push(
          `### ${sym.kind} ${sym.name} (${sym.filePath}:L${sym.startLine}-L${sym.endLine})\n\`\`\`\n${slice}\n\`\`\``
        );
      }
      if (blocks.length > 0) {
        finalPrompt = `${finalPrompt}\n\n<mentioned_symbols>\n${blocks.join('\n\n')}\n</mentioned_symbols>`;
      }
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
        images: imagesToSend.length > 0 ? imagesToSend : undefined,
        sequence: messages.length + 1,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimisticUserMsg]);

      try {
        if (!turnSessionId) {
          await handleCreateSession(finalPrompt);
          turnSessionId = activeSessionIdRef.current;
          if (turnSessionId) markSessionRunning(turnSessionId, true);
        } else {
          try {
            await bridge.request(
              'session.send',
              {
                sessionId: turnSessionId,
                prompt: finalPrompt,
                workspaceRoot: workspaceRoot || undefined,
                executionMode: effectiveMode,
                modelId: modelInput || undefined,
                images: imagesToSend.length > 0 ? imagesToSend : undefined,
              },
              turnSessionId
            );
          if (activeSessionIdRef.current === turnSessionId) {
            await selectAndResumeSession(turnSessionId);
          }
        } catch (sendErr) {
          const sendErrMsg = (sendErr as Error).message || String(sendErr);
          if (sendErrMsg.includes('SESSION_NOT_FOUND')) {
            await handleCreateSession(finalPrompt);
            turnSessionId = activeSessionIdRef.current;
          } else {
            throw sendErr;
          }
        }
      }
      await refreshWorkspaceTree();
      await refreshGitStatus();
      await refreshArtifactsAndCustomizations();
      if (activeSessionIdRef.current === turnSessionId) {
        setStatusNotice('Agent response completed');
      } else {
        setStatusNotice(`Background Composer finished (${String(turnSessionId).slice(0, 10)}…)`);
      }
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      setStatusNotice(`Agent error: ${errMsg}`);
      if (activeSessionIdRef.current === turnSessionId) {
        setMessages((prev) => [
          ...prev,
          {
            id: `err_${Date.now()}`,
            sessionId: turnSessionId || 'err',
            role: 'assistant',
            content: `⚠️ Request failed: ${errMsg}`,
            sequence: prev.length + 1,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    } finally {
      if (turnSessionId) markSessionRunning(turnSessionId, false);
      if (activeSessionIdRef.current === turnSessionId) {
        setIsSendingPrompt(false);
        setLiveToolCalls([]);
        setStreamingText('');
      }
      // Drain follow-ups only for the active Composer that owns this turn
      if (activeSessionIdRef.current === turnSessionId && !drainPromptQueueRef.current) {
        drainPromptQueueRef.current = true;
        setPendingPromptQueue((prev) => {
          if (prev.length === 0) {
            drainPromptQueueRef.current = false;
            return prev;
          }
          const [next, ...rest] = prev;
          queueMicrotask(() => {
            drainPromptQueueRef.current = false;
            void handleSendPrompt(next.prompt, next.mode);
          });
          return rest;
        });
      } else if (activeSessionIdRef.current === turnSessionId) {
        drainPromptQueueRef.current = false;
      }
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

  function addContextChip(chip: { kind: string; label: string; value: string }) {
    setContextChips((prev) => {
      if (prev.some((c) => c.value === chip.value && c.kind === chip.kind)) return prev;
      return [...prev, { id: `chip_${Date.now()}_${prev.length}`, ...chip }].slice(-12);
    });
  }


  async function loadCheckpointPreviewDiffs(ck: any) {
    const files = Array.isArray(ck?.files) ? ck.files : [];
    const out: Array<{ path: string; summary: string; preview: string }> = [];
    for (const f of files.slice(0, 3)) {
      const rel = String(f.path || f.filePath || '').replace(/\\/g, '/');
      if (!rel) continue;
      const snap = typeof f.content === 'string' ? f.content : '';
      let current = '';
      const open = tabs.find((t) => t.path.replace(/\\/g, '/') === rel);
      if (open && typeof open.content === 'string') {
        current = open.content;
      } else {
        try {
          const res = await fetch(`/api/workspace/raw?path=${encodeURIComponent(rel)}`);
          current = res.ok ? await res.text() : '';
        } catch {
          current = '';
        }
      }
      // Diff direction: current (disk/tab) → checkpoint snapshot (what Restore would write)
      const { summary, preview } = buildCheckpointContentDiff(current, snap);
      out.push({ path: rel, summary, preview });
    }
    setCheckpointPreviewDiffs(out);
  }

  async function refreshSessionCheckpoints(sessionId?: string) {
    const sid = sessionId || activeSessionId;
    if (!sid) {
      setSessionCheckpoints([]);
      return;
    }
    try {
      const list = await bridge.request<any[]>(
        'session.checkpoint.list',
        { sessionId: sid },
        sid
      );
      setSessionCheckpoints(Array.isArray(list) ? list : []);
    } catch {
      setSessionCheckpoints([]);
    }
  }

  async function refreshTaskTrace(sessionId?: string) {
    const sid = sessionId || activeSessionId;
    if (!sid) {
      setActiveTaskTrace(null);
      return;
    }
    try {
      const snap = await bridge.request<any>('trace.get', { sessionId: sid }, sid);
      setActiveTaskTrace(snap || null);
    } catch {
      setActiveTaskTrace(null);
    }
  }

  async function handleReviewAllPending(action: 'accept' | 'reject') {
    const sid = activeSessionId || sessions[0]?.sessionId;
    if (!sid) return;
    try {
      const updated = await bridge.request<any[]>(
        'diff.reviewAll',
        { sessionId: sid, action },
        sid
      );
      if (Array.isArray(updated)) {
        setDiffs((prev) => {
          const map = new Map(updated.map((d) => [d.diffId, d]));
          return prev.map((d) => map.get(d.diffId) || d);
        });
      }
      await refreshWorkspaceTree();
      await refreshGitStatus();
      setStatusNotice(
        action === 'accept'
          ? `Accepted ${updated?.length ?? 0} pending change(s)`
          : `Rejected ${updated?.length ?? 0} pending change(s)`
      );
    } catch (err) {
      setStatusNotice(`Bulk diff review failed: ${(err as Error).message}`);
    }
  }

  async function handleStopAgent() {
    if (!activeSessionId) {
      setIsSendingPrompt(false);
      setLiveToolCalls([]);
      setStreamingText('');
      return;
    }
    try {
      const res = await bridge.cancelSession(activeSessionId);
      markSessionRunning(activeSessionId, false);
      setIsSendingPrompt(false);
      setLiveToolCalls([]);
      setStreamingText('');
      const pending = Number(res?.pendingDiffsPreserved ?? diffs.filter((d) => d.status === 'pending').length);
      if (pending > 0) {
        setAiTab('changes');
        setShowRightAiDock(true);
        setStatusNotice(`Stopped. ${pending} pending Diff(s) preserved for Accept/Reject.`);
      } else {
        setStatusNotice('Agent stopped.');
      }
    } catch (err) {
      markSessionRunning(activeSessionId, false);
      setIsSendingPrompt(false);
      setLiveToolCalls([]);
      setStreamingText('');
      setStatusNotice(`Stop failed: ${(err as Error).message}`);
    }
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

  function getDiffHunks(diff: any): DiffHunkView[] {
    return parseDiffHunks({
      unifiedDiff: String(diff?.unifiedDiff || ''),
      originalContent: String(diff?.originalContent || ''),
      proposedContent: String(diff?.proposedContent || ''),
    });
  }

  async function handleHunkDecision(
    diff: any,
    hunkIndex: number,
    action: 'accepted' | 'rejected'
  ) {
    const hunks = getDiffHunks(diff);
    if (hunks.length === 0) {
      setStatusNotice('No hunks available for this Diff');
      return;
    }

    let nextDecisions: Array<'pending' | 'accepted' | 'rejected'> = [];
    setHunkDecisions((prev) => {
      const cur =
        prev[diff.diffId] && prev[diff.diffId].length === hunks.length
          ? [...prev[diff.diffId]]
          : hunks.map(() => 'pending' as const);
      cur[hunkIndex] = action;
      nextDecisions = cur;
      return { ...prev, [diff.diffId]: cur };
    });
    // Allow React state setter to flush nextDecisions synchronously for this call
    if (nextDecisions.length === 0) {
      nextDecisions = hunks.map((_, i) =>
        i === hunkIndex ? action : ('pending' as const)
      );
    }

    const rebuilt = rebuildProposedAfterHunkDecision({
      originalContent: String(diff.originalContent || ''),
      hunks,
      decisions: nextDecisions,
    });

    const targetSessionId =
      diff.sessionId || activeSessionId || sessions[0]?.sessionId || 'default';

    try {
      if (rebuilt.remainingPending === 0) {
        const finalize =
          rebuilt.acceptedCount === 0 ? 'reject' : ('accept' as const);
        const updated = await bridge.request(
          'diff.updateProposed',
          {
            sessionId: targetSessionId,
            diffId: diff.diffId,
            proposedContent: rebuilt.proposedContent,
            writeToDisk: true,
            finalize,
          },
          targetSessionId
        );
        setDiffs((prev) =>
          prev.map((d) => (d.diffId === diff.diffId ? { ...d, ...updated } : d))
        );
        setHunkDecisions((p) => {
          const next = { ...p };
          delete next[diff.diffId];
          return next;
        });
        await refreshWorkspaceTree();
        await refreshGitStatus();
        setStatusNotice(
          finalize === 'accept'
            ? `Accepted ${rebuilt.acceptedCount} hunk(s) in ${diff.filePath}`
            : `Rejected all hunks in ${diff.filePath}`
        );
        return;
      }

      const updated = await bridge.request(
        'diff.updateProposed',
        {
          sessionId: targetSessionId,
          diffId: diff.diffId,
          proposedContent: rebuilt.proposedContent,
          writeToDisk: true,
          finalize: 'keep',
        },
        targetSessionId
      );
      setDiffs((prev) =>
        prev.map((d) => (d.diffId === diff.diffId ? { ...d, ...updated } : d))
      );
      setStatusNotice(
        `${action === 'accepted' ? 'Accepted' : 'Rejected'} hunk ${hunkIndex + 1}/${hunks.length} · ${rebuilt.remainingPending} remaining`
      );
    } catch (err) {
      setStatusNotice(`Hunk review error: ${(err as Error).message}`);
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
    setStatusNotice(`正在测试模型连通性 (${selectedProviderId} / ${modelInput})...`);
    try {
      // Always persist the selected provider, endpoint, model, and optional key before running the smoke test
      const rawEndpoint = endpointInput.trim();
      const isLocalEndpoint =
        /^(?:https?:\/\/)?(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.0\.0\.1|localhost)/i.test(
          rawEndpoint
        );
      const nextEndpoint = !rawEndpoint
        ? ''
        : /^https?:\/\//i.test(rawEndpoint)
          ? rawEndpoint
          : isLocalEndpoint
            ? `http://${rawEndpoint}`
            : `https://${rawEndpoint}`;
      if (nextEndpoint && nextEndpoint !== endpointInput) {
        setEndpointInput(nextEndpoint);
      }
      const saved = await bridge.request('provider.update', {
        providerId: selectedProviderId,
        apiEndpoint: nextEndpoint,
        modelId: modelInput.trim(),
        apiKey:
          apiKeyInput.trim() ||
          (selectedProviderId === 'glm' || isLocalEndpoint ? 'EMPTY' : undefined),
      });
      const refreshed = await bridge.request<any>('provider.get').catch(() => null);
      setProviderData(refreshed || ((prev: any) => ({ ...prev, active: saved.active })));
      if (apiKeyInput.trim()) {
        setApiKeyInput('');
      }
      const res = await bridge.request('provider.test', {
        providerId: selectedProviderId,
        modelId: modelInput,
      });
      setSmokeResult(res);
      setStatusNotice(
        res.ok
          ? `✓ 模型连通性验证通过 (${selectedProviderId}/${modelInput}, ${res.latencyMs}ms)`
          : `✗ 模型连通性测试失败: ${res.diagnostic?.userMessage || '请检查接口地址与配置'}`
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


  /** Stage T: jump from tool card / Changes hunk → editor line + Changes tab */
  function jumpToDiffHunk(diff: any, hunkIndex = 0) {
    if (!diff) return;
    setAiTab('changes');
    const hunks = getDiffHunks(diff);
    const hunk = hunks[Math.max(0, Math.min(hunkIndex, Math.max(0, hunks.length - 1)))];
    const line =
      Number(hunk?.oldStart) ||
      Number(String(hunk?.header || '').match(/\+(\d+)/)?.[1]) ||
      1;
    void openFileInTab(String(diff.filePath || ''), true, true, line);
    setStatusNotice(
      `Jumped to Diff hunk ${hunk ? hunk.index + 1 : '?'} · ${diff.filePath}:${line}`
    );
  }

  function findPendingDiffForTool(tc: any): any | null {
    const input = tc?.input || {};
    const output = tc?.output || tc?.result || {};
    const byId =
      output?.diffId ||
      output?.diff_id ||
      (Array.isArray(output?.files) ? output.files[0]?.diffId : null);
    if (byId) {
      const hit = diffs.find((d) => d.diffId === byId);
      if (hit) return hit;
    }
    const filePath = String(
      input.filePath || input.path || output?.filePath || output?.files?.[0]?.filePath || ''
    ).replace(/\\/g, '/');
    if (!filePath) return null;
    const normTail = filePath.replace(/^\.\//, '');
    const byPath = (statusPrefer: string[]) =>
      diffs.find((d) => {
        if (!statusPrefer.includes(String(d.status || ''))) return false;
        const fp = String(d.filePath || '').replace(/\\/g, '/');
        return fp.endsWith(normTail) || normTail.endsWith(fp);
      });
    // Prefer pending, then any matching Diff so chat history Jump still works after Accept
    return byPath(['pending']) || byPath(['accepted', 'rejected', 'revised']) || null;
  }

  /** Stage V: debounced LSP diagnostics while typing → Problems + gutter */
  function triggerDebouncedLiveDiagnostics(filePath: string, content: string) {
    if (!filePath || !/\.(tsx?|jsx?|mjs|cjs|py|c|cc|cpp|cxx|h|hpp)$/i.test(filePath)) return;
    if (liveDiagTimerRef.current) clearTimeout(liveDiagTimerRef.current);
    liveDiagTimerRef.current = setTimeout(async () => {
      const seq = ++liveDiagSeqRef.current;
      liveDiagAbortRef.current?.abort();
      const controller = new AbortController();
      liveDiagAbortRef.current = controller;
      try {
        const res = await fetch('/api/lsp/diagnostics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ filePath, content }),
        }).then((r) => r.json());
        if (seq !== liveDiagSeqRef.current) return;
        const diags = Array.isArray(res?.diagnostics) ? res.diagnostics : [];
        const marks = new Map<number, string>();
        for (const d of diags) {
          marks.set(Number(d.line) || 1, `${d.severity || 'info'}: ${d.message}`);
        }
        setProblemGutterLines(marks);
        if (Array.isArray(res?.problems)) {
          setWorkspaceProblems(res.problems);
        } else if (diags.length > 0) {
          setWorkspaceProblems((prev) => {
            const norm = filePath.replace(/\\/g, '/');
            const kept = prev.filter((p) => {
              const pf = String(p.file || '').replace(/\\/g, '/');
              return !(pf === norm || norm.endsWith(pf) || pf.endsWith(norm));
            });
            return [
              ...kept,
              ...diags.map((d: any) => ({
                file: String(d.file || filePath),
                line: Number(d.line) || 1,
                column: Number(d.column) || 1,
                severity: String(d.severity || 'error'),
                message: String(d.message || ''),
              })),
            ];
          });
        }
      } catch {
        // aborted or transient — ignore
      }
    }, 700);
  }

  function triggerDebouncedGhostAutocomplete(content: string, cursorPosOffset: number) {
    if (!autocompleteEnabled) return;
    if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current);
    autocompleteTimerRef.current = setTimeout(async () => {
      const reqSeq = ++ghostRequestSeqRef.current;
      ghostAbortRef.current?.abort();
      const controller = new AbortController();
      ghostAbortRef.current = controller;
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
          signal: controller.signal,
        }).then((r) => r.json());
        if (reqSeq !== ghostRequestSeqRef.current) return;
        if (res?.ok && typeof res.completion === 'string' && res.completion.length > 0) {
          setGhostText(res.completion);
        } else {
          setGhostText('');
        }
      } catch {
        if (reqSeq === ghostRequestSeqRef.current) setGhostText('');
      }
    }, 220);
  }

  function parseSourceReferenceToken(rawToken: string) {
    return parseSourceReferenceTokenUtil(rawToken, files);
  }

  function extractLatestSourceRefFromText(
    textChunk: string,
    prevRef?: { filePath?: string; startLine?: number; endLine?: number }
  ) {
    return extractLatestSourceRefFromTextUtil(textChunk, prevRef, files);
  }

  function extractCompactExecutiveSummary(cleaned: string) {
    return extractCompactExecutiveSummaryUtil(cleaned, files);
  }

  function renderSyntaxHighlightedLine(
    line: string,
    lineIdx: number,
    isActiveLine: boolean,
    diffKind?: DiffLineKind
  ): React.ReactNode {
    return renderSyntaxHighlightedLineUtil(line, lineIdx, isActiveLine, diffKind, ghostText);
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

  const activeTab = tabs.find((t) => t.path === activeTabPath);
  const codeLines = (activeTab?.content ?? '').split('\n');
  const pendingDiffForActive =
    activeTab?.kind === 'code'
      ? diffs.find(
          (d) =>
            d.status === 'pending' &&
            String(d.filePath || '').replace(/\\/g, '/') ===
              String(activeTab.path || '').replace(/\\/g, '/')
        )
      : undefined;
  const pendingDiffMarks = pendingDiffForActive
    ? marksFromDiffRecord(pendingDiffForActive)
    : new Map<number, DiffLineKind>();

  const { renderFormattedMarkdown } = createMarkdownRenderer({
    workspaceRoot,
    files,
    expandedMessageIds,
    setExpandedMessageIds,
    carouselSlideIndices,
    setCarouselSlideIndices,
    installedCatalogPlugins,
    setInstalledCatalogPlugins,
    setAiTab,
    setShowRightAiDock,
    setShowLeftSidebar,
    setActiveActivity,
    setShowBottomPanel,
    setActiveBottomTab,
    openSettingsCenter,
    openWebPreviewTab,
    setStatusNotice,
    bridge,
    activeSessionId,
    navigateToSourceLocation,
    navigateToAiCodeSnippet,
    navigateToInlineCodeOrSymbol,
    parseSourceReferenceToken,
    extractLatestSourceRefFromText,
    extractCompactExecutiveSummary,
  });

  const workbenchCtx = {
    showLeftSidebar, setShowLeftSidebar,
    showBottomPanel, setShowBottomPanel,
    showRightAiDock, setShowRightAiDock,
    leftSidebarWidth, setLeftSidebarWidth,
    rightAiDockWidth, setRightAiDockWidth,
    bottomPanelHeight, setBottomPanelHeight,
    settingsNavWidth, setSettingsNavWidth,
    draggingSash, startPaneResize,
    bodyGridStyle, centerGridStyle,
    isSendingPrompt, setIsSendingPrompt,
    runningSessionIds, setRunningSessionIds,
    composerSessionTabs, setComposerSessionTabs,
    agentMemoryEntries, setAgentMemoryEntries,
    activeActivity, setActiveActivity,
    activeBottomTab, setActiveBottomTab,
    openMenu, setOpenMenu,
    showGearPopup, setShowGearPopup,
    showLangPopup, setShowLangPopup,
    showPalette, setShowPalette,
    paletteMode, setPaletteMode,
    symbolPaletteItems, setSymbolPaletteItems,
    workspaceProblems, setWorkspaceProblems,
    paletteQuery, setPaletteQuery,
    showProjectModal, setShowProjectModal,
    customFolderInput, setCustomFolderInput,
    showCreateModal, setShowCreateModal,
    createTargetName, setCreateTargetName,
    workspaceRoot, setWorkspaceRoot,
    workspaceName, setWorkspaceName,
    fileTree, setFileTree,
    files, setFiles,
    expandedDirs, setExpandedDirs,
    tabs, setTabs,
    activeTabPath, setActiveTabPath,
    settingsCategory, setSettingsCategory,
    guideSection, setGuideSection,
    appLocale, setAppLocaleState,
    imageZoom, setImageZoom,
    imageBgPattern, setImageBgPattern,
    imageDimensions, setImageDimensions,
    ghostText, setGhostText,
    autocompleteEnabled, setAutocompleteEnabled,
    diffViewMode, setDiffViewMode,
    cursorPos, setCursorPos,
    ideSettings, setIdeSettings,
    newAllowlistCmd, setNewAllowlistCmd,
    newMcpName, setNewMcpName,
    newMcpCmd, setNewMcpCmd,
    newMcpEnv, setNewMcpEnv,
    newMcpTransport, setNewMcpTransport,
    newMcpHeaders, setNewMcpHeaders,
    mcpTestResult, setMcpTestResult,
    isTestingMcp, setIsTestingMcp,
    checkpointPreviewDiffs, setCheckpointPreviewDiffs,
    problemGutterLines, setProblemGutterLines,
    registeredCapabilities, setRegisteredCapabilities,
    searchQuery, setSearchQuery,
    searchResults, setSearchResults,
    gitState, setGitState,
    terminalInput, setTerminalInput,
    terminalHistory, setTerminalHistory,
    runtimeLogs, setRuntimeLogs,
    sessions, setSessions,
    activeSessionId, setActiveSessionId,
    messages, setMessages,
    streamingText, setStreamingText,
    streamingThinking, setStreamingThinking,
    liveToolCalls, setLiveToolCalls,
    liveTimeline, setLiveTimeline,
    showLiveSteps, setShowLiveSteps,
    pendingApprovals, setPendingApprovals,
    pendingQuestions, setPendingQuestions,
    questionSelections, setQuestionSelections,
    questionCustomInputs, setQuestionCustomInputs,
    backgroundTasks, setBackgroundTasks,
    carouselSlideIndices, setCarouselSlideIndices,
    artifactComments, setArtifactComments,
    artifactCommentInput, setArtifactCommentInput,
    installedCatalogPlugins, setInstalledCatalogPlugins,
    attachedImages, setAttachedImages,
    imageFileInputRef,
    diffs, setDiffs,
    recoveredFlag, setRecoveredFlag,
    executionMode, setExecutionMode,
    manualIntentChoice, setManualIntentChoice,
    promptInput, setPromptInput,
    attachActiveFile, setAttachActiveFile,
    aiTab, setAiTab,
    contextChips, setContextChips,
    sessionCheckpoints, setSessionCheckpoints,
    lastModelTier, setLastModelTier,
    goalTokenUsage, setGoalTokenUsage,
    activeTaskTrace, setActiveTaskTrace,
    pendingPromptQueue, setPendingPromptQueue,
    hunkDecisions, setHunkDecisions,
    mentionActiveIndex, setMentionActiveIndex,
    composerSymbols, setComposerSymbols,
    checkpointPreviewId, setCheckpointPreviewId,
    showInlineCommand, setShowInlineCommand,
    inlineCommandInput, setInlineCommandInput,
    editorSelection, setEditorSelection,
    artifactsList, setArtifactsList,
    activeArtifactId, setActiveArtifactId,
    workspaceCustomizations, setWorkspaceCustomizations,
    previewUrlInput, setPreviewUrlInput,
    previewReloadKey, setPreviewReloadKey,
    providerData, setProviderData,
    selectedProviderId, setSelectedProviderId,
    endpointInput, setEndpointInput,
    modelInput, setModelInput,
    apiKeyInput, setApiKeyInput,
    smokeResult, setSmokeResult,
    isTestingKey, setIsTestingKey,
    backendStatus, setBackendStatus,
    extensionsCatalog, setExtensionsCatalog,
    vsixFileName, setVsixFileName,
    vsixConfirmed, setVsixConfirmed,
    diagnosticsDump, setDiagnosticsDump,
    statusNotice, setStatusNotice,
    showSshModal, setShowSshModal,
    sshStatus, setSshStatus,
    sshProfiles, setSshProfiles,
    sshQuickCmd, setSshQuickCmd,
    sshForm, setSshForm,
    sshTestResult, setSshTestResult,
    isTestingSsh, isConnectingSsh,
    sshBrowseData, setSshBrowseData,
    workspaceSectionOpen, setWorkspaceSectionOpen,
    expandedMessageIds, setExpandedMessageIds,
    aiMessagesEndRef, codeGutterRef, codeHighlightRef, codeTextareaRef,
    currentTheme, isLightTheme, locale, t, tr, displayWorkspaceName,
    activeTab, codeLines, pendingDiffForActive, pendingDiffMarks,
    bridge,
    setAppLocale, getMessageForLocale, toggleColorTheme,
    appendLog, openUserGuide, openSettingsCenter, openWebPreviewTab,
    refreshArtifactsAndCustomizations, syncEditorSelectionFromTextarea,
    handleInlineCommandSubmit, triggerCodeLensAction, handleScaffoldCustomization,
    bootstrapIde, loadServerIdeSettings, persistIdeSettings,
    refreshWorkspaceTree, handleOpenProjectAction, switchProjectFolder,
    handleCloseFolder, handleCloseWindow, handleCreateFileOrFolder,
    refreshGitStatus, resolveWorkspaceFilePath, scrollEditorToLine,
    openFileInTab, navigateToSourceLocation, openDiffInTab, closeTab,
    saveCurrentTab, saveAllTabs, handleWorkspaceSearch, refreshWorkspaceProblems,
    openGoToSymbolPalette, jumpToDefinitionAtCursor, refreshLspDiagnosticsForActiveFile,
    handleSshReconnect, handleSshConflictCheck, handleRunTerminalCommand,
    markSessionRunning, pinComposerSession, refreshAgentMemory,
    selectAndResumeSession, handleCreateSession, detectUiPromptIntent,
    handleAutoBuildDiagnoseAndFix, handleQuestionResponseSubmit,
    handleManageBackgroundTask, handleAttachImageFiles, handleSendPrompt,
    handleApprovalDecision, addContextChip, loadCheckpointPreviewDiffs,
    refreshSessionCheckpoints, refreshTaskTrace, handleReviewAllPending,
    handleStopAgent, handleDiffReview, getDiffHunks, handleHunkDecision,
    handleSimulateExtensionHostRestart, handleExportDiagnostics, handleTestAiKey,
    openSshConnectionModal, parseQuickSshCommand, handleTestSshConnection,
    handleSaveSshProfile, handleDeleteSshProfile, handleBrowseRemoteSsh,
    handleConnectSshHost, handleDisconnectSshHost,
    handleNavigateToParentDirectory, handleNavigateIntoDirectory,
    jumpToDiffHunk, findPendingDiffForTool,
    triggerDebouncedLiveDiagnostics, triggerDebouncedGhostAutocomplete,
    navigateToAiCodeSnippet, navigateToInlineCodeOrSymbol,
    renderFormattedMarkdown,
    renderSyntaxHighlightedLine,
  };

  return workbenchCtx;
}
