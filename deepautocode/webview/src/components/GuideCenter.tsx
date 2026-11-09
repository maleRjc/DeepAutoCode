import React from 'react';
import { BrandMark } from './BrandMark';
import { APP_LOCALES } from '../i18n/index.js';
import {
  formatCompactTokens,
  IMAGE_FILE_EXT_PATTERN,
  getImageMimeType,
  wordAtCursor,
  buildCheckpointContentDiff,
  formatToolStepLabel,
  parseDiffToSplitRows,
  parseSourceReferenceToken,
  findBestLineMatchInContent,
  formatLatexMathText,
  extractLatestSourceRefFromText,
  extractCompactExecutiveSummary,
  getFileVisualMeta,
  renderSyntaxHighlightedLine,
} from '../utils/workbenchUtils';

export function GuideCenter({ ctx }: { ctx: any }) {
  const {
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
    liveToolCalls, setLiveToolCalls,
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
  } = ctx;


  return (
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
                      <span style={{ fontWeight: 700 }}>{t('guide.title')}</span>
                    </div>
                  </div>

                  <div style={{ padding: '4px 8px 10px 8px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {APP_LOCALES.map((loc) => (
                      <button
                        key={loc.id}
                        className={`btn ${locale === loc.id ? 'primary' : ''}`}
                        style={{ flex: 1, minWidth: 72, padding: '3px 6px', fontSize: 11 }}
                        onClick={() => setAppLocale(loc.id)}
                        title={loc.englishLabel}
                      >
                        {loc.nativeLabel}
                      </button>
                    ))}
                  </div>

                  {[
                    { id: 'quickstart', icon: '🚀', label: tr('1. 快速上手配置', '1. Quick Start')},
                    { id: 'workbench', icon: '🖥️', label: tr('2. 工作台与布局', '2. Workbench Layout')},
                    { id: 'modes', icon: '🤖', label: tr('3. 三种 AI 模式', '3. AI Execution Modes')},
                    { id: 'workflows', icon: '⚡', label: tr('4. 斜杠 / 与引用 @', '4. / Slash & @ Mentions')},
                    { id: 'inline', icon: '✨', label: tr('5. 行内 AI (Ctrl+I)', '5. Inline AI & CodeLens')},
                    { id: 'artifacts', icon: '📑', label: tr('6. 制品 / 子代理 / Token', '6. Artifacts & Tokens')},
                    { id: 'agent', icon: '🛠️', label: tr('7. Agent 编程引擎', '7. Agent Coding Engine')},
                    { id: 'preview-ssh', icon: '🌐', label: tr('8. 网页预览与 SSH', '8. Web Preview & SSH')},
                    { id: 'shortcuts', icon: '⌨️', label: tr('9. 快捷键速查表', '9. Shortcuts & Cheat Sheet')},
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
                      📄 {t('guide.openMd')}
                    </button>
                    <button
                      className="btn"
                      style={{ width: '100%', fontSize: 11, padding: '4px 8px' }}
                      onClick={() => openSettingsCenter('general')}
                    >
                      ⚙️ {t('guide.openSettings')}
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
                        {tr('🚀 1. 快速上手与项目打开 (Quick Start)', '🚀 1. Quick Start & Project Setup')}
                      </div>
                      <div className="settings-section-desc">
                        {tr('DeepAutoCode 是 Agent-first 自动编码工作台（非完整 VS Code/Cursor 替代）。首次启动保持极简欢迎界面；打开本地项目或 SSH 后即可进入四面板工作台，用 /goal、Plan→执行、验证门禁完成端到端落地。', 'DeepAutoCode is an Agent-first coding workbench (not a full VS Code/Cursor replacement). Clean welcome screen; open a folder or SSH host, then use /goal, Plan→Execute, and verify gates for end-to-end landing.')}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {tr('步骤 1：打开工作区项目', 'Step 1: Open a Project Workspace')}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {tr('点击顶部菜单 File -> Open Folder (Ctrl+O) 打开本地工程，或者点击 Connect via SSH (Ctrl+Alt+O) 直连远程 Linux 开发机。', 'Click File -> Open Folder (Ctrl+O) to open a local repository, or click Connect via SSH (Ctrl+Alt+O) for remote Linux development.')}
                        </p>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button className="btn primary" onClick={() => void handleOpenProjectAction()}>
                            📂 {tr('打开本地项目文件夹 (Ctrl+O)', 'Open Local Folder (Ctrl+O)')}
                          </button>
                          <button className="btn" onClick={() => void openSshConnectionModal()}>
                            🌐 {tr('连接远程 SSH 主机 (Ctrl+Alt+O)', 'Connect via SSH (Ctrl+Alt+O)')}
                          </button>
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {tr('步骤 2：配置 AI 模型与 API 密钥', 'Step 2: Configure AI Model & API Key')}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {tr('支持 DeepSeek（推荐 Composer 选 ⚡ Auto Router，复杂编辑/自愈会升档 reasoner）、OpenAI 兼容（Ollama / vLLM / 网关）与 Anthropic Claude。密钥存于系统 SecretStorage。可选在设置中配置 .deepautocode/verify.json 验证门禁与 evolve 沙箱。', 'DeepSeek (prefer ⚡ Auto Router — escalates to reasoner on hard edits/self-heal), OpenAI-Compatible (Ollama/vLLM/Gateway), and Anthropic Claude. Keys live in OS SecretStorage. Optionally configure .deepautocode/verify.json and evolve sandbox in Settings.')}
                        </p>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button className="btn primary" onClick={() => openSettingsCenter('models')}>
                            🤖 {tr('配置 AI 模型与 Provider (Ctrl+Shift+J)', 'Configure AI Models (Ctrl+Shift+J)')}
                          </button>
                          <button className="btn" onClick={() => void handleTestAiKey()}>
                            ⚡ {tr('测试当前 AI 连通性', 'Test AI Connectivity')}
                          </button>
                          <button className="btn" onClick={() => openSettingsCenter('security')}>
                            🛡️ {tr('配置验证门禁 verify.json', 'Configure verify.json Gate')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Section 2: Workbench Layout */}
                  {guideSection === 'workbench' && (
                    <div>
                      <div className="settings-section-title">
                        {tr('🖥️ 2. 工作台布局与四大工作区 (Workbench Layout)', '🖥️ 2. Workbench Layout & Navigation')}
                      </div>
                      <div className="settings-section-desc">
                        {tr('DeepAutoCode 采用标准的 Antigravity / Cursor 四面板弹性网格布局，支持自由拖拽调节尺寸与快捷键随时唤出/隐藏。', 'Standard Antigravity / Cursor 4-pane resizable grid layout with full keyboard shortcuts and collapsible panels.')}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10, fontSize: 14 }}>
                          {tr('四大核心面板功能与快捷键', 'Core Panes & Keyboard Shortcuts')}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13 }}>◧ {tr('左侧主侧边栏 (Primary Sidebar)', 'Primary Sidebar')}</strong>
                              <kbd className="welcome-kbd">Ctrl+B</kbd>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                              {tr('包含文件管理器 (Explorer)、全局代码搜索 (Search)、Git 源代码管理、Open VSX 扩展市场。', 'Includes Project Explorer, Global Search, Git Source Control, and Open VSX Extensions.')}
                            </div>
                            <button className="btn" style={{ marginTop: 8, padding: '3px 8px', fontSize: 11 }} onClick={() => setShowLeftSidebar((v) => !v)}>
                              {tr('切换左侧栏显示', 'Toggle Left Sidebar')}
                            </button>
                          </div>

                          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13 }}>◨ {tr('底部面板 (Bottom Panel)', 'Bottom Panel')}</strong>
                              <kbd className="welcome-kbd">Ctrl+J</kbd>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                              {tr('内置集成终端 (Terminal)、代码语法与编译问题 (Problems)、高危命令审计日志 (Audit)、Extension Host 运行时输出。', 'Integrated Terminal, Problems, Security Audit Logs, and Extension Host Runtime Output.')}
                            </div>
                            <button className="btn" style={{ marginTop: 8, padding: '3px 8px', fontSize: 11 }} onClick={() => setShowBottomPanel((v) => !v)}>
                              {tr('切换底部面板显示', 'Toggle Bottom Panel')}
                            </button>
                          </div>

                          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13 }}>✨ {tr('右侧 AI Agent 面板', 'AI Agent Dock')}</strong>
                              <kbd className="welcome-kbd">Ctrl+L</kbd>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                              {tr('Composer（模型 tier + Goal token 用量）、Artifacts 一键执行、Sessions/检查点 Restore、Changes 多文件 Diff（Accept/Reject/Revise）、审批卡片与执行模式。', 'Composer (model tier + Goal tokens), Artifacts one-click execute, Sessions/checkpoints, Changes Diff Accept/Reject/Revise, approvals, and modes.')}
                            </div>
                            <button className="btn primary" style={{ marginTop: 8, padding: '3px 8px', fontSize: 11 }} onClick={() => setShowRightAiDock((v) => !v)}>
                              {tr('切换右侧 AI 栏显示', 'Toggle AI Dock')}
                            </button>
                          </div>

                          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13 }}>🌐 {tr('内置 Web 实时预览', 'Live Web Preview')}</strong>
                              <span className="badge success">Preview</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                              {tr('在主编辑区一键打开本地项目（如 http://localhost:3000/）内嵌预览，支持网页交互与 AI 审查。', 'Preview local web apps (e.g. http://localhost:3000/) directly in an editor tab with AI inspection.')}
                            </div>
                            <button className="btn" style={{ marginTop: 8, padding: '3px 8px', fontSize: 11 }} onClick={() => openWebPreviewTab()}>
                              {tr('打开 Web 预览标签页', 'Open Web Preview')}
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
                        {tr('🤖 3. 三大 AI 执行模式与安全边界 (AI Execution Modes)', '🤖 3. Three AI Execution Modes & Security')}
                      </div>
                      <div className="settings-section-desc">
                        {tr('三级执行权限 + Diff 先提案。Auto 首次写入可创建 evolve/auto-* 沙箱分支；自愈耗尽触发熔断回滚。Plan 模式只读规划，点 Artifacts 一键执行后强制落地。', 'Three permission tiers + Diff-first proposals. Auto may create evolve/auto-* sandbox branches; exhausted self-heal triggers circuit-breaker rollback. Plan stays read-only until Artifacts one-click execute.')}
                      </div>

                      <div className="settings-card">
                        <div className="settings-row" style={{ alignItems: 'flex-start', paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span className="badge success" style={{ fontSize: 11 }}>∞ Agent (Auto)</span>
                              <strong style={{ fontSize: 13.5 }}>{tr('自动执行模式 (默认推荐)', 'Auto Mode (Default)')}</strong>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {tr('自主探查、apply_patch/edit_file 写入、白名单命令（git status、npm test、npm run build…）。高危命令仍需审批。首次写入可建 evolve 沙箱；Changes 面板可 Accept/Reject；Stop 后 pending Diff 保留审阅。', 'Autonomous explore, apply_patch/edit_file writes, allowlisted commands. High-risk still needs approval. First write may create evolve sandbox; Changes panel Accept/Reject; Stop keeps pending Diffs.')}
                            </div>
                          </div>
                          <button
                            className={`btn ${executionMode === 'auto' ? 'primary' : ''}`}
                            onClick={() => {
                              setExecutionMode('auto');
                              setStatusNotice('Switched Execution Mode -> Auto (Agent)');
                            }}
                          >
                            {executionMode === 'auto' ? '✓ ' + (tr('当前模式', 'Active')) : tr('设为自动模式', 'Select Auto')}
                          </button>
                        </div>

                        <div className="settings-row" style={{ alignItems: 'flex-start', padding: '16px 0', borderBottom: '1px solid var(--border)' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span className="badge info" style={{ fontSize: 11 }}>📖 Plan (Read-Only)</span>
                              <strong style={{ fontSize: 13.5 }}>{tr('规划模式 (严格只读)', 'Plan Mode (Strictly Read-Only)')}</strong>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {tr('只读探查 + write_artifact 规划 + invoke_subagent(research/planner)。阻断源码修改与终端命令。审阅后在 Artifacts 点 ▶ Proceed & Execute Plan / Execute Tasks / Act on Report，以 FORCE_AUTO_ACTION 强制落地。', 'Read-only explore + write_artifact + invoke_subagent(research/planner). No mutations until ▶ Proceed & Execute Plan / Execute Tasks / Act on Report injects FORCE_AUTO_ACTION.')}
                            </div>
                          </div>
                          <button
                            className={`btn ${executionMode === 'plan' ? 'primary' : ''}`}
                            onClick={() => {
                              setExecutionMode('plan');
                              setStatusNotice('Switched Execution Mode -> Plan (Read-Only)');
                            }}
                          >
                            {executionMode === 'plan' ? '✓ ' + (tr('当前模式', 'Active')) : tr('设为规划模式', 'Select Plan')}
                          </button>
                        </div>

                        <div className="settings-row" style={{ alignItems: 'flex-start', paddingTop: 16 }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span className="badge warning" style={{ fontSize: 11 }}>🛡️ Manual</span>
                              <strong style={{ fontSize: 13.5 }}>{tr('手动审批模式 (最高防护)', 'Manual Mode (Strict Approval)')}</strong>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {tr('AI 执行的每一项文件写入、代码修改或终端命令都必须经过用户在界面上点击 Approve 确认后方可执行。', 'Every single file mutation or shell command requires your explicit approval via the interactive approval card.')}
                            </div>
                          </div>
                          <button
                            className={`btn ${executionMode === 'manual' ? 'primary' : ''}`}
                            onClick={() => {
                              setExecutionMode('manual');
                              setStatusNotice('Switched Execution Mode -> Manual');
                            }}
                          >
                            {executionMode === 'manual' ? '✓ ' + (tr('当前模式', 'Active')) : tr('设为手动模式', 'Select Manual')}
                          </button>
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {tr('安全事件与状态栏提示', 'Safety Events (Status Bar)')}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>
                          {tr('sandbox.branch.created（evolve 沙箱分支）、circuit.breaker.triggered（熔断回滚文件数）、diff.proposed（先提案再写入）、goal.usage（Token 用量）。Composer 底部显示模型 tier 与 tok used/budget。', 'sandbox.branch.created, circuit.breaker.triggered, diff.proposed, and goal.usage. Composer shows model tier plus tok used/budget.')}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Section 4: Slash & Mentions */}
                  {guideSection === 'workflows' && (
                    <div>
                      <div className="settings-section-title">
                        {tr('⚡ 4. 斜杠 / 工作流与 @ 上下文引用 (/ Slash & @ Mentions)', '⚡ 4. / Slash Workflows & @ Context Mentions')}
                      </div>
                      <div className="settings-section-desc">
                        {tr('DeepAutoCode 内置了 Antigravity 2.0 的交互式 Slash 命令与 @ 上下文引用系统，在 AI Composer 输入框中键入即可自动弹出候选菜单。', 'DeepAutoCode features Antigravity 2.0 interactive slash workflows and context mentions. Type / or @ in the AI Composer to trigger.')}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10, fontSize: 14 }}>
                          {tr('常用斜杠工作流命令 (/ Slash Workflows)', 'Built-in Slash Workflows')}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
                          {[
                            { cmd: '/plan', title: tr('架构与实施规划', 'Architectural Plan'), desc: tr('生成结构化实施计划 Artifact，不改动源码', 'Generate structured implementation plan without editing files')},
                            { cmd: '/goal', title: tr('长程自主执行', 'Autonomous Goal'), desc: tr('自主推进代码落地、自动编译并修复错误直至验证完成', 'End-to-end execution: code, build, test, and self-heal errors')},
                            { cmd: '/fix', title: tr('排查并修复错误', 'Bug & Error Fix'), desc: tr('分析错误根因，应用最小可控修复方案并重新验证', 'Diagnose compiler/test errors, apply minimal fix, re-verify')},
                            { cmd: '/review', title: tr('代码与安全审查', 'Code & Security Review'), desc: tr('审查安全、性能与代码质量，给出文件与行号建议', 'Review security, performance, and defects with file:line tags')},
                            { cmd: '/test', title: tr('生成与运行测试', 'Generate & Run Tests'), desc: tr('为当前模块编写单元/集成测试并执行测试套件', 'Write unit/integration tests and run the test suite')},
                            { cmd: '/learn', title: tr('沉淀项目规则', 'Persist AI Rules'), desc: tr('将成功经验或架构约束沉淀到 .agents/rules/*.md', 'Persist project conventions into .agents/rules/*.md')},
                            { cmd: '/compact', title: tr('压缩会话上下文', 'Compact Context'), desc: tr('提炼长会话关键状态，释放上下文窗口空间', 'Summarize history into a checkpoint to free context window')},
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
                              title={tr(`点击将 ${item.cmd} 填入 AI 对话框`, `Click to insert ${item.cmd} into AI Composer`)}
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
                          {tr('常用 @ 上下文引用 (@ Context Mentions)', '@ Context Mentions')}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {[
                            { tag: '@git', desc: tr('自动抓取 git status 与最近变更 diff 注入上下文', 'Injects live git status & git diff')},
                            { tag: '@terminal', desc: tr('将最近的终端命令执行结果与退出码注入上下文', 'Injects recent terminal logs and exit codes')},
                            { tag: '@rules', desc: tr('将 .agents/rules/*.md 与项目规范规则注入提示词', 'Injects .agents/rules/*.md conventions')},
                            { tag: '@problems', desc: tr('注入 Problems；自愈轮也会自动加载 .deepautocode/problems.json', 'Injects Problems; self-heal also auto-loads problems.json')},
                            { tag: '@codebase', desc: tr('语义/混合检索相关源码', 'Semantic/hybrid codebase retrieval')},
                            { tag: '@docs', desc: tr('注入 README / docs / USER-GUIDE', 'Injects README / docs / USER-GUIDE')},
                            { tag: '@web', desc: tr('抓取 URL：@web https://…', 'Fetch URL: @web https://…')},
                            { tag: '@skill', desc: tr('按需展开 .agents/skills SKILL.md（默认仅目录）', 'On-demand expand Skill bodies (catalog by default)')},
                            { tag: '@symbol', desc: tr('从当前文件大纲挑选符号并注入函数/类正文', 'Pick a symbol from the active-file outline and inject its body')},
                            { tag: '@code', desc: tr('钉住当前编辑器选区', 'Pins current editor selection')},
                            { tag: '@tabs', desc: tr('注入已打开代码标签页摘要', 'Digest of open code tabs')},
                            { tag: '@folder/...', desc: tr('钉住文件夹上下文芯片', 'Pins a folder context chip')},
                            { tag: '@<filepath>', desc: tr('实时搜索工作区文件，并将目标代码内容精确注入', 'Filters & injects exact file content')},
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
                        {tr('✨ 5. 行内 AI (Ctrl+I) 与快捷 Code Lenses', '✨ 5. Inline AI (Ctrl+I) & Code Lenses')}
                      </div>
                      <div className="settings-section-desc">
                        {tr('行内指令与 Code Lens 走与 Composer 相同的 session.send Agent 工具链（read → search → editor → verify）。Explain 为 INLINE_QUERY 只读；重构/测试为 INLINE_EDIT。', 'Inline Command and Code Lenses share Composer’s session.send Agent chain (read → search → editor → verify). Explain uses INLINE_QUERY; refactor/tests use INLINE_EDIT.')}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10, fontSize: 14 }}>
                          {tr('两大行内交互方式', 'Two Inline Modalities')}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                          <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13.5 }}>⌨️ {tr('行内指令悬浮窗 (Ctrl+I)', 'Inline Command Widget (Ctrl+I)')}</strong>
                              <kbd className="welcome-kbd">Ctrl+I</kbd>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {tr('在任意代码文件中按下 Ctrl+I，即可在光标行弹出浮动指令框，直接输入针对当前行/函数的修改或生成需求，无需移开视线。', 'Press Ctrl+I in any code tab to pop up a floating instruction bar anchored to your cursor line.')}
                            </div>
                            <button
                              className="btn primary"
                              style={{ marginTop: 10 }}
                              onClick={() => {
                                setShowInlineCommand(true);
                                setStatusNotice('Opened Inline Command Widget (Ctrl+I)');
                              }}
                            >
                              ✨ {tr('立即体验 Ctrl+I', 'Try Ctrl+I Now')}
                            </button>
                          </div>

                          <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                              <strong style={{ fontSize: 13.5 }}>⚡ {tr('编辑器顶部快捷 Code Lens', 'Code Lens Bar')}</strong>
                              <span className="badge">CodeLens</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                              {tr('代码编辑器顶部常驻快捷按钮：✨ Explain（解释当前代码）、🛠️ Refactor（重构与优化）、🧪 Write Tests（编写单元测试）。', 'Quick actions at the top of the code editor: ✨ Explain, 🛠️ Refactor, and 🧪 Write Tests.')}
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
                        {tr('📑 6. Artifacts、子智能体、Todos 与 Token', '📑 6. Artifacts, Subagents, Todos & Tokens')}
                      </div>
                      <div className="settings-section-desc">
                        {tr('结构化制品持久化、一键 FORCE_AUTO_ACTION 落地、research/planner/verifier 子代理、manage_todo，以及 Composer/状态栏实时 Goal token 用量。', 'Persisted Artifacts, one-click FORCE_AUTO_ACTION landing, research/planner/verifier subagents, manage_todo, and live Goal token used/budget in Composer + status bar.')}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {tr('📑 Artifacts 制品面板与一键执行计划', 'Artifacts Pane & Plan Execution')}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {tr('AI 生成的实施计划 (Plan)、任务清单 (Task List)、技术报告 (Report) 会独立保存为 Artifact。在右侧 📑 Artifacts 标签页中审阅后，点击 ▶ Proceed & Execute Plan / Execute Tasks / Act on Report，将以 FORCE_AUTO_ACTION 强制落地（manage_todo + apply_patch + verify）。Composer 与底部状态栏会显示实时 Goal token 用量/预算。', 'Plans, Task Lists, and Reports are persisted as Artifacts. Use ▶ Proceed & Execute Plan / Execute Tasks / Act on Report to force Auto Mode landing (manage_todo + apply_patch + verify). Composer and the status bar show live Goal token used/budget.')}
                        </p>
                        <button
                          className="btn primary"
                          onClick={() => {
                            setShowRightAiDock(true);
                            setAiTab('artifacts');
                            void refreshArtifactsAndCustomizations();
                          }}
                        >
                          📑 {tr('打开右侧 Artifacts 面板', 'Open Artifacts Panel')}
                        </button>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {tr('🤖 子智能体、Todos 与 Token', 'Subagents, Todos & Tokens')}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {tr('invoke_subagent：research（多轮 search→outline→read）、planner（步骤计划）、verifier（诊断+verify → PASS/FAIL）。manage_todo 清单可在自愈续跑时注入；Goal 默认 180k token，Composer 与状态栏实时显示 used/budget（goal.usage）。', 'invoke_subagent: research (search→outline→read), planner, verifier (PASS/FAIL). manage_todo injects on self-heal continue. Default Goal budget 180k; Composer + status bar show live used/budget via goal.usage.')}
                        </p>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {tr('📜 .agents/ 规范化定制（Rules / Skills / Workflows）', '.agents/ Workspace Customizations')}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {tr('自动加载 .agents/rules/*.md、.agents/skills/*/SKILL.md、.agents/workflows/*.md、AGENTS.md / CLAUDE.md，以及 .deepautocode/project-rules.md，并注入每轮 system prompt。', 'Loads .agents/rules, skills, workflows, AGENTS.md / CLAUDE.md, and .deepautocode/project-rules.md into each turn’s system prompt.')}
                        </p>
                        <button className="btn" onClick={() => openSettingsCenter('rules')}>
                          📜 {tr('管理工作区 .agents 规则与技能', 'Manage .agents Customizations')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Section 7: Agent Coding Engine */}
                  {guideSection === 'agent' && (
                    <div>
                      <div className="settings-section-title">
                        {tr('🛠️ 7. Agent 编程引擎 (Search / Patch / Verify)', '🛠️ 7. Agent Coding Engine')}
                      </div>
                      <div className="settings-section-desc">
                        {tr('编程能力来自 Agent 工具链与验证闭环，而非 Code-OSS Fork。以下能力已落地，可直接在 Auto /goal 中体验。', 'Coding power comes from the Agent tool chain and verify loop—not a Code-OSS fork. These capabilities are live in Auto /goal runs.')}
                      </div>

                      <div className="settings-card">
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                          {[
                            {
                              t: tr('增强搜索', 'Search'),
                              d: tr('search_codebase：rg 优先；regex/glob/case_sensitive；mode=symbol|content|auto；工作区文件索引加速', 'search_codebase: ripgrep-first; regex/glob/case_sensitive; symbol|content|auto; workspace file index'),
                            },
                            {
                              t: tr('大纲与补丁', 'Outline & Patch'),
                              d: tr('outline_file；apply_patch 多文件；edit_file 多 hunk；mismatch 自动重读 + 一次重试；invoke_subagent(editor) 预算改写可回滚', 'outline_file; apply_patch; edit_file multi-hunk; mismatch auto re-read + one-shot retry; budgeted editor subagent with rollback'),
                            },
                            {
                              t: tr('实时诊断', 'Live Diagnostics'),
                              d: tr('边打字边 debounce LSP→Problems→gutter；保存仍强制刷新；TS/JS LS；可选 clangd；Python py_compile', 'Debounced as-you-type LSP → Problems → gutter; save still refreshes; TS/JS LS; optional clangd; Python'),
                            },
                            {
                              t: tr('验证与熔断', 'Verify & Circuit Breaker'),
                              d: tr('verify.json 构建/测试门禁；verify 催促 ≤4；自愈 ≤5；耗尽回滚并推送 circuit.breaker.triggered', 'verify.json build/test gate; nudge ≤4; self-heal ≤5; then rollback + circuit.breaker.triggered'),
                            },
                            {
                              t: tr('模型升档与压缩', 'Tier Escalate & Compaction'),
                              d: tr('自愈/语义失败/连续 mismatch/多文件 pending → reasoner；按工具输出与 token 预算分级压缩旧 tool 结果', 'Self-heal / semantic fail / mismatch / multi-file → reasoner; graded compaction of older tool results'),
                            },
                            {
                              t: tr('检查点与 Problems', 'Checkpoints & Problems'),
                              d: tr('改文件后自动 checkpoint；Problems + Diff/诊断 gutter；Changes「Next File」导览 pending Diff；Rules 支持 globs', 'Checkpoints; Problems + Diff/diagnostic gutter; Changes Next File; .cursor/rules globs'),
                            },
                            {
                              t: 'MCP / Memory / Jump',
                              d: tr('stdio/SSE/HTTP + resources/prompts；@codebase 语义检索；CDP 浏览器；.cursorignore', 'stdio/SSE/HTTP + resources/prompts; @codebase semantic search; CDP browser; .cursorignore'),
                            },
                          ].map((card) => (
                            <div
                              key={card.t}
                              style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}
                            >
                              <strong style={{ fontSize: 13 }}>{card.t}</strong>
                              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.55, marginTop: 6 }}>{card.d}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                          <button className="btn primary" onClick={() => openSettingsCenter('security')}>
                            🛡️ {tr('打开安全 / 验证门禁设置', 'Open Security / Verify Gate Settings')}
                          </button>
                          <button
                            className="btn"
                            onClick={() => {
                              setShowRightAiDock(true);
                              setAiTab('composer');
                              setExecutionMode('auto');
                              setPromptInput('/goal ');
                            }}
                          >
                            ∞ {tr('在 Composer 填入 /goal', 'Insert /goal in Composer')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Section 8: Web Preview & SSH */}
                  {guideSection === 'preview-ssh' && (
                    <div>
                      <div className="settings-section-title">
                        {tr('🌐 8. 内置实时 Web 预览与远程 SSH 开发', '🌐 8. Live Web Preview & Remote SSH')}
                      </div>
                      <div className="settings-section-desc">
                        {tr('无需频繁切换外部浏览器或第三方终端，在同一个 IDE 窗口内完成前端页面预览与远程 Linux 服务器开发。', 'Preview web apps and develop on remote Linux clusters directly inside DeepAutoCode.')}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {tr('🌐 内置 Web 预览 (默认 http://localhost:3000/)', 'Live Web Preview Tab')}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {tr('点击顶栏右侧的 🌐 Preview 按钮，或在 View 菜单中选择 Open Live Web Preview，即可在编辑器标签页中实时渲染本地前端项目，支持地址栏跳转、强制刷新，以及点击 ✨ Ask AI to Inspect 让 AI 自动检查页面端点。', 'Click 🌐 Preview in the titlebar to inspect local dev servers (http://localhost:3000/). Supports reload, browser opening, and AI inspection.')}
                        </p>
                        <button className="btn primary" onClick={() => openWebPreviewTab('http://localhost:3000/')}>
                          🌐 {tr('打开 http://localhost:3000/ 预览', 'Open http://localhost:3000/ Preview')}
                        </button>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8, fontSize: 14 }}>
                          {tr('🌐 Remote - SSH 远程连接管理器', 'Remote - SSH Connection Manager')}
                        </div>
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
                          {tr('点击状态栏 >< SSH 或按 Ctrl+Alt+O。支持 ssh -p 22 user@host:/path 解析、密码/密钥、远程目录树、脏文件保护、Reconnect、Conflict Check / Take Remote。打开时强制 pull；镜像 stub 不可当作真实远端内容。Agent 可在远程工作区执行。', 'Status badge >< SSH or Ctrl+Alt+O. Parses ssh -p 22 user@host:/path; password/key; dirty-file guard; Reconnect; Conflict Check / Take Remote. Open forces pull; mirror stubs are not real remote content. Agent runs on the remote workspace.')}
                        </p>
                        <button className="btn" onClick={() => void openSshConnectionModal()}>
                          🌐 {tr('打开 SSH 连接管理器 (Ctrl+Alt+O)', 'Open SSH Connection Manager (Ctrl+Alt+O)')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Section 9: Shortcuts */}
                  {guideSection === 'shortcuts' && (
                    <div>
                      <div className="settings-section-title">
                        {tr('⌨️ 9. 常用快捷键速查表 (Keyboard Shortcuts Reference)', '⌨️ 9. Keyboard Shortcuts & Reference')}
                      </div>
                      <div className="settings-section-desc">
                        {tr('熟练使用快捷键可大幅提升在 DeepAutoCode 中的结对编程效率。', 'Master keyboard shortcuts to maximize your pair-programming speed.')}
                      </div>

                      <div className="settings-card">
                        <table className="md-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left', padding: '8px 12px' }}>{tr('快捷键', 'Shortcut')}</th>
                              <th style={{ textAlign: 'left', padding: '8px 12px' }}>{tr('功能说明', 'Action')}</th>
                              <th style={{ textAlign: 'left', padding: '8px 12px' }}>{tr('快速触发', 'Trigger')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              { k: 'F1', d: tr('打开完整使用说明中心', 'Open User Guide Center'), a: () => openUserGuide('quickstart') },
                              { k: 'Ctrl+Shift+P / Ctrl+P', d: tr('打开命令面板 / 快速搜索文件', 'Command Palette / Quick File Open'), a: () => setShowPalette(true) },
                              { k: 'Ctrl+I', d: tr('弹出编辑器行内 AI 指令浮窗', 'Toggle Inline AI Command Widget'), a: () => setShowInlineCommand(true) },
                              { k: 'Ctrl+Shift+O', d: tr('当前文件符号大纲跳转', 'Go to Symbol in Editor'), a: () => void openGoToSymbolPalette() },
                              { k: 'F12', d: tr('跳转到光标处定义 (LSP/搜索)', 'Go to Definition under Cursor'), a: () => void jumpToDefinitionAtCursor() },
                              { k: 'Ctrl+L', d: tr('展开/收起右侧 AI 对话栏', 'Toggle AI Agent & Artifacts Dock'), a: () => setShowRightAiDock((v) => !v) },
                              { k: 'Ctrl+B', d: tr('展开/收起左侧主侧边栏', 'Toggle Primary Left Sidebar'), a: () => setShowLeftSidebar((v) => !v) },
                              { k: 'Ctrl+J', d: tr('展开/收起底部终端与问题面板', 'Toggle Bottom Terminal Panel'), a: () => setShowBottomPanel((v) => !v) },
                              { k: 'Ctrl+O', d: tr('打开本地项目文件夹', 'Open Project Folder'), a: () => void handleOpenProjectAction() },
                              { k: 'Ctrl+Alt+O', d: tr('打开远程 SSH 连接管理器', 'Connect via SSH'), a: () => void openSshConnectionModal() },
                              { k: 'Ctrl+S', d: tr('保存当前活动文件', 'Save Current File'), a: () => void saveCurrentTab() },
                              { k: 'Ctrl+,', d: tr('打开 DeepAutoCode 设置中心', 'Open Settings Center'), a: () => openSettingsCenter('general') },
                              { k: 'Ctrl+Shift+J', d: tr('打开 AI 模型与 Provider 设置', 'Configure AI Models'), a: () => openSettingsCenter('models') },
                              { k: 'Alt+T', d: tr('切换深色 / 浅色主题', 'Toggle Dark / Light Theme'), a: () => toggleColorTheme() },
                            ].map((row) => (
                              <tr key={row.k} style={{ borderTop: '1px solid var(--border)' }}>
                                <td style={{ padding: '8px 12px' }}><kbd className="welcome-kbd">{row.k}</kbd></td>
                                <td style={{ padding: '8px 12px', fontSize: 12.5 }}>{row.d}</td>
                                <td style={{ padding: '8px 12px' }}>
                                  <button className="btn" style={{ padding: '2px 8px', fontSize: 10.5 }} onClick={row.a}>
                                    {tr('立即执行', 'Run')}
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
  );
}
