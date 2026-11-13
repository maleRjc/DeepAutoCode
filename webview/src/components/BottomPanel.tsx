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

export function BottomPanel({ ctx }: { ctx: any }) {
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
                  {
                    id: 'problems',
                    label: `Problems (${workspaceProblems.length})`,
                  },
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
              <div className="terminal-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                  <span style={{ color: workspaceProblems.length ? 'var(--warning, #d29922)' : '#3fb950' }}>
                    {workspaceProblems.length
                      ? `${workspaceProblems.length} issue(s) from build/terminal (Agent Outline / search — not a live LSP host)`
                      : '✓ No build/compiler problems recorded yet. Run build/test in Terminal to populate.'}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn"
                      style={{ padding: '4px 10px', fontSize: 11.5 }}
                      onClick={() => {
                        void fetch('/api/workspace/problems', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ clear: true }),
                        }).then(() => setWorkspaceProblems([]));
                      }}
                    >
                      Clear
                    </button>
                    <button
                      className="btn primary"
                      style={{ padding: '4px 10px', fontSize: 11.5 }}
                      onClick={() =>
                        void handleSendPrompt(
                          workspaceProblems.length
                            ? `@problems Fix the listed Problems panel diagnostics in-place, then re-run verify/build.`
                            : 'Check all issues in the current project (code defects, build configs, and failing tests), directly apply fixes to the project files, and automatically build and run verification tests.',
                          'auto'
                        )
                      }
                    >
                      🛠️ Auto-Fix All Issues
                    </button>
                  </div>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {workspaceProblems.map((p, idx) => (
                    <div
                      key={`${p.file}:${p.line}:${idx}`}
                      style={{
                        padding: '4px 2px',
                        borderBottom: '1px solid var(--border)',
                        cursor: 'pointer',
                        fontSize: 12,
                        display: 'flex',
                        gap: 8,
                      }}
                      onClick={() => void openFileInTab(p.file, true, false, p.line)}
                      title="Open file at diagnostic line"
                    >
                      <span
                        style={{
                          color:
                            p.severity === 'error'
                              ? '#f85149'
                              : p.severity === 'warning'
                                ? '#d29922'
                                : '#8b949e',
                          minWidth: 56,
                          textTransform: 'uppercase',
                          fontSize: 11,
                        }}
                      >
                        {p.severity}
                      </span>
                      <span style={{ color: 'var(--accent-bright)' }}>
                        {p.file}:{p.line}
                        {p.column ? `:${p.column}` : ''}
                      </span>
                      <span style={{ color: 'var(--text-secondary)' }}>[{p.source}]</span>
                      <span style={{ color: 'var(--text-primary)' }}>{p.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
  );
}
