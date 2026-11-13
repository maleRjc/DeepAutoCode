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

export function LeftSidebar({ ctx }: { ctx: any }) {
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
  return (
        <aside className="primary-sidebar" style={{ display: showLeftSidebar ? 'flex' : 'none' }}>
          {activeActivity === 'explorer' && (
            <>
              <div className="sidebar-header ag-sidebar-titlebar">
                <span>{t('sidebar.explorer')}</span>
                <button
                  className="ag-header-action"
                  title={t('settings.openFolder')}
                  onClick={() => void handleOpenProjectAction()}
                >
                  {t('settings.openFolder')}
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
                    <div>{t('welcome.explorer.empty')}</div>
                    <button
                      className="btn primary"
                      style={{ width: '100%', justifyContent: 'center', padding: '7px 12px' }}
                      onClick={() => void handleOpenProjectAction()}
                    >
                      📂 {t('welcome.openFolder')}
                    </button>
                    <button
                      className="btn"
                      style={{ width: '100%', justifyContent: 'center', padding: '7px 12px' }}
                      onClick={() => void openSshConnectionModal()}
                    >
                      🌐 {t('welcome.explorer.ssh')}
                    </button>
                    {(ideSettings.recentWorkspaces ?? []).length > 0 && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.8 }}>
                          {t('welcome.explorer.recent')}
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
                <span>{t('sidebar.search')}</span>
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
                  placeholder={tr(
                    '在工作区文件中搜索文本…',
                    'Search text across workspace files...'
                  )}
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
                <span>{t('sidebar.git')}</span>
                <span className="badge">{gitState.branch}</span>
              </div>
              <div className="sidebar-scroll" style={{ padding: 8 }}>
                <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 8 }}>
                  {tr('工作区变更', 'Working Tree Changes')} ({gitState.changes.length})
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
                <span>{t('sidebar.extensions')}</span>
                <button
                  className="btn"
                  style={{ padding: '2px 6px', fontSize: 10.5 }}
                  onClick={() => openSettingsCenter('extensions')}
                >
                  {tr('完整视图', 'Full View')}
                </button>
              </div>
              <div className="sidebar-scroll" style={{ padding: 8 }}>
                <div
                  style={{
                    padding: 8,
                    marginBottom: 8,
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    background: 'var(--bg-elevated)',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    Recommended Language Pack
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: 8 }}>
                    Install clangd / rust-analyzer / BasedPyright / ESLint / Go VSIX into catalog storage.
                    Live editor language features today use Agent outline, Problems-from-build, and F12 search — not a running Extension Host LSP.
                  </div>
                  <button
                    className="btn primary"
                    style={{ width: '100%', fontSize: 12 }}
                    onClick={async () => {
                      setStatusNotice('Installing recommended language pack…');
                      const result = await fetch('/api/extensions/install-lsp-pack', {
                        method: 'POST',
                      }).then((r) => r.json());
                      const updated = await fetch('/api/extensions').then((r) => r.json());
                      setExtensionsCatalog(updated);
                      setStatusNotice(
                        result?.notice ||
                          `LSP pack: installed ${result?.installed?.length ?? 0}, skipped ${result?.skipped?.length ?? 0}`
                      );
                    }}
                  >
                    Install Recommended LSP Pack
                  </button>
                </div>
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
  );
}
