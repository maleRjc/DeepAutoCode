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

export function ActivityBar({ ctx }: { ctx: any }) {
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
        <aside className="activity-bar">
          <div className="activity-top">
            {[
              {
                id: 'explorer',
                title: t('activity.explorer'),
                svg: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                ),
              },
              {
                id: 'search',
                title: t('activity.search'),
                svg: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                ),
              },
              {
                id: 'git',
                title: t('activity.git'),
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
                title: t('activity.extensions'),
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

          {/* Bottom-Left: Language / Diagnostics / Settings Gear */}
          <div className="activity-bottom" onClick={(e) => e.stopPropagation()}>
            <div
              className={`activity-icon ${showLangPopup ? 'active' : ''}`}
              title={t('activity.language')}
              onClick={() => {
                setShowGearPopup(false);
                setShowLangPopup((v) => !v);
              }}
            >
              <span className="activity-lang-badge" aria-hidden>
                {t(`activity.language.short.${locale}` as 'activity.language.short.zh-CN')}
              </span>
              {showLangPopup && (
                <div
                  className="menu-dropdown"
                  style={{ bottom: 8, top: 'auto', left: 48, minWidth: 200 }}
                >
                  <div className="menu-group-header">{t('lang.label')}</div>
                  {APP_LOCALES.map((loc) => (
                    <div
                      key={loc.id}
                      className={`menu-dropdown-item ${locale === loc.id ? 'active' : ''}`}
                      onClick={() => {
                        setShowLangPopup(false);
                        setAppLocale(loc.id);
                      }}
                    >
                      <span>
                        {t(`activity.language.short.${loc.id}` as 'activity.language.short.zh-CN')}{' '}
                        {loc.nativeLabel}
                      </span>
                      {locale === loc.id && (
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>✓</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div
              className="activity-icon"
              title={t('gear.diagnostics')}
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
              title={`${t('gear.settings')} (Ctrl+,)`}
              onClick={() => {
                setShowLangPopup(false);
                setShowGearPopup((v) => !v);
              }}
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
                    <span>
                      {isLightTheme
                        ? `🌙 ${t('gear.theme.dark')}`
                        : `☀️ ${t('gear.theme.light')}`}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {t('settings.theme')}
                    </span>
                  </div>
                  <div className="menu-divider" />
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('general');
                    }}
                  >
                    <span>⚙️ {t('gear.settings')}</span>
                    <span style={{ fontSize: 11, color: '#8b949e' }}>Ctrl+,</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('models');
                    }}
                  >
                    <span>🤖 {t('gear.models')}</span>
                    <span style={{ fontSize: 11, color: '#8b949e' }}>Ctrl+Shift+J</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('security');
                    }}
                  >
                    <span>🛡️ {t('gear.security')}</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('rules');
                    }}
                  >
                    <span>📜 {t('gear.rules')}</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('mcp');
                    }}
                  >
                    <span>🔌 {t('gear.mcp')}</span>
                  </div>
                  <div className="menu-divider" />
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      openSettingsCenter('extensions');
                    }}
                  >
                    <span>🧩 {t('gear.extensions')}</span>
                    <span style={{ fontSize: 11, color: '#8b949e' }}>Ctrl+Shift+X</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setShowGearPopup(false);
                      setShowPalette(true);
                    }}
                  >
                    <span>⌨️ {t('gear.palette')}</span>
                    <span style={{ fontSize: 11, color: '#8b949e' }}>Ctrl+Shift+P</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>
  );
}
