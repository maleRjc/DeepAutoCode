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

export function WorkbenchModals({ ctx }: { ctx: any }) {
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
    <>
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
        <div
          className="palette-backdrop"
          onClick={() => {
            setShowPalette(false);
            setPaletteMode('commands');
          }}
        >
          <div className="palette-modal" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="palette-input"
              placeholder={
                paletteMode === 'symbols'
                  ? 'Go to Symbol in active file…'
                  : paletteMode === 'definitions'
                    ? 'Pick a definition candidate…'
                    : 'Type a command, setting, or file name...'
              }
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
            />
            <div className="palette-list">
              {(paletteMode === 'symbols' || paletteMode === 'definitions'
                ? symbolPaletteItems
                : [
                {
                  label: 'Go to Symbol in Editor…',
                  hint: 'Ctrl+Shift+O',
                  run: () => void openGoToSymbolPalette(),
                },
                {
                  label: 'Go to Definition under Cursor',
                  hint: 'F12',
                  run: () => void jumpToDefinitionAtCursor(),
                },
                {
                  label: 'View Problems Panel',
                  hint: 'Problems',
                  run: () => {
                    setShowBottomPanel(true);
                    setActiveBottomTab('problems');
                    void refreshWorkspaceProblems();
                  },
                },
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
                  label: 'Help: Artifacts, Subagents, Todos & Tokens',
                  hint: 'Guide 6',
                  run: () => openUserGuide('artifacts'),
                },
                {
                  label: 'Help: Agent Coding Engine (Search / Patch / Verify)',
                  hint: 'Guide 7',
                  run: () => openUserGuide('agent'),
                },
                {
                  label: 'Help: Live Web Preview & Remote SSH',
                  hint: 'Guide 8',
                  run: () => openUserGuide('preview-ssh'),
                },
                {
                  label: 'Help: Keyboard Shortcuts Reference (快捷键速查表)',
                  hint: 'Guide 9',
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
                  label: 'Remote-SSH: Reconnect Current Remote Host',
                  hint: 'SSH',
                  run: () => void handleSshReconnect(),
                },
                {
                  label: 'Remote-SSH: Check Conflict on Active File',
                  hint: 'SSH',
                  run: () => void handleSshConflictCheck(),
                },
                {
                  label: 'Remote-SSH: Disconnect Current Remote SSH Host',
                  hint: 'SSH',
                  run: () => void handleDisconnectSshHost(),
                },
                {
                  label: 'Language: Refresh LSP Diagnostics for Active File',
                  hint: 'LSP',
                  run: () => void refreshLspDiagnosticsForActiveFile(),
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
              )
                .filter((item) =>
                  item.label.toLowerCase().includes(paletteQuery.toLowerCase())
                )
                .map((item) => (
                  <div
                    key={item.label + item.hint}
                    className="palette-item"
                    onClick={() => {
                      setShowPalette(false);
                      setPaletteMode('commands');
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
                      <>
                        <button className="btn" onClick={() => void handleSshReconnect()}>
                          🔄 Reconnect
                        </button>
                        <button
                          className="btn"
                          onClick={() => void handleSshConflictCheck()}
                        >
                          ⚠ Conflict Check
                        </button>
                        <button
                          className="btn danger"
                          onClick={() => void handleDisconnectSshHost()}
                        >
                          🔌 Disconnect Remote
                        </button>
                      </>
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
    </>
  );
}
