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
import { GuideCenter } from './GuideCenter';
import { SettingsCenter } from './SettingsCenter';

export function EditorSurface({ ctx }: { ctx: any }) {
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
              <GuideCenter ctx={ctx} />
            ) : activeTab?.kind === 'settings' ? (
              <SettingsCenter ctx={ctx} />
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
                        <span className="welcome-version-pill">{t('welcome.version')}</span>
                      </div>
                      <p className="welcome-subtitle">
                        {workspaceRoot
                          ? t('welcome.subtitle.active', {
                              name: displayWorkspaceName,
                            })
                          : t('welcome.subtitle.empty')}
                      </p>
                      <div className="welcome-lang-row" role="group" aria-label={t('welcome.lang')}>
                        <span className="welcome-lang-label">{t('welcome.lang')}</span>
                        {APP_LOCALES.map((loc) => (
                          <button
                            key={loc.id}
                            type="button"
                            className={`welcome-lang-btn ${locale === loc.id ? 'active' : ''}`}
                            onClick={() => setAppLocale(loc.id)}
                            title={loc.englishLabel}
                          >
                            {loc.nativeLabel}
                          </button>
                        ))}
                      </div>
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
                      <div className="welcome-card-title">{t('welcome.openFolder')}</div>
                      <div className="welcome-card-desc">{t('welcome.openFolder.desc')}</div>
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
                      <div className="welcome-card-title">{t('welcome.ssh')}</div>
                      <div className="welcome-card-desc">{t('welcome.ssh.desc')}</div>
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
                      <div className="welcome-card-title">{t('welcome.models')}</div>
                      <div className="welcome-card-desc">{t('welcome.models.desc')}</div>
                    </button>
                  </div>

                  {/* Two-Column Bottom Section: Recent Workspaces & Keyboard Shortcuts */}
                  <div className="welcome-bottom-grid">
                    {/* Left Column: Recent Workspaces & SSH Hosts */}
                    <div className="welcome-section">
                      <div className="welcome-section-header">
                        <span>{t('welcome.recent')}</span>
                        {((ideSettings.recentWorkspaces ?? []).length > 0 ||
                          sshProfiles.length > 0) && (
                          <span className="welcome-section-count">
                            {(ideSettings.recentWorkspaces ?? []).length + sshProfiles.length}
                          </span>
                        )}
                      </div>
                      {(ideSettings.recentWorkspaces ?? []).length === 0 &&
                      sshProfiles.length === 0 ? (
                        <div className="welcome-empty-recent">{t('welcome.recent.empty')}</div>
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
                                  <span className="welcome-recent-badge local">
                                    {t('welcome.local')}
                                  </span>
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
                                <span className="welcome-recent-badge ssh">
                                  {t('welcome.sshBadge')}
                                </span>
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
                        <span>{t('welcome.shortcuts')}</span>
                      </div>
                      <div className="welcome-shortcuts-list">
                        <div
                          className="welcome-shortcut-row"
                          onClick={() => setShowPalette(true)}
                        >
                          <span>{t('welcome.shortcut.palette')}</span>
                          <kbd className="welcome-kbd">Ctrl+Shift+P</kbd>
                        </div>
                        <div
                          className="welcome-shortcut-row"
                          onClick={() => setShowRightAiDock((v) => !v)}
                        >
                          <span>{t('welcome.shortcut.ai')}</span>
                          <kbd className="welcome-kbd">Ctrl+L</kbd>
                        </div>
                        <div
                          className="welcome-shortcut-row"
                          onClick={() => setShowBottomPanel((v) => !v)}
                        >
                          <span>{t('welcome.shortcut.terminal')}</span>
                          <kbd className="welcome-kbd">Ctrl+`</kbd>
                        </div>
                        <div
                          className="welcome-shortcut-row"
                          onClick={() => setShowLeftSidebar((v) => !v)}
                        >
                          <span>{t('welcome.shortcut.explorer')}</span>
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
                      onClick={() => triggerCodeLensAction('explain')}
                    >
                      ✨ Explain
                    </button>
                    <button
                      type="button"
                      className="ag-codelens-btn"
                      onClick={() => triggerCodeLensAction('refactor')}
                    >
                      🛠️ Refactor
                    </button>
                    <button
                      type="button"
                      className="ag-codelens-btn"
                      onClick={() => triggerCodeLensAction('tests')}
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
                          {activeTab?.path}:
                          {editorSelection.hasSelection &&
                          editorSelection.startLine !== editorSelection.endLine
                            ? `L${editorSelection.startLine}-L${editorSelection.endLine}`
                            : `L${cursorPos.line}`}
                          {editorSelection.hasSelection ? ' (selection)' : ''}
                        </code>
                        <span style={{ marginLeft: 8, opacity: 0.75, fontSize: 11 }}>
                          → same Agent tools as Composer
                        </span>
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
                {/* Synchronized Line Gutter: line numbers + diagnostic / Diff marks */}
                <div className="ag-line-gutter" ref={codeGutterRef}>
                  {codeLines.map((_lineText, idx) => {
                    const lineNumber = idx + 1;
                    const isActive = cursorPos.line === lineNumber;
                    const diffKind = pendingDiffMarks.get(lineNumber);
                    const problemTip = problemGutterLines.get(lineNumber);
                    const problemSev = problemTip?.startsWith('error')
                      ? 'error'
                      : problemTip?.startsWith('warning')
                        ? 'warning'
                        : problemTip
                          ? 'info'
                          : '';
                    return (
                      <div
                        key={idx}
                        className={`ag-gutter-row ${isActive ? 'active' : ''} ${
                          diffKind === 'add'
                            ? 'diff-add'
                            : diffKind === 'mod'
                              ? 'diff-mod'
                              : ''
                        } ${problemSev ? `diag-${problemSev}` : ''}`.trim()}
                        title={
                          problemTip
                            ? problemTip
                            : diffKind
                              ? `Pending Agent Diff (${diffKind})`
                              : undefined
                        }
                      >
                        <span className="ag-gutter-num">{lineNumber}</span>
                        {problemSev ? (
                          <span className={`ag-gutter-diag ${problemSev}`} aria-hidden />
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {/* Live Syntax-Highlighted Code Layer + Transparent Editable Textarea */}
                <div className="ag-code-stage">
                  {pendingDiffForActive && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 4,
                        right: 8,
                        zIndex: 3,
                        fontSize: 11,
                        background: 'rgba(210,153,34,0.18)',
                        border: '1px solid #d29922',
                        borderRadius: 4,
                        padding: '2px 8px',
                        color: '#d29922',
                        pointerEvents: 'none',
                      }}
                    >
                      Pending Diff · {pendingDiffMarks.size} changed line(s)
                    </div>
                  )}
                  <div
                    className="ag-code-highlight-layer"
                    ref={codeHighlightRef}
                    aria-hidden="true"
                  >
                    {codeLines.map((line, idx) =>
                      renderSyntaxHighlightedLine(
                        line,
                        idx,
                        cursorPos.line === idx + 1,
                        pendingDiffMarks.get(idx + 1)
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
                      if (activeTabPath) triggerDebouncedLiveDiagnostics(activeTabPath, val);
                    }}
                    onKeyUp={(e) => {
                      const target = e.currentTarget;
                      const upto = target.value.slice(0, target.selectionStart);
                      const lines = upto.split('\n');
                      setCursorPos({
                        line: lines.length,
                        col: (lines[lines.length - 1]?.length ?? 0) + 1,
                      });
                      syncEditorSelectionFromTextarea(target);
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
                      syncEditorSelectionFromTextarea(target);
                      triggerDebouncedGhostAutocomplete(target.value, target.selectionStart);
                    }}
                    onSelect={(e) => {
                      syncEditorSelectionFromTextarea(e.currentTarget);
                    }}
                    onMouseUp={(e) => {
                      syncEditorSelectionFromTextarea(e.currentTarget);
                    }}
                  />
                </div>

                {/* Optional Minimap — click a stripe to jump; off by default */}
                {ideSettings.editor?.minimap === true && (
                  <aside
                    className="ag-minimap"
                    title="Minimap — click to jump · toolbar Minimap to hide"
                    onClick={(e) => {
                      const rail = e.currentTarget;
                      const rect = rail.getBoundingClientRect();
                      const y = e.clientY - rect.top;
                      const shown = Math.min(140, Math.max(1, codeLines.length));
                      const ratio = Math.max(0, Math.min(1, y / Math.max(1, rect.height)));
                      const targetLine = Math.max(1, Math.min(codeLines.length, Math.ceil(ratio * shown)));
                      void openFileInTab(activeTabPath, true, true, targetLine);
                    }}
                  >
                    <div
                      className="ag-minimap-viewport"
                      style={{
                        top: `${Math.max(
                          0,
                          Math.min(
                            88,
                            ((cursorPos.line - 1) / Math.max(1, Math.min(140, codeLines.length))) * 100
                          )
                        )}%`,
                      }}
                    />
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
  );
}
