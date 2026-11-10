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
  parseGlmControlReason,
  formatContinuationStatusLabel,
} from '../utils/workbenchUtils';

export function StatusBar({ ctx }: { ctx: any }) {
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
    goalContextPressure,
    lastContinuationHint,
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
    refreshSessionCheckpoints, refreshTaskTrace, refreshTaskTraceList, handleReviewAllPending,
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
          {lastModelTier?.effectiveModelId && (
            <span
              title={lastModelTier.reason || 'Active model route'}
              style={{
                color: lastModelTier.peakHour ? '#fbbf24' : '#67e8f9',
                fontWeight: 600,
              }}
            >
              {lastModelTier.effectiveModelId}
              {lastModelTier.thinkingEnabled
                ? '·think'
                : lastModelTier.effectiveModelId.toLowerCase().includes('glm')
                  ? '·fast'
                  : ''}
              {lastModelTier.peakHour ? ' · peak' : ''}
            </span>
          )}
          {lastModelTier &&
            (lastModelTier.glmControlReason || parseGlmControlReason(lastModelTier)) && (
              <span
                title={lastModelTier.reason || ''}
                style={{ color: '#4ade80', fontWeight: 600, fontSize: 11 }}
              >
                GLM·{lastModelTier.glmControlReason || parseGlmControlReason(lastModelTier)}
              </span>
            )}
          {lastContinuationHint && (
            <span
              title={lastContinuationHint.summary}
              style={{
                color: '#fb923c',
                fontWeight: 600,
                fontSize: 11,
                cursor: 'pointer',
              }}
              onClick={() => {
                setAiTab('trace');
                void refreshTaskTrace();
                void refreshTaskTraceList(12);
              }}
            >
              {formatContinuationStatusLabel(lastContinuationHint)}
            </span>
          )}
          {(() => {
            const tokFill =
              goalTokenUsage && goalTokenUsage.tokenBudget > 0
                ? goalTokenUsage.tokensUsed / goalTokenUsage.tokenBudget
                : 0;
            const ctxFill = Math.max(
              goalContextPressure?.fillRatio ?? 0,
              lastModelTier?.contextFillRatio ?? 0,
              tokFill
            );
            if (ctxFill <= 0.05) return null;
            const pct = Math.min(100, Math.round(ctxFill * 100));
            const hot = ctxFill >= 0.78 || goalContextPressure?.warn;
            return (
              <span
                title={`Context fill ~${pct}%${lastModelTier?.compactProfile ? ` · ${lastModelTier.compactProfile}` : ''}${goalContextPressure?.warn ? ' · compaction active' : ''}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  color: hot ? '#fbbf24' : '#93c5fd',
                  fontWeight: 600,
                  fontSize: 11,
                }}
              >
                ctx
                <span
                  style={{
                    display: 'inline-block',
                    width: 40,
                    height: 5,
                    borderRadius: 3,
                    background: 'rgba(148, 163, 184, 0.25)',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width: `${pct}%`,
                      background: hot
                        ? 'rgba(251, 191, 36, 0.95)'
                        : 'rgba(59, 130, 246, 0.85)',
                    }}
                  />
                </span>
                {pct}%
              </span>
            );
          })()}
          {goalTokenUsage && (
            <span
              title={`Remaining ${goalTokenUsage.remaining.toLocaleString()} tokens; cache hit ${goalTokenUsage.cacheReadTokens.toLocaleString()}; est ¥${goalTokenUsage.estimatedCostCnyTotal.toFixed(4)}`}
              style={{
                color:
                  goalTokenUsage.tokensUsed / Math.max(1, goalTokenUsage.tokenBudget) > 0.85
                    ? '#fbbf24'
                    : '#34d399',
                fontWeight: 600,
              }}
            >
              Tokens: {formatCompactTokens(goalTokenUsage.tokensUsed)}/
              {formatCompactTokens(goalTokenUsage.tokenBudget)}
              {goalTokenUsage.cacheReadTokens > 0
                ? ` · ${t('trace.cache')} ${formatCompactTokens(goalTokenUsage.cacheReadTokens)}`
                : ''}
              {goalTokenUsage.estimatedCostCnyTotal > 0
                ? ` · ¥${goalTokenUsage.estimatedCostCnyTotal < 0.01 ? goalTokenUsage.estimatedCostCnyTotal.toFixed(4) : goalTokenUsage.estimatedCostCnyTotal.toFixed(3)}`
                : ''}
            </span>
          )}
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
  );
}
