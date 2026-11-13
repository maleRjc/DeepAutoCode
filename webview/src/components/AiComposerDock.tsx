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
  promptWantsWorkspaceArtifact,
  copyTextToClipboard,
  formatComposerMessageForClipboard,
  formatComposerSessionForClipboard,
  formatLiveComposerSnapshotForClipboard,
  parseDiffToSplitRows,
  parseSourceReferenceToken,
  findBestLineMatchInContent,
  formatLatexMathText,
  extractLatestSourceRefFromText,
  extractCompactExecutiveSummary,
  getFileVisualMeta,
  renderSyntaxHighlightedLine,
} from '../utils/workbenchUtils';

export function AiComposerDock({ ctx }: { ctx: any }) {
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
    streamingThinking,
    liveToolCalls, setLiveToolCalls,
    liveTimeline,
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

  const [expandedTimelineItems, setExpandedTimelineItems] = React.useState<Record<string, boolean>>({});

  function toggleTimelineItem(itemId: string, defaultOpen = false) {
    setExpandedTimelineItems((prev) => ({
      ...prev,
      [itemId]: prev[itemId] !== undefined ? !prev[itemId] : !defaultOpen,
    }));
  }

  function computeDiffLineStats(diff: any, tc: any): { added: number; removed: number } {
    if (diff?.unifiedDiff && typeof diff.unifiedDiff === 'string') {
      let added = 0;
      let removed = 0;
      for (const line of diff.unifiedDiff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
        if (line.startsWith('+')) added += 1;
        else if (line.startsWith('-')) removed += 1;
      }
      if (added > 0 || removed > 0) return { added, removed };
    }
    const args = tc?.args ?? tc?.input ?? {};
    const newTxt = String(args.content ?? args.newText ?? args.new_text ?? '');
    const oldTxt = String(args.oldText ?? args.old_text ?? '');
    return {
      added: newTxt ? newTxt.split('\n').length : 0,
      removed: oldTxt ? oldTxt.split('\n').length : 0,
    };
  }

  function buildMessageTimeline(m: any): Array<any> {
    if (Array.isArray(m.timeline) && m.timeline.length > 0) {
      const items = [...m.timeline];
      const hasTextItem = items.some(
        (it) => it.kind === 'text' && typeof it.text === 'string' && it.text.trim().length > 0
      );
      if (!hasTextItem && typeof m.content === 'string' && m.content.trim().length > 0) {
        items.push({
          id: `${m.id}_final_text`,
          kind: 'text',
          text: m.content,
        });
      }
      return items;
    }
    const fallback: Array<any> = [];
    if (typeof m.thinking === 'string' && m.thinking.trim().length > 0) {
      fallback.push({
        id: `${m.id}_think`,
        kind: 'thinking',
        thinking: m.thinking,
        durationMs: Math.max(1000, Math.min(25000, m.thinking.length * 15)),
      });
    }
    if (Array.isArray(m.toolCalls)) {
      m.toolCalls.forEach((tc: any, idx: number) => {
        fallback.push({
          id: tc.toolCallId || `${m.id}_tool_${idx}`,
          kind: 'tool',
          toolCall: tc,
          durationMs: tc.durationMs,
        });
      });
    }
    if (typeof m.content === 'string' && m.content.trim().length > 0) {
      fallback.push({
        id: `${m.id}_text`,
        kind: 'text',
        text: m.content,
      });
    }
    return fallback;
  }

  function renderAntigravityTimelineItem(
    item: any,
    idx: number,
    isLiveTurn: boolean,
    isLastItem: boolean,
    msgIdPrefix: string
  ) {
    const itemId = String(item.id || `${msgIdPrefix}_tl_${idx}`);

    if (item.kind === 'thinking') {
      const thoughtText = String(item.thinking || '').trim();
      if (!thoughtText) return null;
      const isActivelyThinking = isLiveTurn && isLastItem && !item.durationMs;
      const defaultOpen = isActivelyThinking;
      const isOpen =
        expandedTimelineItems[itemId] !== undefined
          ? expandedTimelineItems[itemId]
          : defaultOpen;
      const estSec = Math.max(
        1,
        Math.round(
          (item.durationMs || Math.max(1000, Math.min(30000, thoughtText.length * 16))) / 1000
        )
      );

      return (
        <div key={itemId} className="ag-thought-block">
          <div
            role="button"
            tabIndex={0}
            className="ag-thought-header"
            onClick={() => toggleTimelineItem(itemId, defaultOpen)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleTimelineItem(itemId, defaultOpen);
              }
            }}
          >
            <span className="ag-thought-chevron">{isOpen ? '▾' : '▸'}</span>
            {isActivelyThinking ? (
              <>
                <span className="ag-pulse-dot" />
                <span style={{ color: '#93c5fd', fontWeight: 600 }}>Thinking...</span>
              </>
            ) : (
              <span>Thought for {estSec}s</span>
            )}
          </div>
          {isOpen && <div className="ag-thought-body">{thoughtText}</div>}
        </div>
      );
    }

    if (item.kind === 'text') {
      const textContent = String(item.text || '');
      if (!textContent.trim()) return null;
      return (
        <div
          key={itemId}
          style={{ userSelect: 'text', WebkitUserSelect: 'text', marginTop: 2 }}
        >
          {renderFormattedMarkdown(textContent, itemId, 'assistant')}
        </div>
      );
    }

    if (item.kind === 'tool' && item.toolCall) {
      const tc = item.toolCall;
      const toolName = String(tc.toolName || '');
      const tcArgs = (tc.args ?? tc.input ?? {}) as Record<string, any>;
      const tcResult = (tc.result ?? {}) as Record<string, any>;
      const isRunning = tc.status === 'running' || tc.status === 'pending_approval';
      const isFailed = tc.status === 'failed' || tc.status === 'rejected';
      const durationMs =
        typeof tc.durationMs === 'number'
          ? tc.durationMs
          : typeof item.durationMs === 'number'
            ? item.durationMs
            : typeof tcResult.durationMs === 'number'
              ? tcResult.durationMs
              : undefined;
      const durationLabel =
        typeof durationMs === 'number'
          ? durationMs >= 1000
            ? `${(durationMs / 1000).toFixed(1)}s`
            : `${durationMs}ms`
          : '';

      // 1. Todo / Task Progress Card
      if (toolName === 'manage_todo') {
        const todos = Array.isArray(tcArgs.todos)
          ? tcArgs.todos
          : Array.isArray(tcResult.todos)
            ? tcResult.todos
            : [];
        if (todos.length > 0) {
          return (
            <div key={itemId} className="ag-task-card">
              <div className="ag-task-header">
                <span>📋 Task Progress</span>
                <span>
                  {todos.filter((t: any) => t?.status === 'completed').length}/{todos.length}
                </span>
              </div>
              {todos.map((todo: any, ti: number) => {
                const title = typeof todo === 'string' ? todo : String(todo?.title || todo?.text || '');
                const status = typeof todo === 'object' ? String(todo?.status || 'pending') : 'pending';
                const done = status === 'completed';
                const active = status === 'in_progress';
                return (
                  <div key={ti} className="ag-task-row">
                    <span
                      style={{
                        color: done ? '#4ade80' : active ? '#60a5fa' : '#64748b',
                        fontWeight: 700,
                        width: 14,
                        textAlign: 'center',
                      }}
                    >
                      {done ? '✓' : active ? '◎' : '○'}
                    </span>
                    <span
                      style={{
                        textDecoration: done ? 'line-through' : 'none',
                        opacity: done ? 0.72 : 1,
                      }}
                    >
                      {title}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        }
      }

      // 2. File Read / Analyze
      if (/^(?:read-file|read_file|read_files|outline_file|open-file)$/i.test(toolName)) {
        const rawPath = String(
          tcArgs.filePath || tcArgs.path || tcArgs.file_path || tcResult.filePath || ''
        );
        const normPath = rawPath.replace(/\\/g, '/');
        const baseName = normPath.split('/').pop() || normPath || toolName;
        const dirHint = normPath.includes('/')
          ? normPath.slice(0, normPath.lastIndexOf('/'))
          : '';
        const startLine = Number(tcArgs.startLine ?? tcArgs.start_line ?? 0);
        const endLine = Number(tcArgs.endLine ?? tcArgs.end_line ?? 0);
        const rangeLabel =
          startLine > 0
            ? endLine > 0 && endLine >= startLine
              ? `#L${startLine}-${endLine}`
              : `#L${startLine}`
            : '';
        const verb =
          toolName === 'outline_file'
            ? isRunning
              ? 'Outlining'
              : 'Outlined'
            : isRunning
              ? 'Analyzing'
              : 'Analyzed';

        return (
          <div key={itemId} className="ag-step-item">
            <div className={`ag-step-row ${isRunning ? 'running' : isFailed ? 'failed' : ''}`}>
              <div className="ag-step-left">
                {isRunning ? (
                  <span className="ag-pulse-dot" />
                ) : (
                  <span style={{ color: isFailed ? '#f87171' : '#60a5fa', fontSize: 11 }}>
                    {isFailed ? '✗' : '📄'}
                  </span>
                )}
                <span className="ag-step-verb">{verb}</span>
                {rawPath && (
                  <button
                    type="button"
                    className="ag-file-pill"
                    title={`Open ${normPath}${rangeLabel}`}
                    onClick={() =>
                      void openFileInTab(
                        rawPath,
                        true,
                        false,
                        startLine > 0 ? startLine : undefined,
                        endLine > 0 ? endLine : undefined
                      )
                    }
                  >
                    <span>{baseName}</span>
                    {rangeLabel && <span className="ag-line-range">{rangeLabel}</span>}
                  </button>
                )}
                {dirHint && (
                  <span
                    style={{
                      fontSize: 10.5,
                      color: '#64748b',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={dirHint}
                  >
                    {dirHint}
                  </span>
                )}
              </div>
              <div className="ag-step-right">
                {durationLabel && (
                  <span style={{ fontSize: 10, color: '#64748b' }}>{durationLabel}</span>
                )}
              </div>
            </div>
            {tc.error && <div className="ag-step-drawer" style={{ color: '#fca5a5' }}>{String(tc.error)}</div>}
          </div>
        );
      }

      // 3. File Edit / Write / Patch
      if (/^(?:write-file|write_file|edit_file|str_replace|apply_patch|editor|reveal-diff)$/i.test(toolName)) {
        const rawPath = String(
          tcArgs.filePath || tcArgs.path || tcArgs.file_path || tcResult.filePath || ''
        );
        const normPath = rawPath.replace(/\\/g, '/');
        const baseName = normPath.split('/').pop() || normPath || toolName;
        const diff = findPendingDiffForTool(tc);
        const stats = computeDiffLineStats(diff, tc);
        const isCreate =
          diff?.operation === 'create' || tcResult?.operation === 'create';
        const verb = isRunning
          ? 'Editing'
          : isCreate
            ? 'Created'
            : 'Edited';
        const hasDrawerContent = Boolean(diff?.unifiedDiff || tc.error);
        const isOpen = Boolean(expandedTimelineItems[itemId]);

        return (
          <div key={itemId} className="ag-step-item">
            <div
              className={`ag-step-row ${isRunning ? 'running' : isFailed ? 'failed' : ''}`}
              style={{ cursor: hasDrawerContent ? 'pointer' : 'default' }}
              onClick={() => hasDrawerContent && toggleTimelineItem(itemId, false)}
            >
              <div className="ag-step-left">
                {isRunning ? (
                  <span className="ag-pulse-dot" />
                ) : (
                  <span style={{ color: isFailed ? '#f87171' : '#4ade80', fontSize: 11 }}>
                    {isFailed ? '✗' : '✏️'}
                  </span>
                )}
                <span className="ag-step-verb">{verb}</span>
                {rawPath && (
                  <button
                    type="button"
                    className="ag-file-pill"
                    title={`Open ${normPath}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void openFileInTab(rawPath, true);
                    }}
                  >
                    <span>{baseName}</span>
                  </button>
                )}
                {(stats.added > 0 || stats.removed > 0) && (
                  <span className="ag-diff-stat">
                    {stats.added > 0 && <span className="add">+{stats.added}</span>}
                    {stats.removed > 0 && <span className="del">-{stats.removed}</span>}
                  </span>
                )}
              </div>
              <div className="ag-step-right" onClick={(e) => e.stopPropagation()}>
                {diff && (
                  <button
                    type="button"
                    className="btn"
                    style={{ padding: '1px 6px', fontSize: 10 }}
                    title={`Open Diff view for ${diff.filePath}`}
                    onClick={() => jumpToDiffHunk(diff, 0)}
                  >
                    ↗ Diff
                  </button>
                )}
                {hasDrawerContent && (
                  <span
                    className="ag-thought-chevron"
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleTimelineItem(itemId, false)}
                  >
                    {isOpen ? '▾' : '▸'}
                  </span>
                )}
              </div>
            </div>
            {isOpen && (diff?.unifiedDiff || tc.error) && (
              <div className="ag-step-drawer">
                {tc.error ? (
                  <span style={{ color: '#fca5a5' }}>{String(tc.error)}</span>
                ) : (
                  String(diff.unifiedDiff)
                    .split('\n')
                    .slice(0, 60)
                    .map((line: string, li: number) => (
                      <div
                        key={li}
                        style={{
                          color: line.startsWith('+')
                            ? '#86efac'
                            : line.startsWith('-')
                              ? '#fca5a5'
                              : line.startsWith('@@')
                                ? '#93c5fd'
                                : '#94a3b8',
                        }}
                      >
                        {line}
                      </div>
                    ))
                )}
              </div>
            )}
          </div>
        );
      }

      // 4. Terminal / Command Execution
      if (/^(?:run-build|run_command|run_commands|auto_build_and_test)$/i.test(toolName)) {
        const cmdStr = String(tcArgs.command || tcArgs.cmd || toolName).trim();
        const exitCode =
          typeof tcResult.exitCode === 'number'
            ? tcResult.exitCode
            : isFailed
              ? 1
              : isRunning
                ? undefined
                : 0;
        const cmdOutput = [tcResult.stdout, tcResult.stderr, tc.error]
          .filter((x) => typeof x === 'string' && x.trim().length > 0)
          .join('\n')
          .trim();
        const defaultOpen = Boolean(isFailed || (exitCode !== undefined && exitCode !== 0));
        const isOpen =
          expandedTimelineItems[itemId] !== undefined
            ? expandedTimelineItems[itemId]
            : defaultOpen;

        return (
          <div key={itemId} className="ag-step-item">
            <div
              className={`ag-step-row ${isRunning ? 'running' : isFailed || (exitCode !== undefined && exitCode !== 0) ? 'failed' : ''}`}
              style={{ cursor: cmdOutput ? 'pointer' : 'default' }}
              onClick={() => cmdOutput && toggleTimelineItem(itemId, defaultOpen)}
            >
              <div className="ag-step-left">
                {isRunning ? (
                  <span className="ag-pulse-dot" />
                ) : (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      fontWeight: 700,
                      color:
                        exitCode === 0
                          ? '#4ade80'
                          : exitCode !== undefined
                            ? '#f87171'
                            : '#60a5fa',
                    }}
                  >
                    {'>_'}
                  </span>
                )}
                <span className="ag-step-verb">
                  {isRunning ? 'Running command' : 'Ran command'}
                </span>
                <code className="ag-cmd-pill" title={cmdStr}>
                  {cmdStr}
                </code>
              </div>
              <div className="ag-step-right">
                {exitCode !== undefined && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: exitCode === 0 ? '#4ade80' : '#f87171',
                    }}
                  >
                    Exit {exitCode}
                  </span>
                )}
                {durationLabel && (
                  <span style={{ fontSize: 10, color: '#64748b' }}>{durationLabel}</span>
                )}
                {cmdOutput && (
                  <span className="ag-thought-chevron">{isOpen ? '▾' : '▸'}</span>
                )}
              </div>
            </div>
            {isOpen && cmdOutput && (
              <div className="ag-step-drawer">{cmdOutput.slice(-3500)}</div>
            )}
          </div>
        );
      }

      // 5. Search / Directory Listing / Web Search / Other tools
      const queryOrTarget = String(
        tcArgs.query ||
          tcArgs.dirPath ||
          tcArgs.directory ||
          tcArgs.filePath ||
          tcArgs.path ||
          tcArgs.url ||
          (Array.isArray(tcArgs.queries) ? tcArgs.queries.join(', ') : '') ||
          ''
      ).trim();
      const verb =
        toolName === 'search_codebase'
          ? isRunning
            ? 'Searching'
            : 'Searched'
          : toolName === 'explore_codebase'
            ? isRunning
              ? 'Exploring'
              : 'Explored'
            : toolName === 'list_files'
              ? isRunning
                ? 'Listing'
                : 'Listed directory'
              : toolName === 'search_web'
                ? isRunning
                  ? 'Searching web'
                  : 'Searched web'
                : formatToolStepLabel(tc);
      const detailText =
        typeof tc.error === 'string' && tc.error
          ? tc.error
          : typeof tcResult === 'string'
            ? tcResult
            : tcResult && Object.keys(tcResult).length > 0
              ? JSON.stringify(tcResult, null, 2).slice(0, 1600)
              : '';
      const isOpen = Boolean(expandedTimelineItems[itemId]);

      return (
        <div key={itemId} className="ag-step-item">
          <div
            className={`ag-step-row ${isRunning ? 'running' : isFailed ? 'failed' : ''}`}
            style={{ cursor: detailText ? 'pointer' : 'default' }}
            onClick={() => detailText && toggleTimelineItem(itemId, false)}
          >
            <div className="ag-step-left">
              {isRunning ? (
                <span className="ag-pulse-dot" />
              ) : (
                <span style={{ color: isFailed ? '#f87171' : '#93c5fd', fontSize: 11 }}>
                  {isFailed ? '✗' : /search|explore/i.test(toolName) ? '🔍' : '📁'}
                </span>
              )}
              <span className="ag-step-verb">{verb}</span>
              {queryOrTarget && (
                <code className="ag-cmd-pill" title={queryOrTarget}>
                  {queryOrTarget}
                </code>
              )}
            </div>
            <div className="ag-step-right">
              {durationLabel && (
                <span style={{ fontSize: 10, color: '#64748b' }}>{durationLabel}</span>
              )}
              {detailText && (
                <span className="ag-thought-chevron">{isOpen ? '▾' : '▸'}</span>
              )}
            </div>
          </div>
          {isOpen && detailText && (
            <div className="ag-step-drawer">{detailText}</div>
          )}
        </div>
      );
    }

    return null;
  }


  return (
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
              <span>{t('dock.composer')}</span>
            </span>
          </button>
          <button
            type="button"
            className={`ai-dock-tab ${aiTab === 'changes' ? 'active' : ''}`}
            onClick={() => setAiTab('changes')}
          >
            <span>📝 {t('dock.changes')}</span>
            <span className="ai-dock-count">
              {diffs.filter((d) => d.status === 'pending').length}
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
            <span>📑 {t('dock.artifacts')}</span>
            <span className="ai-dock-count">{artifactsList.length}</span>
          </button>
          <button
            type="button"
            className={`ai-dock-tab ${aiTab === 'sessions' ? 'active' : ''}`}
            onClick={() => {
              setAiTab('sessions');
              void refreshSessionCheckpoints();
              void refreshAgentMemory();
            }}
          >
            <span>🕒 {t('dock.history')}</span>
            <span className="ai-dock-count">{sessions.length}</span>
          </button>
          <button
            type="button"
            className={`ai-dock-tab ${aiTab === 'trace' ? 'active' : ''}`}
            onClick={() => {
              setAiTab('trace');
              void refreshTaskTrace();
            }}
          >
            <span>📡 {t('dock.trace')}</span>
            <span className="ai-dock-count">
              {Array.isArray(activeTaskTrace?.events) ? activeTaskTrace.events.length : 0}
            </span>
          </button>
        </div>
        <div className="ai-dock-actions">
          {aiTab === 'composer' && messages.length > 0 && (
            <button
              type="button"
              className="btn"
              style={{ padding: '3px 8px', fontSize: 11 }}
              title="复制本会话全部对话（含工具步骤、stderr 与错误）"
              onClick={() => {
                const text = formatComposerSessionForClipboard(messages);
                void copyTextToClipboard(text).then((ok) =>
                  setStatusNotice(
                    ok
                      ? `已复制完整会话（${messages.length} 条消息）`
                      : '复制失败，请用单条消息的「复制完整」重试'
                  )
                );
              }}
            >
              📋 复制会话
            </button>
          )}
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

      {(composerSessionTabs.length > 0 || runningSessionIds.length > 0) && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: '4px 8px',
            borderBottom: '1px solid var(--border)',
            overflowX: 'auto',
            flexShrink: 0,
          }}
        >
          {composerSessionTabs.map((sid) => {
            const s = sessions.find((x) => x.sessionId === sid);
            const running = runningSessionIds.includes(sid);
            const active = sid === activeSessionId;
            return (
              <button
                key={sid}
                type="button"
                className="btn"
                style={{
                  padding: '2px 8px',
                  fontSize: 10.5,
                  whiteSpace: 'nowrap',
                  borderColor: active ? 'var(--accent-bright)' : 'var(--border)',
                  background: active ? 'var(--accent-soft)' : 'var(--bg-card)',
                }}
                title={s?.title || sid}
                onClick={() => {
                  void selectAndResumeSession(sid);
                  void refreshSessionCheckpoints(sid);
                  setAiTab('composer');
                }}
              >
                {running ? '● ' : ''}
                {(s?.title || sid).slice(0, 18)}
              </button>
            );
          })}
          {runningSessionIds.length > 1 && (
            <span
              className="badge info"
              style={{ fontSize: 10, alignSelf: 'center' }}
              title="Multiple Composers running in parallel"
            >
              ∥ {runningSessionIds.length}
            </span>
          )}
        </div>
      )}

      {aiTab === 'changes' ? (
        <div className="ai-messages-stream">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 8,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700 }}>
              Multi-file Changes (
              {diffs.filter((d) => d.status === 'pending').length} pending / {diffs.length} total)
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn"
                style={{ padding: '3px 8px', fontSize: 11 }}
                title="Open next pending Diff file"
                onClick={() => {
                  const pending = diffs.filter((d) => d.status === 'pending');
                  if (pending.length === 0) {
                    setStatusNotice('No pending Diff files');
                    return;
                  }
                  const idx = pending.findIndex(
                    (d) =>
                      d.filePath.replace(/\\/g, '/') ===
                      String(activeTabPath || '').replace(/\\/g, '/')
                  );
                  const next = pending[(idx + 1) % pending.length];
                  void openFileInTab(next.filePath, true, true);
                  setStatusNotice(
                    `Next Diff file (${((idx + 1) % pending.length) + 1}/${pending.length}): ${next.filePath}`
                  );
                }}
              >
                Next File →
              </button>
              <button
                type="button"
                className="btn success"
                style={{ padding: '3px 8px', fontSize: 11 }}
                onClick={() => void handleReviewAllPending('accept')}
              >
                Accept All
              </button>
              <button
                type="button"
                className="btn danger"
                style={{ padding: '3px 8px', fontSize: 11 }}
                onClick={() => void handleReviewAllPending('reject')}
              >
                Reject All
              </button>
            </div>
          </div>
          {diffs.length === 0 ? (
            <div className="ai-empty-state">
              <div className="ai-empty-title">No Agent Diffs Yet</div>
              <div className="ai-empty-desc">
                When the Agent proposes file edits, they appear here for Accept / Reject — Stop keeps
                pending diffs for review.
              </div>
            </div>
          ) : (
            diffs.map((d) => (
              <div key={d.diffId} className="chat-bubble assistant">
                <div className="chat-bubble-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span
                      className={`badge ${d.status === 'accepted'
                        ? 'success'
                        : d.status === 'rejected'
                          ? 'danger'
                          : 'warning'
                        }`}
                    >
                      {String(d.status || 'pending').toUpperCase()}
                    </span>
                    <strong style={{ fontSize: 12 }}>{d.filePath}</strong>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {d.operation}
                      {d.appliedToDisk ? ' · on disk' : ' · review-before-write'}
                    </span>
                  </div>
                </div>
                {(() => {
                  const hunks =
                    d.status === 'pending' ? getDiffHunks(d) : [];
                  const decisions =
                    hunkDecisions[d.diffId] &&
                      hunkDecisions[d.diffId].length === hunks.length
                      ? hunkDecisions[d.diffId]
                      : hunks.map(() => 'pending' as const);
                  return (
                    <>
                      {hunks.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                          {hunks.map((h) => {
                            const decision = decisions[h.index] || 'pending';
                            return (
                              <div
                                key={`${d.diffId}-h${h.index}`}
                                style={{
                                  border: '1px solid var(--border)',
                                  borderRadius: 6,
                                  padding: 8,
                                  background: 'var(--bg-elevated)',
                                  opacity: decision === 'pending' ? 1 : 0.65,
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    marginBottom: 4,
                                    fontSize: 11,
                                  }}
                                >
                                  <code>{h.header}</code>
                                  <span className={`badge ${decision === 'accepted' ? 'success' : decision === 'rejected' ? 'danger' : 'warning'}`}>
                                    {decision}
                                  </span>
                                </div>
                                <pre
                                  style={{
                                    fontSize: 10.5,
                                    maxHeight: 72,
                                    overflow: 'auto',
                                    whiteSpace: 'pre-wrap',
                                    margin: 0,
                                    color: 'var(--text-secondary)',
                                  }}
                                >
                                  {h.preview}
                                </pre>
                                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                                  <button
                                    type="button"
                                    className="btn"
                                    style={{ padding: '2px 7px', fontSize: 10.5 }}
                                    onClick={() => jumpToDiffHunk(d, h.index)}
                                  >
                                    Jump →
                                  </button>
                                  {decision === 'pending' && (
                                    <>
                                      <button
                                        type="button"
                                        className="btn success"
                                        style={{ padding: '2px 7px', fontSize: 10.5 }}
                                        onClick={() => void handleHunkDecision(d, h.index, 'accepted')}
                                      >
                                        Accept Hunk
                                      </button>
                                      <button
                                        type="button"
                                        className="btn danger"
                                        style={{ padding: '2px 7px', fontSize: 10.5 }}
                                        onClick={() => void handleHunkDecision(d, h.index, 'rejected')}
                                      >
                                        Reject Hunk
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <pre
                          style={{
                            fontSize: 11,
                            maxHeight: 120,
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {String(d.unifiedDiff || '').slice(0, 900)}
                        </pre>
                      )}
                    </>
                  );
                })()}
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn"
                    style={{ padding: '3px 8px', fontSize: 11 }}
                    onClick={() => openDiffInTab(d)}
                  >
                    Open Diff
                  </button>
                  {d.status === 'pending' && (
                    <>
                      <button
                        type="button"
                        className="btn success"
                        style={{ padding: '3px 8px', fontSize: 11 }}
                        onClick={() => void handleDiffReview(d.diffId, 'accept', d.sessionId)}
                      >
                        Accept File
                      </button>
                      <button
                        type="button"
                        className="btn danger"
                        style={{ padding: '3px 8px', fontSize: 11 }}
                        onClick={() => void handleDiffReview(d.diffId, 'reject', d.sessionId)}
                      >
                        Reject File
                      </button>
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: '3px 8px', fontSize: 11 }}
                        onClick={() => void handleDiffReview(d.diffId, 'revise', d.sessionId)}
                      >
                        Revise
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      ) : aiTab === 'artifacts' ? (
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
                  {(art.artifactType === 'plan' ||
                    art.artifactType === 'task_list' ||
                    art.artifactType === 'report') && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: '3px 8px', fontSize: 11 }}
                          onClick={() => {
                            setAiTab('composer');
                            setShowRightAiDock(true);
                            setPromptInput(
                              `Revise the ${art.artifactType || 'plan'} "${art.title}": `
                            );
                          }}
                        >
                          ✏️ Revise
                        </button>
                        <button
                          type="button"
                          className="btn success"
                          style={{ padding: '3px 9px', fontSize: 11 }}
                          onClick={() => {
                            const kind =
                              art.artifactType === 'task_list'
                                ? 'Task List'
                                : art.artifactType === 'report'
                                  ? 'Report'
                                  : 'Implementation Plan';
                            setExecutionMode('auto');
                            setManualIntentChoice('auto-action');
                            setAiTab('composer');
                            setShowRightAiDock(true);
                            void handleSendPrompt(
                              `[FORCE_AUTO_ACTION] Execute the approved ${kind} "${art.title}" end-to-end.\n` +
                              `1) Sync steps into manage_todo (mark in_progress/completed as you go).\n` +
                              `2) Prefer apply_patch for surgical edits; use edit_file/write_file when needed.\n` +
                              `3) After edits, run build/verify and self-heal failures.\n` +
                              `4) Do not stop at analysis — land the code changes.\n\n` +
                              `${String(art.content || '').slice(0, 12000)}`,
                              'auto'
                            );
                          }}
                        >
                          ▶{' '}
                          {art.artifactType === 'task_list'
                            ? 'Execute Tasks'
                            : art.artifactType === 'report'
                              ? 'Act on Report'
                              : 'Proceed & Execute Plan'}
                        </button>
                      </div>
                    )}
                </div>
                <div style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
                  {renderFormattedMarkdown(String(art.content || ''), art.id, 'assistant')}
                </div>
                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: '1px dashed var(--border)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  {(artifactComments[art.id] || []).length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(artifactComments[art.id] || []).map((cText, cIdx) => (
                        <div
                          key={cIdx}
                          style={{
                            fontSize: 11,
                            padding: '4px 8px',
                            borderRadius: 4,
                            background: 'var(--bg-elevated)',
                            borderLeft: '2px solid #38bdf8',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span>💬 {cText}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            style={{ fontSize: 10, padding: '0 4px' }}
                            onClick={() =>
                              setArtifactComments((prev) => ({
                                ...prev,
                                [art.id]: (prev[art.id] || []).filter((_, i) => i !== cIdx),
                              }))
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      className="settings-input"
                      style={{ flex: 1, fontSize: 11, padding: '4px 8px' }}
                      placeholder="Add inline review comment on a section or step..."
                      value={artifactCommentInput[art.id] || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setArtifactCommentInput((prev) => ({ ...prev, [art.id]: val }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const val = (artifactCommentInput[art.id] || '').trim();
                          if (!val) return;
                          setArtifactComments((prev) => ({
                            ...prev,
                            [art.id]: [...(prev[art.id] || []), val],
                          }));
                          setArtifactCommentInput((prev) => ({ ...prev, [art.id]: '' }));
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: 11, padding: '3px 8px' }}
                      onClick={() => {
                        const val = (artifactCommentInput[art.id] || '').trim();
                        if (!val) return;
                        setArtifactComments((prev) => ({
                          ...prev,
                          [art.id]: [...(prev[art.id] || []), val],
                        }));
                        setArtifactCommentInput((prev) => ({ ...prev, [art.id]: '' }));
                      }}
                    >
                      + Comment
                    </button>
                    {(artifactComments[art.id] || []).length > 0 && (
                      <button
                        type="button"
                        className="btn primary"
                        style={{ fontSize: 11, padding: '3px 9px' }}
                        onClick={() => {
                          const list = artifactComments[art.id] || [];
                          setArtifactComments((prev) => ({ ...prev, [art.id]: [] }));
                          setAiTab('composer');
                          setShowRightAiDock(true);
                          void handleSendPrompt(
                            `Please revise the ${art.artifactType || 'plan'} "${art.title}" based on my inline review comments:\n` +
                            list.map((c, i) => `${i + 1}. ${c}`).join('\n'),
                            'plan'
                          );
                        }}
                      >
                        📨 Submit Feedback ({(artifactComments[art.id] || []).length})
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : aiTab === 'sessions' ? (
        <div className="ai-messages-stream">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>Sessions</span>
            <button
              type="button"
              className="btn"
              style={{ padding: '3px 8px', fontSize: 11 }}
              onClick={() =>
                activeSessionId &&
                void bridge
                  .request('session.checkpoint.create', {
                    sessionId: activeSessionId,
                    label: 'Manual checkpoint',
                  }, activeSessionId)
                  .then(() => refreshSessionCheckpoints(activeSessionId))
              }
            >
              + Checkpoint Now
            </button>
          </div>
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
                void refreshSessionCheckpoints(s.sessionId);
                setAiTab('composer');
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {runningSessionIds.includes(s.sessionId) ? '● ' : ''}
                {s.title}
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  color: '#8b949e',
                }}
              >
                <span>
                  Status:{' '}
                  {runningSessionIds.includes(s.sessionId) ? 'running (parallel)' : s.status}
                </span>
                <span>Mode: {s.executionMode}</span>
              </div>
            </div>
          ))}
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700 }}>
              Cross-session Memory ({agentMemoryEntries.length})
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                className="btn"
                style={{ padding: '2px 7px', fontSize: 10.5 }}
                onClick={() => void refreshAgentMemory()}
              >
                Refresh
              </button>
              <button
                type="button"
                className="btn danger"
                style={{ padding: '2px 7px', fontSize: 10.5 }}
                onClick={() =>
                  void fetch('/api/agent-memory', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clear: true }),
                  }).then(() => {
                    setAgentMemoryEntries([]);
                    setStatusNotice('Agent memory cleared');
                  })
                }
              >
                Clear
              </button>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
            Digests from <code>/compact</code> and checkpoints inject into new Agent turns.
          </div>
          {agentMemoryEntries.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6 }}>
              No memory yet. Run <code>/compact</code> or create a checkpoint.
            </div>
          ) : (
            agentMemoryEntries.slice(0, 8).map((m) => (
              <div key={m.id} className="chat-bubble" style={{ marginTop: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 12 }}>
                  {m.title}{' '}
                  <span className="badge info" style={{ fontSize: 9 }}>
                    {m.source}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {m.summary.slice(0, 280)}
                  {m.summary.length > 280 ? '…' : ''}
                </div>
              </div>
            ))
          )}
          <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700 }}>
            Checkpoints ({sessionCheckpoints.length})
          </div>
          {sessionCheckpoints.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6 }}>
              Checkpoints are created after Agent file edits. Restore rolls files back to the
              captured baseline.
            </div>
          ) : (
            sessionCheckpoints.map((ck) => (
              <div key={ck.checkpointId} className="chat-bubble" style={{ marginTop: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 12 }}>{ck.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {ck.createdAt} · {ck.files?.length || 0} files
                </div>
                <button
                  type="button"
                  className="btn danger"
                  style={{ padding: '3px 8px', fontSize: 11, marginTop: 6 }}
                  onClick={() =>
                    activeSessionId &&
                    void bridge
                      .request(
                        'session.checkpoint.restore',
                        { sessionId: activeSessionId, checkpointId: ck.checkpointId },
                        activeSessionId
                      )
                      .then(async (r: any) => {
                        await refreshWorkspaceTree();
                        setStatusNotice(
                          `Restored checkpoint (${r?.restored ?? 0} files, deleted ${r?.deleted ?? 0})`
                        );
                        setAiTab('changes');
                      })
                  }
                >
                  Restore
                </button>
              </div>
            ))
          )}
        </div>
      ) : aiTab === 'trace' ? (
        <div className="ai-messages-stream">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>{t('dock.trace')}</span>
            <button
              type="button"
              className="btn"
              style={{ padding: '3px 8px', fontSize: 11 }}
              onClick={() => void refreshTaskTrace()}
            >
              {t('trace.refresh')}
            </button>
          </div>
          {!activeTaskTrace ? (
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              {t('trace.empty')}
            </div>
          ) : (
            <>
              <div className="chat-bubble" style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 12 }}>
                  {activeTaskTrace.taskId}{' '}
                  <span className="badge info" style={{ fontSize: 9 }}>
                    {activeTaskTrace.status}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {activeTaskTrace.promptSummary}
                </div>
                <div style={{ fontSize: 11, marginTop: 6, color: 'var(--text-secondary)' }}>
                  turns {activeTaskTrace.totalTurns} · tok{' '}
                  {formatCompactTokens(Number(activeTaskTrace.tokensUsed || 0))}/
                  {formatCompactTokens(Number(activeTaskTrace.tokenBudget || 180000))} ·{' '}
                  {t('trace.cache')}{' '}
                  {formatCompactTokens(Number(activeTaskTrace.cacheReadTokens || 0))}
                </div>
              </div>
              {(Array.isArray(activeTaskTrace.events) ? activeTaskTrace.events : [])
                .slice()
                .reverse()
                .map((evt: any, idx: number) => (
                  <div
                    key={`${evt.ts || idx}-${evt.kind}-${idx}`}
                    className="chat-bubble"
                    style={{ marginTop: 6, fontSize: 11.5 }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {evt.kind}{' '}
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>
                        {evt.ts ? String(evt.ts).slice(11, 19) : ''}
                      </span>
                    </div>
                    {evt.kind === 'llm.turn' && (
                      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                        #{evt.turnIndex} · {evt.modelId} · {evt.latencyMs}ms · in{' '}
                        {formatCompactTokens(evt.inputTokens)} / out{' '}
                        {formatCompactTokens(evt.outputTokens)} · {t('trace.cache')}{' '}
                        {formatCompactTokens(evt.cacheReadTokens)}
                      </div>
                    )}
                    {evt.kind === 'tool.call' && (
                      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                        {evt.ok ? 'ok' : 'fail'} · {evt.toolName} · {evt.durationMs}ms ·{' '}
                        {evt.resultBytes}B
                        {evt.argDigest ? (
                          <div style={{ marginTop: 2, opacity: 0.85 }}>
                            {String(evt.argDigest).slice(0, 160)}
                          </div>
                        ) : null}
                        {evt.error ? (
                          <div style={{ marginTop: 2, color: '#f87171' }}>{evt.error}</div>
                        ) : null}
                      </div>
                    )}
                    {evt.kind === 'verify.result' && (
                      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                        {evt.passed ? 'PASS' : 'FAIL'} · {evt.summary}
                      </div>
                    )}
                    {evt.kind === 'agent.signal' && (
                      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                        {evt.signal} · {evt.summary}
                      </div>
                    )}
                    {evt.kind === 'task.start' && (
                      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                        mode {evt.mode}
                        {evt.modelId ? ` · ${evt.modelId}` : ''}
                      </div>
                    )}
                    {evt.kind === 'task.end' && (
                      <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                        {evt.status}
                        {evt.reason ? ` · ${evt.reason}` : ''} · cache{' '}
                        {formatCompactTokens(evt.cacheReadTokens || 0)}
                      </div>
                    )}
                  </div>
                ))}
            </>
          )}
        </div>
      ) : (
        <>
          {sessionCheckpoints.length > 0 && (
            <div
              style={{
                borderBottom: '1px solid var(--border)',
                padding: '6px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                background: 'var(--bg-elevated)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                <span>Checkpoint timeline</span>
                <button
                  type="button"
                  className="btn"
                  style={{ padding: '1px 6px', fontSize: 10 }}
                  onClick={() => activeSessionId && void refreshSessionCheckpoints(activeSessionId)}
                >
                  Refresh
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
                {sessionCheckpoints.slice(0, 12).map((ck) => (
                  <div
                    key={ck.checkpointId}
                    style={{
                      minWidth: 150,
                      border: `1px solid ${checkpointPreviewId === ck.checkpointId
                        ? 'var(--accent-bright)'
                        : 'var(--border)'
                        }`,
                      borderRadius: 6,
                      padding: '5px 7px',
                      background: 'var(--bg)',
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {(ck.label || ck.checkpointId).slice(0, 28)}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                      {(ck.files?.length || 0)} files
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: '1px 5px', fontSize: 10 }}
                        onClick={() => {
                          setCheckpointPreviewId((id) => {
                            const next = id === ck.checkpointId ? '' : ck.checkpointId;
                            if (next) void loadCheckpointPreviewDiffs(ck);
                            else setCheckpointPreviewDiffs([]);
                            return next;
                          });
                        }}
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        className="btn danger"
                        style={{ padding: '1px 5px', fontSize: 10 }}
                        onClick={() =>
                          activeSessionId &&
                          void bridge
                            .request(
                              'session.checkpoint.restore',
                              {
                                sessionId: activeSessionId,
                                checkpointId: ck.checkpointId,
                              },
                              activeSessionId
                            )
                            .then(async (r: any) => {
                              await refreshWorkspaceTree();
                              await refreshGitStatus();
                              setStatusNotice(
                                `Restored checkpoint (${r?.restored ?? 0} files, deleted ${r?.deleted ?? 0})`
                              );
                              setAiTab('changes');
                            })
                        }
                      >
                        Restore
                      </button>
                    </div>
                    {checkpointPreviewId === ck.checkpointId && (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 10,
                          color: 'var(--text-secondary)',
                          maxHeight: 160,
                          overflow: 'auto',
                        }}
                      >
                        {checkpointPreviewDiffs.length === 0 ? (
                          <div>
                            {(ck.files || [])
                              .slice(0, 8)
                              .map((f: any) => String(f.path || f.filePath || f))
                              .join('\n') || '(loading content diff…)'}
                          </div>
                        ) : (
                          checkpointPreviewDiffs.map((d) => (
                            <div key={d.path} style={{ marginBottom: 6 }}>
                              <div style={{ fontWeight: 600 }}>
                                {d.path} · {d.summary}
                              </div>
                              <pre
                                style={{
                                  margin: '2px 0 0',
                                  whiteSpace: 'pre-wrap',
                                  fontSize: 9.5,
                                  maxHeight: 72,
                                  overflow: 'auto',
                                  background: 'var(--bg-elevated)',
                                  padding: 4,
                                  borderRadius: 4,
                                }}
                              >
                                {d.preview}
                              </pre>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
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
                        `Read ${activeTab?.kind === 'code'
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
                        type="button"
                        className="btn"
                        style={{ padding: '1px 6px', fontSize: 10 }}
                        title="复制本条全部内容：正文 + 工具参数 + 结果/错误（推荐）"
                        onClick={() => {
                          const text = formatComposerMessageForClipboard(m);
                          void copyTextToClipboard(text).then((ok) =>
                            setStatusNotice(
                              ok ? '已复制完整输出（含工具步骤与错误）' : '复制失败'
                            )
                          );
                        }}
                      >
                        📋 复制完整
                      </button>
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: '1px 6px', fontSize: 10 }}
                        title="仅复制 AI 正文 Markdown"
                        onClick={() => {
                          void copyTextToClipboard(String(m.content ?? '')).then((ok) =>
                            setStatusNotice(ok ? '已复制正文' : '复制失败')
                          );
                        }}
                      >
                        仅正文
                      </button>
                      <span>#{m.sequence}</span>
                    </div>
                  </div>

                  {m.role === 'assistant' ? (
                    <div className="ag-timeline">
                      {(() => {
                        const msgTimeline = buildMessageTimeline(m);
                        return msgTimeline.map((item, idx) =>
                          renderAntigravityTimelineItem(
                            item,
                            idx,
                            false,
                            idx === msgTimeline.length - 1,
                            m.id
                          )
                        );
                      })()}
                    </div>
                  ) : (
                    <div style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
                      {renderFormattedMarkdown(m.content, m.id, m.role)}
                    </div>
                  )}
                  {Array.isArray(m.images) && m.images.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginTop: 6,
                      }}
                    >
                      {m.images.map((img: any, imgIdx: number) => (
                        <img
                          key={imgIdx}
                          src={img.dataUrl}
                          alt={img.name || `image_${imgIdx + 1}`}
                          title={img.name || `image_${imgIdx + 1}`}
                          style={{
                            maxHeight: 120,
                            maxWidth: 200,
                            borderRadius: 6,
                            border: '1px solid var(--border)',
                            objectFit: 'contain',
                          }}
                        />
                      ))}
                    </div>
                  )}

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

            {(isSendingPrompt ||
              liveTimeline.length > 0 ||
              liveToolCalls.length > 0 ||
              Boolean(streamingThinking) ||
              Boolean(streamingText)) && (
              <div className="chat-bubble assistant">
                <div className="chat-bubble-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
                      <span>DEEPAUTOCODE AI</span>
                    </span>
                    <span className="badge info" style={{ fontSize: 9.5 }}>
                      {lastModelTier?.effectiveModelId || modelInput}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: '1px 6px', fontSize: 10 }}
                      title="切换到完整执行轨迹 (Trace) 面板"
                      onClick={() => setAiTab('trace')}
                    >
                      📊 Trace
                    </button>
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: '1px 6px', fontSize: 10 }}
                      title="复制当前已生成内容与工具步骤"
                      onClick={() => {
                        const text = formatLiveComposerSnapshotForClipboard(
                          streamingText,
                          liveToolCalls
                        );
                        void copyTextToClipboard(text).then((ok) =>
                          setStatusNotice(ok ? '已复制当前实时输出（含工具步骤与错误）' : '复制失败')
                        );
                      }}
                    >
                      📋 复制实时
                    </button>
                  </div>
                </div>

                <div className="ag-timeline">
                  {(() => {
                    const effectiveLiveItems =
                      liveTimeline.length > 0
                        ? liveTimeline
                        : [
                            ...(streamingThinking
                              ? [
                                  {
                                    id: 'live_fallback_think',
                                    kind: 'thinking',
                                    thinking: streamingThinking,
                                  },
                                ]
                              : []),
                            ...liveToolCalls.map((tc: any, idx: number) => ({
                              id: tc.toolCallId || `live_fallback_tc_${idx}`,
                              kind: 'tool',
                              toolCall: tc,
                            })),
                            ...(streamingText
                              ? [
                                  {
                                    id: 'live_fallback_text',
                                    kind: 'text',
                                    text: streamingText,
                                  },
                                ]
                              : []),
                          ];

                    if (effectiveLiveItems.length === 0) {
                      return (
                        <div className="ag-thought-block">
                          <div className="ag-thought-header">
                            <span className="ag-pulse-dot" />
                            <span style={{ color: '#93c5fd', fontWeight: 600 }}>
                              Thinking...
                            </span>
                          </div>
                        </div>
                      );
                    }

                    return effectiveLiveItems.map((item: any, idx: number) =>
                      renderAntigravityTimelineItem(
                        item,
                        idx,
                        true,
                        idx === effectiveLiveItems.length - 1,
                        'live'
                      )
                    );
                  })()}
                </div>
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

            {pendingQuestions.map((qp) => {
              const qId = String(qp.questionId || '');
              const selForPrompt = questionSelections[qId] || {};
              const customForPrompt = questionCustomInputs[qId] || {};
              return (
                <div
                  key={qId}
                  className="approval-banner"
                  style={{
                    borderColor: '#38bdf8',
                    background: 'rgba(14, 165, 233, 0.08)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ color: '#38bdf8' }}>
                      ❓ Clarification Requested by Agent
                    </strong>
                    <span className="badge info">INTERACTIVE</span>
                  </div>
                  {(qp.questions || []).map((qItem: any, qIdx: number) => {
                    const qKey = String(qItem.question || `Question ${qIdx + 1}`);
                    const isMulti = Boolean(qItem.isMultiSelect);
                    const chosen = selForPrompt[qKey] || [];
                    return (
                      <div
                        key={qIdx}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600 }}>
                          {qKey}{' '}
                          <span style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                            ({isMulti ? 'Select all that apply' : 'Select one'})
                          </span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {(qItem.options || []).map((opt: string, oIdx: number) => {
                            const active = chosen.includes(opt);
                            return (
                              <button
                                key={oIdx}
                                type="button"
                                className="btn"
                                style={{
                                  fontSize: 11,
                                  padding: '4px 9px',
                                  borderColor: active ? '#38bdf8' : 'var(--border)',
                                  background: active
                                    ? 'rgba(56, 189, 248, 0.22)'
                                    : 'var(--bg-card)',
                                  color: active ? '#38bdf8' : 'var(--text-primary)',
                                }}
                                onClick={() => {
                                  setQuestionSelections((prev) => {
                                    const curPrompt = prev[qId] || {};
                                    const curList = curPrompt[qKey] || [];
                                    const nextList = isMulti
                                      ? curList.includes(opt)
                                        ? curList.filter((x) => x !== opt)
                                        : [...curList, opt]
                                      : [opt];
                                    return {
                                      ...prev,
                                      [qId]: { ...curPrompt, [qKey]: nextList },
                                    };
                                  });
                                }}
                              >
                                {active ? '✓ ' : ''}
                                {opt}
                              </button>
                            );
                          })}
                        </div>
                        <input
                          type="text"
                          className="settings-input"
                          style={{ fontSize: 11, padding: '4px 8px' }}
                          placeholder="Other / custom details (optional)..."
                          value={customForPrompt[qKey] || ''}
                          onChange={(e) => {
                            const val = e.target.value;
                            setQuestionCustomInputs((prev) => ({
                              ...prev,
                              [qId]: { ...(prev[qId] || {}), [qKey]: val },
                            }));
                          }}
                        />
                      </div>
                    );
                  })}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handleQuestionResponseSubmit(qp, true)}
                    >
                      Use Recommended Default
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => void handleQuestionResponseSubmit(qp, false)}
                    >
                      Submit Answers ⏎
                    </button>
                  </div>
                </div>
              );
            })}

            {backgroundTasks.filter((t) => t.status === 'running').length > 0 && (
              <div
                style={{
                  padding: '7px 10px',
                  borderRadius: 6,
                  border: '1px solid rgba(52, 211, 153, 0.35)',
                  background: 'rgba(16, 185, 129, 0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: '#34d399',
                  }}
                >
                  <span>
                    ⚙️ Active Background Tasks (
                    {backgroundTasks.filter((t) => t.status === 'running').length})
                  </span>
                  <button
                    type="button"
                    className="btn"
                    style={{ padding: '1px 6px', fontSize: 10 }}
                    onClick={() => void handleManageBackgroundTask('list')}
                  >
                    Refresh
                  </button>
                </div>
                {backgroundTasks
                  .filter((t) => t.status === 'running')
                  .map((task) => (
                    <div
                      key={task.taskId}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 11,
                        background: 'var(--bg-elevated)',
                        padding: '4px 8px',
                        borderRadius: 4,
                      }}
                    >
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <code>{task.taskId}</code> · <span>{task.command}</span>
                        {task.pid ? <span style={{ opacity: 0.7 }}> (PID {task.pid})</span> : null}
                      </div>
                      <button
                        type="button"
                        className="btn danger"
                        style={{ padding: '1px 7px', fontSize: 10 }}
                        onClick={() => void handleManageBackgroundTask('kill', task.taskId)}
                      >
                        Kill
                      </button>
                    </div>
                  ))}
              </div>
            )}
            <div ref={aiMessagesEndRef} />
          </div>

          <div className="composer-box">
            <div className="context-pills">
              {(() => {
                const uiIntent = detectUiPromptIntent(promptInput, executionMode);
                const activeChoice: 'query-only' | 'auto-action' =
                  manualIntentChoice === 'auto-action'
                    ? 'auto-action'
                    : manualIntentChoice === 'query-only' && uiIntent.isQueryOnly
                      ? 'query-only'
                      : uiIntent.isQueryOnly
                        ? 'query-only'
                        : 'auto-action';
                const planBlocksDeliverable =
                  promptInput.trim().length > 0 &&
                  !uiIntent.isQueryOnly &&
                  (executionMode === 'plan' || activeChoice === 'query-only');
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

                    {planBlocksDeliverable && (
                      <span
                        style={{
                          width: '100%',
                          flexBasis: '100%',
                          fontSize: 11,
                          lineHeight: 1.45,
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: 'rgba(234, 179, 8, 0.12)',
                          border: '1px solid rgba(234, 179, 8, 0.45)',
                          color: '#fde68a',
                        }}
                      >
                        {promptWantsWorkspaceArtifact(promptInput)
                          ? '📄 当前为 Plan/只读：无法写入 PDF 或 Markdown。发送时将自动切换为 Auto；或点击右侧 🛠️ Auto-Edit。'
                          : '⚠️ 当前为 Plan/只读：无法修改文件。若要改代码或写文档，请切换 Auto 或关闭 🔍 Query Only。'}
                      </span>
                    )}

                    <span
                      className="intent-mode-chip"
                      title="Attach @ Context (@git, @terminal, @rules, @file, @code, @tabs)"
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

                    <span
                      className="intent-mode-chip"
                      title="Pin current editor selection as @code"
                      style={{
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                      onClick={() => {
                        if (!editorSelection.hasSelection) {
                          setStatusNotice('Select code in the editor first');
                          return;
                        }
                        addContextChip({
                          kind: 'code',
                          label: `Selection L${editorSelection.startLine}-L${editorSelection.endLine}`,
                          value: '@code',
                        });
                      }}
                    >
                      <span>{'</>'}</span>
                      <span>@code</span>
                    </span>

                    <span
                      className="intent-mode-chip"
                      title="Pin open tabs as @tabs"
                      style={{
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                      onClick={() =>
                        addContextChip({
                          kind: 'tabs',
                          label: `Tabs (${tabs.filter((t) => t.kind === 'code').length})`,
                          value: '@tabs',
                        })
                      }
                    >
                      <span>🗂</span>
                      <span>@tabs</span>
                    </span>

                    <span
                      className="intent-mode-chip"
                      title="Attach or paste screenshot / image (Multimodal Vision)"
                      style={{
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }}
                      onClick={() => imageFileInputRef.current?.click()}
                    >
                      <span>🖼️</span>
                      <span>Image</span>
                    </span>
                    <input
                      ref={imageFileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          handleAttachImageFiles(e.target.files);
                          e.target.value = '';
                        }
                      }}
                    />
                  </>
                );
              })()}
            </div>

            {attachedImages.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  padding: '0 2px 8px',
                }}
              >
                {attachedImages.map((img) => (
                  <div
                    key={img.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '3px 8px',
                      borderRadius: 6,
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      fontSize: 11,
                    }}
                  >
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      style={{ width: 20, height: 20, objectFit: 'cover', borderRadius: 3 }}
                    />
                    <span>{img.name}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ padding: '0 4px', fontSize: 11 }}
                      onClick={() =>
                        setAttachedImages((prev) => prev.filter((x) => x.id !== img.id))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {contextChips.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  padding: '0 2px 8px',
                }}
              >
                {contextChips.map((chip) => (
                  <span
                    key={chip.id}
                    className="badge"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      cursor: 'default',
                    }}
                    title={chip.value}
                  >
                    {chip.label}
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ padding: '0 4px', fontSize: 11 }}
                      onClick={() =>
                        setContextChips((prev) => prev.filter((c) => c.id !== chip.id))
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Antigravity Interactive / Slash Commands & @ Context Mentions Popup */}
            {(() => {
              const trimmedStart = promptInput.trimStart();
              const slashMatch = trimmedStart.match(/^\/([a-zA-Z0-9_-]*)$/);
              const mentionMatch = promptInput.match(/(?:^|\s)@([a-zA-Z0-9_./\\:-]*)$/);

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
                    cmd: '/grill-me',
                    desc: 'Interactive clarification interview using ask_question before coding',
                  },
                  {
                    cmd: '/teamwork',
                    desc: 'Coordinate parallel subagents with isolated Git worktree branches',
                  },
                  {
                    cmd: '/boost',
                    desc: 'High-rigor research, planning, implementation & full verification',
                  },
                  {
                    cmd: '/schedule',
                    desc: 'Create a one-shot timer or recurring 5-field cron automation',
                  },
                  {
                    cmd: '/migrate',
                    desc: 'Migrate Claude Code / Cursor / Gemini CLI settings into a plugin',
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
                const qSymbol = q.replace(/^symbol:/, '');
                const builtinMentions = [
                  { tag: '@git', desc: 'Attach Git working tree status & diff', kind: 'builtin' },
                  { tag: '@terminal', desc: 'Attach recent terminal command output', kind: 'builtin' },
                  { tag: '@rules', desc: 'Attach workspace .agents/rules & AGENTS.md', kind: 'builtin' },
                  { tag: '@problems', desc: 'Attach workspace compiler/linter diagnostics', kind: 'builtin' },
                  { tag: '@codebase', desc: 'Semantic/hybrid retrieval across the workspace', kind: 'builtin' },
                  { tag: '@docs', desc: 'Attach README / docs / USER-GUIDE markdown', kind: 'builtin' },
                  { tag: '@web', desc: 'Fetch a URL (@web https://…)', kind: 'builtin' },
                  { tag: '@skill', desc: 'Expand workspace Skill bodies on demand', kind: 'builtin' },
                  { tag: '@symbol', desc: 'Pick a symbol from the active file outline', kind: 'builtin' },
                  { tag: '@code', desc: 'Attach current editor selection', kind: 'code' },
                  { tag: '@tabs', desc: 'Attach open editor tabs', kind: 'tabs' },
                  { tag: '@folder/src', desc: 'Attach folder listing (edit path after insert)', kind: 'folder' },
                ];
                const recentTabMentions = tabs
                  .filter((t) => t.kind === 'code' && t.path)
                  .slice(0, 8)
                  .map((t) => ({
                    tag: `@${t.path.replace(/\\/g, '/')}`,
                    desc: `Recent tab · ${t.name}`,
                    kind: 'file' as const,
                  }));
                const fileMentions = files
                  .filter((f) => f.toLowerCase().includes(q))
                  .slice(0, 12)
                  .map((f) => ({ tag: `@${f}`, desc: 'Workspace file', kind: 'file' as const }));
                const skillMentions = (workspaceCustomizations.skills || [])
                  .filter(
                    (s) =>
                      !q ||
                      q.startsWith('skill') ||
                      s.name.toLowerCase().includes(q.replace(/^skill:/, ''))
                  )
                  .slice(0, 8)
                  .map((s) => ({
                    tag: `@skill:${s.name}`,
                    desc: s.description || 'Workspace skill',
                    kind: 'builtin' as const,
                  }));
                const symbolMentions = composerSymbols
                  .filter(
                    (s) =>
                      !q ||
                      q.startsWith('symbol') ||
                      s.name.toLowerCase().includes(qSymbol) ||
                      s.kind.toLowerCase().includes(qSymbol)
                  )
                  .slice(0, 16)
                  .map((s) => ({
                    tag: `@symbol:${s.name}`,
                    desc: `${s.kind} · ${s.filePath}:L${s.startLine}-L${s.endLine}`,
                    kind: 'symbol' as const,
                    value: `${s.filePath}#${s.name}`,
                  }));
                const seen = new Set<string>();
                const allMentions = [
                  ...builtinMentions.filter((m) => m.tag.slice(1).toLowerCase().includes(q)),
                  ...skillMentions,
                  ...symbolMentions,
                  ...recentTabMentions.filter((m) => m.tag.slice(1).toLowerCase().includes(q)),
                  ...fileMentions,
                ].filter((m) => {
                  if (seen.has(m.tag)) return false;
                  seen.add(m.tag);
                  return true;
                });

                const applyMention = (item: {
                  tag: string;
                  kind: string;
                  value?: string;
                }) => {
                  setPromptInput((prev) =>
                    prev.replace(/@([a-zA-Z0-9_./\\:-]*)$/, `${item.tag} `)
                  );
                  if (item.kind === 'file') {
                    addContextChip({
                      kind: 'file',
                      label: item.tag.slice(1),
                      value: item.tag.slice(1),
                    });
                  } else if (item.kind === 'folder') {
                    addContextChip({
                      kind: 'folder',
                      label: item.tag,
                      value: item.tag.replace(/^@folder\//, ''),
                    });
                  } else if (item.kind === 'symbol') {
                    addContextChip({
                      kind: 'symbol',
                      label: item.tag,
                      value: item.value || item.tag.replace(/^@symbol:/, ''),
                    });
                  } else if (item.tag === '@symbol') {
                    // Keep @symbol: prefix so the user can continue filtering
                    setPromptInput((prev) =>
                      prev.replace(/@([a-zA-Z0-9_./\\:-]*)$/, '@symbol:')
                    );
                    return;
                  } else {
                    addContextChip({
                      kind: item.kind,
                      label: item.tag,
                      value: item.tag,
                    });
                  }
                  setMentionActiveIndex(0);
                };

                if (allMentions.length > 0) {
                  const active = Math.min(
                    Math.max(0, mentionActiveIndex),
                    allMentions.length - 1
                  );
                  return (
                    <div className="ag-composer-popup">
                      <div className="ag-composer-popup-title">
                        @ Context · ↑↓ Enter · Esc
                      </div>
                      {allMentions.map((item, idx) => (
                        <div
                          key={item.tag}
                          className="ag-composer-popup-item"
                          style={{
                            background:
                              idx === active ? 'var(--bg-hover, rgba(96,165,250,0.12))' : undefined,
                          }}
                          onMouseEnter={() => setMentionActiveIndex(idx)}
                          onClick={() => applyMention(item)}
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
              placeholder={t('composer.placeholder')}
              value={promptInput}
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                const files: File[] = [];
                for (let i = 0; i < items.length; i++) {
                  const item = items[i];
                  if (item.type.startsWith('image/')) {
                    const f = item.getAsFile();
                    if (f) files.push(f);
                  }
                }
                if (files.length > 0) {
                  handleAttachImageFiles(files);
                  setStatusNotice(`Attached ${files.length} image(s) from clipboard`);
                }
              }}
              onChange={(e) => {
                if (manualIntentChoice === 'build-fix') {
                  setManualIntentChoice(null);
                }
                setPromptInput(e.target.value);
                setMentionActiveIndex(0);
              }}
              onKeyDown={(e) => {
                const mentionMatch = promptInput.match(/(?:^|\s)@([a-zA-Z0-9_./\\:-]*)$/);
                if (mentionMatch) {
                  const q = mentionMatch[1].toLowerCase();
                  const qSymbol = q.replace(/^symbol:/, '');
                  const builtins = [
                    '@git',
                    '@terminal',
                    '@rules',
                    '@problems',
                    '@codebase',
                    '@docs',
                    '@web',
                    '@skill',
                    '@symbol',
                    '@code',
                    '@tabs',
                    '@folder/src',
                  ];
                  const symbolCount = composerSymbols.filter(
                    (s) =>
                      !q ||
                      q.startsWith('symbol') ||
                      s.name.toLowerCase().includes(qSymbol)
                  ).length;
                  const count =
                    builtins.filter((t) => t.slice(1).includes(q)).length +
                    Math.min(16, symbolCount) +
                    Math.min(
                      12,
                      files.filter((f) => f.toLowerCase().includes(q)).length
                    ) +
                    tabs.filter(
                      (t) =>
                        t.kind === 'code' &&
                        t.path &&
                        t.path.toLowerCase().includes(q)
                    ).length;
                  if (count > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setMentionActiveIndex((i) => i + 1);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setMentionActiveIndex((i) => Math.max(0, i - 1));
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setPromptInput((prev) => prev.replace(/@([a-zA-Z0-9_./\\:-]*)$/, ''));
                      setMentionActiveIndex(0);
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      // Trigger click on active item via re-using popup selection:
                      // synthesize by finding the same list order as the popup.
                      const builtinMentions = [
                        { tag: '@git', kind: 'builtin' },
                        { tag: '@terminal', kind: 'builtin' },
                        { tag: '@rules', kind: 'builtin' },
                        { tag: '@problems', kind: 'builtin' },
                        { tag: '@codebase', kind: 'builtin' },
                        { tag: '@docs', kind: 'builtin' },
                        { tag: '@web', kind: 'builtin' },
                        { tag: '@skill', kind: 'builtin' },
                        { tag: '@symbol', kind: 'builtin' },
                        { tag: '@code', kind: 'code' },
                        { tag: '@tabs', kind: 'tabs' },
                        { tag: '@folder/src', kind: 'folder' },
                      ];
                      const recentTabMentions = tabs
                        .filter((t) => t.kind === 'code' && t.path)
                        .slice(0, 8)
                        .map((t) => ({
                          tag: `@${t.path.replace(/\\/g, '/')}`,
                          kind: 'file' as const,
                        }));
                      const fileMentions = files
                        .filter((f) => f.toLowerCase().includes(q))
                        .slice(0, 12)
                        .map((f) => ({ tag: `@${f}`, kind: 'file' as const }));
                      const skillMentions = (workspaceCustomizations.skills || [])
                        .filter(
                          (s) =>
                            !q ||
                            q.startsWith('skill') ||
                            s.name.toLowerCase().includes(q.replace(/^skill:/, ''))
                        )
                        .slice(0, 8)
                        .map((s) => ({
                          tag: `@skill:${s.name}`,
                          kind: 'builtin' as const,
                        }));
                      const symbolMentions = composerSymbols
                        .filter(
                          (s) =>
                            !q ||
                            q.startsWith('symbol') ||
                            s.name.toLowerCase().includes(qSymbol)
                        )
                        .slice(0, 16)
                        .map((s) => ({
                          tag: `@symbol:${s.name}`,
                          kind: 'symbol' as const,
                          value: `${s.filePath}#${s.name}`,
                        }));
                      const seen = new Set<string>();
                      const allMentions = [
                        ...builtinMentions.filter((m) =>
                          m.tag.slice(1).toLowerCase().includes(q)
                        ),
                        ...skillMentions,
                        ...symbolMentions,
                        ...recentTabMentions.filter((m) =>
                          m.tag.slice(1).toLowerCase().includes(q)
                        ),
                        ...fileMentions,
                      ].filter((m) => {
                        if (seen.has(m.tag)) return false;
                        seen.add(m.tag);
                        return true;
                      });
                      const item =
                        allMentions[
                        Math.min(Math.max(0, mentionActiveIndex), allMentions.length - 1)
                        ];
                      if (item) {
                        if (item.tag === '@symbol') {
                          setPromptInput((prev) =>
                            prev.replace(/@([a-zA-Z0-9_./\\:-]*)$/, '@symbol:')
                          );
                          setMentionActiveIndex(0);
                          return;
                        }
                        setPromptInput((prev) =>
                          prev.replace(/@([a-zA-Z0-9_./\\:-]*)$/, `${item.tag} `)
                        );
                        if (item.kind === 'file') {
                          addContextChip({
                            kind: 'file',
                            label: item.tag.slice(1),
                            value: item.tag.slice(1),
                          });
                        } else if (item.kind === 'folder') {
                          addContextChip({
                            kind: 'folder',
                            label: item.tag,
                            value: item.tag.replace(/^@folder\//, ''),
                          });
                        } else if (item.kind === 'symbol') {
                          addContextChip({
                            kind: 'symbol',
                            label: item.tag,
                            value:
                              (item as { value?: string }).value ||
                              item.tag.replace(/^@symbol:/, ''),
                          });
                        } else {
                          addContextChip({
                            kind: item.kind,
                            label: item.tag,
                            value: item.tag,
                          });
                        }
                        setMentionActiveIndex(0);
                      }
                      return;
                    }
                  }
                }
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
                  <option value="auto">∞ {t('composer.auto')}</option>
                  <option value="plan">📖 {t('composer.plan')}</option>
                  <option value="manual">🛡️ {t('composer.manual')}</option>
                </select>

                <select
                  className="composer-select model"
                  value={modelInput}
                  onChange={(e) => {
                    const nextModel = e.target.value;
                    setModelInput(nextModel);
                    const matchingProv = (providerData?.providers || []).find(
                      (p: any) =>
                        p.defaultModelId === nextModel ||
                        (Array.isArray(p.models) &&
                          p.models.some((m: any) => m.modelId === nextModel))
                    );
                    const targetProviderId =
                      matchingProv?.providerId ||
                      (/^glm/i.test(nextModel)
                        ? 'glm'
                        : /^deepseek/i.test(nextModel)
                          ? 'deepseek'
                          : /^claude/i.test(nextModel)
                            ? 'anthropic'
                            : selectedProviderId);
                    const targetEndpoint =
                      matchingProv?.apiEndpoint ||
                      (targetProviderId === selectedProviderId ? endpointInput : undefined);
                    setSelectedProviderId(targetProviderId);
                    if (targetEndpoint) {
                      setEndpointInput(targetEndpoint);
                    }
                    void bridge
                      .request('provider.update', {
                        providerId: targetProviderId,
                        apiEndpoint: targetEndpoint,
                        modelId: nextModel,
                      })
                      .then((res: any) => {
                        if (res?.active) {
                          setProviderData((prev: any) => ({ ...prev, active: res.active }));
                        }
                      })
                      .catch(() => null);
                  }}
                  title="AI Model Routing"
                >
                  {modelInput &&
                    ![
                      'deepseek-auto',
                      'deepseek-flash',
                      'deepseek-v4-pro',
                      'glm-4-plus',
                      'glm-4-flash',
                      'glm-z1-flash',
                      'deepseek-chat',
                      'deepseek-reasoner',
                      'qwen2.5-coder:14b',
                      'claude-3-7-sonnet-latest',
                    ].includes(modelInput) && (
                      <option value={modelInput}>{modelInput} (Custom)</option>
                    )}
                  <option value="deepseek-auto">⚡ Auto Router (Flash/Pro)</option>
                  <option value="deepseek-flash">Force Flash</option>
                  <option value="deepseek-v4-pro">Force V4-Pro</option>
                  <option value="glm-4-plus">GLM-4-Plus (Official)</option>
                  <option value="glm-4-flash">GLM-4-Flash (Official)</option>
                  <option value="glm-z1-flash">GLM-Z1-Flash (Official)</option>
                  <option value="deepseek-chat">Legacy → Flash (chat)</option>
                  <option value="deepseek-reasoner">Legacy → Pro (reasoner)</option>
                  <option value="qwen2.5-coder:14b">qwen2.5-coder (Custom)</option>
                  <option value="claude-3-7-sonnet-latest">claude-3.7-sonnet</option>
                </select>
                {lastModelTier?.effectiveModelId && (
                  <span
                    className="badge info"
                    title={lastModelTier.reason || ''}
                    style={{ fontSize: 10 }}
                  >
                    {lastModelTier.effectiveModelId}
                    {lastModelTier.thinkingEnabled
                      ? `·think${lastModelTier.reasoningEffort ? `:${lastModelTier.reasoningEffort}` : ''}`
                      : ''}
                    {lastModelTier.peakHour ? '·peak' : ''}
                  </span>
                )}
                {goalTokenUsage && (
                  <span
                    className={`badge ${goalTokenUsage.tokensUsed / Math.max(1, goalTokenUsage.tokenBudget) > 0.85
                      ? 'warning'
                      : 'success'
                      }`}
                    title={`Goal tokens used ${goalTokenUsage.tokensUsed.toLocaleString()} / budget ${goalTokenUsage.tokenBudget.toLocaleString()} (remaining ${goalTokenUsage.remaining.toLocaleString()}; cache hit ${goalTokenUsage.cacheReadTokens.toLocaleString()}; est ¥${goalTokenUsage.estimatedCostCnyTotal.toFixed(4)})`}
                    style={{ fontSize: 10 }}
                  >
                    tok {formatCompactTokens(goalTokenUsage.tokensUsed)}/
                    {formatCompactTokens(goalTokenUsage.tokenBudget)}
                    {goalTokenUsage.cacheReadTokens > 0
                      ? ` · ${t('trace.cache')} ${formatCompactTokens(goalTokenUsage.cacheReadTokens)}`
                      : ''}
                    {goalTokenUsage.estimatedCostCnyTotal > 0
                      ? ` · ¥${goalTokenUsage.estimatedCostCnyTotal < 0.01 ? goalTokenUsage.estimatedCostCnyTotal.toFixed(4) : goalTokenUsage.estimatedCostCnyTotal.toFixed(3)}`
                      : ''}
                  </span>
                )}
              </div>

              <div className="composer-controls-right">
                <button className="btn danger" onClick={() => void handleStopAgent()}>
                  {t('composer.stop')}
                </button>
                <button
                  className="btn primary"
                  disabled={!promptInput.trim()}
                  onClick={() => void handleSendPrompt()}
                  title={
                    isSendingPrompt ||
                      (activeSessionId
                        ? runningSessionIds.includes(activeSessionId)
                        : false)
                      ? tr(
                        '当前 Composer 忙碌 — 发送将加入排队，当前任务结束后自动继续',
                        'This Composer is busy — Send queues a follow-up for after the current turn'
                      )
                      : tr('发送提示', 'Send prompt')
                  }
                >
                  {isSendingPrompt ||
                    (activeSessionId
                      ? runningSessionIds.includes(activeSessionId)
                      : false)
                    ? `${t('composer.queue')} ⏎`
                    : `${t('composer.send')} ⏎`}
                  {pendingPromptQueue.length > 0 ? ` (${pendingPromptQueue.length})` : ''}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
