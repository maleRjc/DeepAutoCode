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

export function TitlebarMenu({ ctx }: { ctx: any }) {
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

  // Complete Cursor / Antigravity Top Menu Bar Definition (Clean, Grouped & Separated)
  const MENU_DEFINITIONS = [
    {
      id: 'file',
      label: t('menu.file'),
      items: [
        { header: t('menu.hdr.create') },
        {
          label: t('menu.file.newFile'),
          shortcut: 'Ctrl+N',
          action: () => {
            setCreateTargetName('src/new-file.ts');
            setShowCreateModal('file');
          },
        },
        {
          label: t('menu.file.newFolder'),
          shortcut: 'Ctrl+Shift+N',
          action: () => {
            setCreateTargetName('src/new-folder');
            setShowCreateModal('directory');
          },
        },
        { divider: true },
        { header: t('menu.hdr.project') },
        {
          label: t('menu.file.openFolder'),
          shortcut: 'Ctrl+O',
          action: () => void handleOpenProjectAction(),
        },
        {
          label: t('menu.file.switchRecent'),
          shortcut: 'Ctrl+R',
          action: () => setShowProjectModal(true),
        },
        {
          label: t('menu.file.connectSsh'),
          shortcut: 'Ctrl+Alt+O',
          action: () => void openSshConnectionModal(),
        },
        ...(sshStatus?.connected
          ? [
              {
                label: t('menu.file.closeSsh'),
                shortcut: '',
                action: () => void handleDisconnectSshHost(),
              },
            ]
          : []),
        { divider: true },
        { header: t('menu.hdr.save') },
        {
          label: t('menu.file.save'),
          shortcut: 'Ctrl+S',
          action: () => void saveCurrentTab(),
        },
        {
          label: t('menu.file.saveAll'),
          shortcut: 'Ctrl+K S',
          action: () => void saveAllTabs(),
        },
        { divider: true },
        { header: t('menu.hdr.preferences') },
        {
          label: t('menu.file.settings'),
          shortcut: 'Ctrl+,',
          action: () => openSettingsCenter('general'),
        },
        {
          label: t('menu.file.models'),
          shortcut: 'Ctrl+Shift+J',
          action: () => openSettingsCenter('models'),
        },
        {
          label: t('menu.file.security'),
          shortcut: '',
          action: () => openSettingsCenter('security'),
        },
        {
          label: t('menu.file.extensions'),
          shortcut: 'Ctrl+Shift+X',
          action: () => openSettingsCenter('extensions'),
        },
        { divider: true },
        { header: t('menu.hdr.close') },
        {
          label: t('menu.file.closeEditor'),
          shortcut: 'Ctrl+W',
          action: () => activeTabPath && closeTab(activeTabPath),
        },
        {
          label: t('menu.file.closeFolder'),
          shortcut: 'Ctrl+K F',
          action: () => handleCloseFolder(),
        },
        {
          label: t('menu.file.closeWindow'),
          shortcut: 'Alt+F4',
          action: () => void handleCloseWindow(),
        },
      ],
    },
    {
      id: 'edit',
      label: t('menu.edit'),
      items: [
        {
          label: t('menu.edit.findInFiles'),
          shortcut: 'Ctrl+Shift+F',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('search');
          },
        },
        { divider: true },
        {
          label: t('menu.edit.rules'),
          shortcut: '',
          action: () => openSettingsCenter('rules'),
        },
      ],
    },
    {
      id: 'selection',
      label: t('menu.selection'),
      items: [
        {
          label: t('menu.selection.addContext'),
          shortcut: 'Ctrl+L',
          action: () => {
            setAttachActiveFile(true);
            setShowRightAiDock(true);
          },
        },
        { divider: true },
        {
          label: t('menu.selection.askReview'),
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
      label: t('menu.view'),
      items: [
        {
          label: t('menu.view.palette'),
          shortcut: 'Ctrl+Shift+P',
          action: () => setShowPalette(true),
        },
        { divider: true },
        { header: t('menu.hdr.panels') },
        {
          label: t('menu.view.explorer'),
          shortcut: 'Ctrl+Shift+E',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('explorer');
          },
        },
        {
          label: t('menu.view.search'),
          shortcut: 'Ctrl+Shift+F',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('search');
          },
        },
        {
          label: t('menu.view.git'),
          shortcut: 'Ctrl+Shift+G',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('git');
          },
        },
        {
          label: t('menu.view.extensions'),
          shortcut: 'Ctrl+Shift+X',
          action: () => {
            setShowLeftSidebar(true);
            setActiveActivity('extensions');
          },
        },
        { divider: true },
        { header: t('menu.hdr.appearance') },
        {
          label: t('menu.view.toggleTheme'),
          shortcut: 'Alt+T',
          action: () => toggleColorTheme(),
        },
        {
          label: t('menu.view.toggleSidebar'),
          shortcut: 'Ctrl+B',
          action: () => setShowLeftSidebar((v) => !v),
        },
        {
          label: t('menu.view.toggleBottom'),
          shortcut: 'Ctrl+J',
          action: () => setShowBottomPanel((v) => !v),
        },
        {
          label: t('menu.view.toggleAi'),
          shortcut: 'Ctrl+L',
          action: () => setShowRightAiDock((v) => !v),
        },
      ],
    },
    {
      id: 'go',
      label: t('menu.go'),
      items: [
        {
          label: t('menu.go.file'),
          shortcut: 'Ctrl+P',
          action: () => setShowPalette(true),
        },
        { divider: true },
        {
          label: t('menu.go.product'),
          shortcut: '',
          action: () => void openFileInTab('product/product.json', true),
        },
        {
          label: t('menu.go.adr'),
          shortcut: '',
          action: () => void openFileInTab('docs/ADR-AND-POC-REPORT.md', true),
        },
      ],
    },
    {
      id: 'run',
      label: t('menu.run'),
      items: [
        { header: t('menu.hdr.buildTest') },
        {
          label: t('menu.run.typecheck'),
          shortcut: 'Ctrl+Shift+B',
          action: () => void handleRunTerminalCommand('npm run typecheck'),
        },
        {
          label: t('menu.run.tests'),
          shortcut: 'F5',
          action: () => void handleRunTerminalCommand('npm test'),
        },
        { divider: true },
        { header: t('menu.hdr.runtime') },
        {
          label: t('menu.run.restartHost'),
          shortcut: 'Ctrl+Shift+R',
          action: () => void handleSimulateExtensionHostRestart(),
        },
        {
          label: t('menu.run.smoke'),
          shortcut: '',
          action: () => openSettingsCenter('models'),
        },
      ],
    },
    {
      id: 'terminal',
      label: t('menu.terminal'),
      items: [
        {
          label: t('menu.terminal.new'),
          shortcut: 'Ctrl+`',
          action: () => {
            setShowBottomPanel(true);
            setActiveBottomTab('terminal');
          },
        },
        { divider: true },
        {
          label: t('menu.terminal.gitStatus'),
          shortcut: '',
          action: () => void handleRunTerminalCommand('git status'),
        },
        {
          label: t('menu.terminal.clear'),
          shortcut: '',
          action: () => setTerminalHistory([]),
        },
      ],
    },
    {
      id: 'help',
      label: t('menu.help'),
      items: [
        { header: t('menu.hdr.guide') },
        {
          label: t('menu.help.guide'),
          shortcut: 'F1',
          action: () => openUserGuide('quickstart'),
        },
        {
          label: t('menu.help.s1'),
          shortcut: '',
          action: () => openUserGuide('quickstart'),
        },
        {
          label: t('menu.help.s2'),
          shortcut: '',
          action: () => openUserGuide('workbench'),
        },
        {
          label: t('menu.help.s3'),
          shortcut: '',
          action: () => openUserGuide('modes'),
        },
        {
          label: t('menu.help.s4'),
          shortcut: '',
          action: () => openUserGuide('workflows'),
        },
        {
          label: t('menu.help.s5'),
          shortcut: '',
          action: () => openUserGuide('inline'),
        },
        {
          label: t('menu.help.s6'),
          shortcut: '',
          action: () => openUserGuide('artifacts'),
        },
        {
          label: t('menu.help.s7'),
          shortcut: '',
          action: () => openUserGuide('agent'),
        },
        {
          label: t('menu.help.s8'),
          shortcut: '',
          action: () => openUserGuide('preview-ssh'),
        },
        {
          label: t('menu.help.s9'),
          shortcut: '',
          action: () => openUserGuide('shortcuts'),
        },
        { divider: true },
        { header: t('menu.hdr.docs') },
        {
          label: t('menu.help.openMd'),
          shortcut: '',
          action: () => void openFileInTab('docs/USER-GUIDE.md', true),
        },
        {
          label: t('menu.help.poc'),
          shortcut: '',
          action: () => void openFileInTab('docs/ADR-AND-POC-REPORT.md', true),
        },
        {
          label: t('menu.help.settings'),
          shortcut: 'Ctrl+,',
          action: () => openSettingsCenter('general'),
        },
        {
          label: t('menu.help.diagnostics'),
          shortcut: '',
          action: () => void handleExportDiagnostics(),
        },
      ],
    },
  ];
  return (
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
            <span>
              {displayWorkspaceName} {t('command.search')}
            </span>
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
            title={t('title.theme')}
          >
            <span>{isLightTheme ? '🌙' : '☀️'}</span>
            <span>{isLightTheme ? t('title.theme.dark') : t('title.theme.light')}</span>
          </button>
          <div className="titlebar-sep" />
          <button
            className={`icon-btn ${showLeftSidebar ? 'active' : ''}`}
            onClick={() => setShowLeftSidebar((v) => !v)}
            title={t('title.sidebar')}
          >
            ◧
          </button>
          <button
            className={`icon-btn ${showBottomPanel ? 'active' : ''}`}
            onClick={() => setShowBottomPanel((v) => !v)}
            title={t('title.bottom')}
          >
            ◨
          </button>
          <button
            className={`icon-btn ${activeTabPath === 'preview://localhost' ? 'active' : ''}`}
            onClick={() => openWebPreviewTab()}
            title={t('title.previewFull')}
          >
            🌐 {t('title.preview')}
          </button>
          <button
            className={`icon-btn ${showRightAiDock ? 'active' : ''}`}
            onClick={() => setShowRightAiDock((v) => !v)}
            title={t('title.aiFull')}
          >
            ✨ {t('title.ai')}
          </button>
          <div className="titlebar-sep" />
          <button
            className={`icon-btn ${activeTabPath === 'settings://deepautocode' ? 'active' : ''}`}
            onClick={() => openSettingsCenter('general')}
            title={t('title.settingsFull')}
          >
            ⚙️ {t('title.settings')}
          </button>
        </div>
      </header>
  );
}
