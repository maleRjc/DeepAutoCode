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

export function SettingsCenter({ ctx }: { ctx: any }) {
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

  const [isSavingProvider, setIsSavingProvider] = React.useState(false);
  const [providerSaveNotice, setProviderSaveNotice] = React.useState<{
    ok: boolean;
    message: string;
    detail?: string;
  } | null>(null);


  return (
              <div
                className="settings-center-layout"
                style={{ gridTemplateColumns: `${settingsNavWidth}px 5px 1fr` }}
              >
                {/* Left Settings Navigation Rail (Cursor / Antigravity style) */}
                <aside className="settings-nav">
                  <div
                    className="settings-nav-title"
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <BrandMark size={16} radius={4} />
                    <span>{t('settings.title')}</span>
                  </div>
                  {[
                    { id: 'general', icon: '⚙️', label: t('settings.nav.general') },
                    { id: 'models', icon: '🤖', label: t('settings.nav.models') },
                    { id: 'security', icon: '🛡️', label: t('settings.nav.security') },
                    { id: 'rules', icon: '📜', label: t('settings.nav.rules') },
                    { id: 'mcp', icon: '🔌', label: t('settings.nav.mcp') },
                    { id: 'extensions', icon: '🧩', label: t('settings.nav.extensions') },
                  ].map((nav) => (
                    <div
                      key={nav.id}
                      className={`settings-nav-item ${
                        settingsCategory === nav.id ? 'active' : ''
                      }`}
                      onClick={() => setSettingsCategory(nav.id as SettingsCategory)}
                    >
                      <span>{nav.icon}</span>
                      <span>{nav.label}</span>
                    </div>
                  ))}
                </aside>

                {/* Resizable Sash inside Settings Center */}
                <div
                  className={`resizer-col ${draggingSash === 'settings' ? 'dragging' : ''}`}
                  title="Drag to resize Settings navigation"
                  onMouseDown={(e) => startPaneResize('settings', e)}
                />

                {/* Right Settings Content Pane */}
                <div className="settings-content">
                  {settingsCategory === 'general' && (
                    <div>
                      <div className="settings-section-title">{t('settings.general.title')}</div>
                      <div className="settings-section-desc">{t('settings.general.desc')}</div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.language')}</div>
                            <div className="settings-sublabel">{t('settings.language.hint')}</div>
                          </div>
                          <select
                            className="settings-select"
                            style={{ minWidth: 160 }}
                            value={locale}
                            onChange={(e) => setAppLocale(normalizeLocale(e.target.value))}
                          >
                            {APP_LOCALES.map((loc) => (
                              <option key={loc.id} value={loc.id}>
                                {loc.nativeLabel}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.workspace')}</div>
                            <div className="settings-sublabel">{workspaceRoot}</div>
                          </div>
                          <button
                            className="btn primary"
                            onClick={() => void handleOpenProjectAction()}
                          >
                            📂 {t('settings.openFolder')}
                          </button>
                        </div>

                        <div style={{ marginTop: 12 }}>
                          <div className="settings-sublabel" style={{ marginBottom: 8 }}>
                            {t('settings.recent')}
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {(ideSettings.recentWorkspaces ?? []).map((ws: string) => (
                              <button
                                key={ws}
                                className={`btn ${ws === workspaceRoot ? 'primary' : ''}`}
                                onClick={() => void switchProjectFolder(ws)}
                              >
                                📁 {ws}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.fontSize')}</div>
                            <div className="settings-sublabel">{t('settings.fontSize.hint')}</div>
                          </div>
                          <input
                            type="number"
                            className="settings-input"
                            style={{ minWidth: 90, width: 90 }}
                            value={ideSettings.editor?.fontSize ?? 13}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                editor: {
                                  ...ideSettings.editor,
                                  fontSize: Number(e.target.value),
                                },
                              })
                            }
                          />
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.tabSize')}</div>
                            <div className="settings-sublabel">{t('settings.tabSize.hint')}</div>
                          </div>
                          <select
                            className="settings-select"
                            style={{ minWidth: 120 }}
                            value={ideSettings.editor?.tabSize ?? 2}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                editor: {
                                  ...ideSettings.editor,
                                  tabSize: Number(e.target.value),
                                },
                              })
                            }
                          >
                            <option value={2}>{t('settings.tab.2')}</option>
                            <option value={4}>{t('settings.tab.4')}</option>
                          </select>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.autoSave')}</div>
                            <div className="settings-sublabel">{t('settings.autoSave.hint')}</div>
                          </div>
                          <select
                            className="settings-select"
                            value={ideSettings.editor?.autoSave ?? 'afterDelay'}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                editor: { ...ideSettings.editor, autoSave: e.target.value },
                              })
                            }
                          >
                            <option value="afterDelay">{t('settings.autoSave.afterDelay')}</option>
                            <option value="onFocusChange">
                              {t('settings.autoSave.onFocusChange')}
                            </option>
                            <option value="off">{t('settings.autoSave.off')}</option>
                          </select>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.theme.label')}</div>
                            <div className="settings-sublabel">{t('settings.theme.hint')}</div>
                          </div>
                          <select
                            className="settings-select"
                            value={ideSettings.editor?.theme ?? 'cursor-dark'}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                editor: { ...ideSettings.editor, theme: e.target.value },
                              })
                            }
                          >
                            <option value="cursor-dark">{t('settings.theme.dark')}</option>
                            <option value="cursor-light">{t('settings.theme.light')}</option>
                            <option value="antigravity-midnight">
                              {t('settings.theme.midnight')}
                            </option>
                            <option value="high-contrast">{t('settings.theme.contrast')}</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'models' && (
                    <div>
                      <div className="settings-section-title">{t('settings.models.title')}</div>
                      <div className="settings-section-desc">{t('settings.models.desc')}</div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.models.provider')}</div>
                            <div className="settings-sublabel">
                              {t('settings.models.provider.hint')}
                            </div>
                          </div>
                          <select
                            className="settings-select"
                            value={selectedProviderId}
                            onChange={(e) => {
                              const id = e.target.value;
                              setSelectedProviderId(id);
                              const found = providerData?.providers?.find(
                                (p: any) => p.providerId === id
                              );
                              if (found) {
                                setEndpointInput(found.apiEndpoint);
                                setModelInput(found.defaultModelId);
                              }
                            }}
                          >
                            <option value="deepseek">DeepSeek (Default)</option>
                            <option value="glm">GLM (Zhipu BigModel Official)</option>
                            <option value="openai-compatible">
                              Custom / OpenAI-Compatible (vLLM / SGLang / Ollama / Gateway)
                            </option>
                            <option value="anthropic">Anthropic Claude</option>
                          </select>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.models.endpoint')}</div>
                            <div className="settings-sublabel">
                              {t('settings.models.endpoint.hint')}
                            </div>
                          </div>
                          <input
                            className="settings-input"
                            placeholder="https://api.deepseek.com/v1 或自定义本地服务地址"
                            value={endpointInput}
                            onChange={(e) => setEndpointInput(e.target.value)}
                          />
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.models.modelId')}</div>
                            <div className="settings-sublabel">
                              {t('settings.models.modelId.hint')}
                            </div>
                          </div>
                          <input
                            className="settings-input"
                            list="dac-provider-model-presets"
                            placeholder="例如 deepseek-flash / glm-4-plus 或自定义模型名称"
                            value={modelInput}
                            onChange={(e) => setModelInput(e.target.value)}
                          />
                          <datalist id="dac-provider-model-presets">
                            <option value="deepseek-flash" />
                            <option value="deepseek-v4-pro" />
                            <option value="glm-4-plus" />
                            <option value="glm-4-flash" />
                            <option value="glm-z1-flash" />
                            <option value="glm-4-air" />
                            <option value="qwen2.5-coder:14b" />
                            <option value="claude-3-7-sonnet-latest" />
                          </datalist>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.models.apiKey')}</div>
                            <div className="settings-sublabel">
                              {t('settings.models.apiKey.hint')}（本地 vLLM / SGLang 可留空或填 EMPTY）
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                              type="password"
                              className="settings-input"
                              placeholder={
                                providerData?.active?.hasApiKeyConfigured
                                  ? t('settings.models.apiKey.configured')
                                  : '本地部署留空自动使用 EMPTY，云端填 sk-...'
                              }
                              value={apiKeyInput}
                              onChange={(e) => setApiKeyInput(e.target.value)}
                            />
                            <button
                              className="btn success"
                              style={{ whiteSpace: 'nowrap', padding: '6px 12px' }}
                              disabled={isTestingKey}
                              onClick={() => void handleTestAiKey()}
                            >
                              {isTestingKey
                                ? t('settings.models.testing')
                                : t('settings.models.test')}
                            </button>
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                          <button
                            className="btn primary"
                            disabled={isSavingProvider}
                            onClick={async () => {
                              setIsSavingProvider(true);
                              setProviderSaveNotice(null);
                              setSmokeResult(null);
                              try {
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
                                const nextModel = modelInput.trim();
                                const effectiveKey =
                                  apiKeyInput.trim() ||
                                  (selectedProviderId === 'glm' || isLocalEndpoint
                                    ? 'EMPTY'
                                    : undefined);
                                const res = await bridge.request('provider.update', {
                                  providerId: selectedProviderId,
                                  apiEndpoint: nextEndpoint,
                                  modelId: nextModel,
                                  apiKey: effectiveKey,
                                });
                                // Also keep ~/.claude/settings.json universally compatible with current settings
                                const claudeResp = await fetch('/api/claude-settings', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    providerId: selectedProviderId,
                                    authToken: effectiveKey || 'EMPTY',
                                    baseUrl: nextEndpoint,
                                    defaultModel: nextModel,
                                    opusModel: nextModel,
                                    sonnetModel: nextModel,
                                    haikuModel: nextModel,
                                  }),
                                })
                                  .then((r) => r.json())
                                  .catch(() => null);
                                if (sshStatus?.connected && claudeResp?.config) {
                                  const jsonText = JSON.stringify(claudeResp.config, null, 2);
                                  const b64 = btoa(unescape(encodeURIComponent(jsonText)));
                                  await bridge
                                    .request(
                                      'capability.invoke',
                                      {
                                        capability: 'run-build',
                                        executionMode: 'auto',
                                        params: {
                                          command: `mkdir -p ~/.claude && echo '${b64}' | base64 -d > ~/.claude/settings.json`,
                                        },
                                      },
                                      activeSessionId || undefined
                                    )
                                    .catch(() => null);
                                }
                                const refreshed = await bridge
                                  .request<any>('provider.get')
                                  .catch(() => null);
                                setProviderData(
                                  refreshed || { ...providerData, active: res.active }
                                );
                                setApiKeyInput('');
                                const savedEndpoint =
                                  res?.updated?.apiEndpoint ||
                                  res?.active?.provider?.apiEndpoint ||
                                  nextEndpoint;
                                const savedModel =
                                  res?.updated?.defaultModelId ||
                                  res?.active?.model?.modelId ||
                                  nextModel;
                                setProviderSaveNotice({
                                  ok: true,
                                  message: `✅ Provider 配置已保存 (${selectedProviderId} / ${savedModel})`,
                                  detail: `接口地址：${savedEndpoint}`,
                                });
                                setStatusNotice(
                                  `已保存模型配置 (${selectedProviderId} / ${savedModel})`
                                );
                              } catch (err) {
                                const msg = (err as Error)?.message || String(err);
                                setProviderSaveNotice({
                                  ok: false,
                                  message: `❌ 保存 Provider 配置失败`,
                                  detail: msg,
                                });
                                setStatusNotice(`保存模型配置失败: ${msg}`);
                              } finally {
                                setIsSavingProvider(false);
                              }
                            }}
                          >
                            {isSavingProvider ? '⏳ 正在保存...' : t('settings.models.save')}
                          </button>
                          <button
                            className="btn"
                            disabled={isTestingKey}
                            onClick={() => {
                              setProviderSaveNotice(null);
                              void handleTestAiKey();
                            }}
                          >
                            {isTestingKey
                              ? t('settings.models.verifying')
                              : t('settings.models.testFull')}
                          </button>
                        </div>

                        {providerSaveNotice && !smokeResult && (
                          <div
                            className={`ai-key-test-banner ${
                              providerSaveNotice.ok ? 'ok' : 'fail'
                            }`}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                              }}
                            >
                              <strong style={{ fontSize: 13 }}>
                                {providerSaveNotice.message}
                              </strong>
                              <span
                                className={`badge ${
                                  providerSaveNotice.ok ? 'success' : 'danger'
                                }`}
                              >
                                {providerSaveNotice.ok ? 'SAVED' : 'ERROR'}
                              </span>
                            </div>
                            {providerSaveNotice.detail && (
                              <div style={{ color: 'var(--text-primary)', fontSize: 12, marginTop: 4 }}>
                                <code className="md-inline-code">{providerSaveNotice.detail}</code>
                              </div>
                            )}
                          </div>
                        )}

                        {smokeResult && (
                          <div
                            className={`ai-key-test-banner ${
                              smokeResult.ok ? 'ok' : 'fail'
                            }`}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                              }}
                            >
                              <strong style={{ fontSize: 13 }}>
                                {smokeResult.ok
                                  ? `${t('settings.models.ok')} (${smokeResult.providerId} / ${smokeResult.modelId})`
                                  : `${t('settings.models.fail')} (${smokeResult.providerId} / ${smokeResult.modelId})`}
                              </strong>
                              <span
                                className={`badge ${
                                  smokeResult.ok ? 'success' : 'danger'
                                }`}
                              >
                                {smokeResult.ok
                                  ? `${smokeResult.latencyMs} ms`
                                  : smokeResult.diagnostic?.code || 'ERROR'}
                              </span>
                            </div>
                            {smokeResult.ok ? (
                              <div style={{ color: 'var(--text-primary)', fontSize: 12 }}>
                                {t('settings.models.preview')}
                                <code
                                  className="md-inline-code"
                                  style={{ marginLeft: 6 }}
                                >
                                  {smokeResult.replyPreview || t('settings.models.connected')}
                                </code>
                              </div>
                            ) : (
                              <div style={{ color: 'var(--text-primary)', fontSize: 12 }}>
                                <div>
                                  {t('settings.models.reason')}{' '}
                                  {smokeResult.diagnostic?.userMessage ||
                                    t('settings.models.unable')}
                                </div>
                                {smokeResult.diagnostic?.remediation && (
                                  <div style={{ marginTop: 4, opacity: 0.9 }}>
                                    {t('settings.models.remediation')}{' '}
                                    {smokeResult.diagnostic.remediation}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'security' && (
                    <div>
                      <div className="settings-section-title">{t('settings.security.title')}</div>
                      <div className="settings-section-desc">{t('settings.security.desc')}</div>

                      <div className="settings-card">
                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.security.mode')}</div>
                            <div className="settings-sublabel">
                              {t('settings.security.mode.hint')}
                            </div>
                          </div>
                          <select
                            className="settings-select"
                            value={executionMode}
                            onChange={(e) => {
                              const m = e.target.value as any;
                              setExecutionMode(m);
                              void persistIdeSettings({
                                ...ideSettings,
                                agent: { ...ideSettings.agent, defaultExecutionMode: m },
                              });
                            }}
                          >
                            <option value="auto">{t('settings.security.mode.auto')}</option>
                            <option value="plan">{t('settings.security.mode.plan')}</option>
                            <option value="manual">{t('settings.security.mode.manual')}</option>
                          </select>
                        </div>

                        <div className="settings-row">
                          <div>
                            <div className="settings-label">{t('settings.security.timeout')}</div>
                            <div className="settings-sublabel">
                              {t('settings.security.timeout.hint')}
                            </div>
                          </div>
                          <input
                            type="number"
                            className="settings-input"
                            style={{ minWidth: 100, width: 100 }}
                            value={ideSettings.agent?.approvalTimeoutSeconds ?? 120}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                agent: {
                                  ...ideSettings.agent,
                                  approvalTimeoutSeconds: Number(e.target.value),
                                },
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 6 }}>
                          {t('settings.security.verify')}
                        </div>
                        <div className="settings-sublabel" style={{ marginBottom: 10 }}>
                          {t('settings.security.verify.hint')}
                        </div>
                        <div style={{ display: 'grid', gap: 8 }}>
                          <input
                            className="settings-input"
                            placeholder={t('settings.security.buildPh')}
                            value={ideSettings.agent?.verifyBuildCommand ?? 'npm run build'}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                agent: {
                                  ...ideSettings.agent,
                                  verifyBuildCommand: e.target.value,
                                },
                              })
                            }
                          />
                          <input
                            className="settings-input"
                            placeholder={t('settings.security.testPh')}
                            value={ideSettings.agent?.verifyTestCommand ?? 'npm test'}
                            onChange={(e) =>
                              void persistIdeSettings({
                                ...ideSettings,
                                agent: {
                                  ...ideSettings.agent,
                                  verifyTestCommand: e.target.value,
                                },
                              })
                            }
                          />
                          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                            <input
                              type="checkbox"
                              checked={ideSettings.agent?.enableEvolveSandbox !== false}
                              onChange={(e) =>
                                void persistIdeSettings({
                                  ...ideSettings,
                                  agent: {
                                    ...ideSettings.agent,
                                    enableEvolveSandbox: e.target.checked,
                                  },
                                })
                              }
                            />
                            {t('settings.security.evolve')}
                          </label>
                        </div>
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 6 }}>
                          {t('settings.security.allowlist')}
                        </div>
                        <div className="settings-sublabel" style={{ marginBottom: 10 }}>
                          {t('settings.security.allowlist.hint')}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                          {(ideSettings.agent?.commandAllowlist ?? []).map((cmd: string) => (
                            <span key={cmd} className="context-pill">
                              <code>{cmd}</code>
                              <span
                                style={{ cursor: 'pointer', marginLeft: 4 }}
                                onClick={() => {
                                  const next = (
                                    ideSettings.agent?.commandAllowlist ?? []
                                  ).filter((c: string) => c !== cmd);
                                  void persistIdeSettings({
                                    ...ideSettings,
                                    agent: { ...ideSettings.agent, commandAllowlist: next },
                                  });
                                }}
                              >
                                ✕
                              </span>
                            </span>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            className="settings-input"
                            placeholder={t('settings.security.allowlist.ph')}
                            value={newAllowlistCmd}
                            onChange={(e) => setNewAllowlistCmd(e.target.value)}
                          />
                          <button
                            className="btn primary"
                            onClick={() => {
                              if (!newAllowlistCmd.trim()) return;
                              const next = [
                                ...(ideSettings.agent?.commandAllowlist ?? []),
                                newAllowlistCmd.trim(),
                              ];
                              setNewAllowlistCmd('');
                              void persistIdeSettings({
                                ...ideSettings,
                                agent: { ...ideSettings.agent, commandAllowlist: next },
                              });
                            }}
                          >
                            {t('settings.security.allowlist.add')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'rules' && (
                    <div>
                      <div className="settings-section-title">{t('settings.rules.title')}</div>
                      <div className="settings-section-desc">{t('settings.rules.desc')}</div>

                      <div className="settings-card">
                        <div className="settings-row" style={{ marginBottom: 12 }}>
                          <div>
                            <div className="settings-label">
                              {t('settings.rules.workspace')} (
                              {t('settings.rules.count', {
                                rules: workspaceCustomizations.rules.length,
                                skills: workspaceCustomizations.skills.length,
                                workflows: workspaceCustomizations.workflows.length,
                              })}
                              )
                            </div>
                            <div className="settings-sublabel">
                              {t('settings.rules.workspace.hint')}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              className="btn primary"
                              onClick={() => void handleScaffoldCustomization('rule')}
                            >
                              {t('settings.rules.newRule')}
                            </button>
                            <button
                              className="btn"
                              onClick={() => void handleScaffoldCustomization('skill')}
                            >
                              {t('settings.rules.newSkill')}
                            </button>
                            <button
                              className="btn"
                              onClick={() => void handleScaffoldCustomization('workflow')}
                            >
                              {t('settings.rules.newWorkflow')}
                            </button>
                          </div>
                        </div>

                        {(workspaceCustomizations.rules.length > 0 ||
                          workspaceCustomizations.skills.length > 0 ||
                          workspaceCustomizations.workflows.length > 0) && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                            {workspaceCustomizations.rules.map((r) => (
                              <div
                                key={r.path}
                                className="settings-row"
                                style={{ cursor: 'pointer' }}
                                onClick={() => void openFileInTab(r.path, true)}
                              >
                                <div>
                                  <span className="badge info" style={{ marginRight: 8 }}>RULE</span>
                                  <strong>{r.name}</strong>
                                </div>
                                <code className="md-inline-code">{r.path}</code>
                              </div>
                            ))}
                            {workspaceCustomizations.skills.map((s) => (
                              <div
                                key={s.path}
                                className="settings-row"
                                style={{ cursor: 'pointer' }}
                                onClick={() => void openFileInTab(s.path, true)}
                              >
                                <div>
                                  <span className="badge success" style={{ marginRight: 8 }}>SKILL</span>
                                  <strong>{s.name}</strong> — <span style={{ fontSize: 12, opacity: 0.8 }}>{s.description}</span>
                                </div>
                                <code className="md-inline-code">{s.path}</code>
                              </div>
                            ))}
                            {workspaceCustomizations.workflows.map((w) => (
                              <div
                                key={w.path}
                                className="settings-row"
                                style={{ cursor: 'pointer' }}
                                onClick={() => void openFileInTab(w.path, true)}
                              >
                                <div>
                                  <span className="badge warning" style={{ marginRight: 8 }}>WORKFLOW</span>
                                  <strong>{w.name}</strong> — <span style={{ fontSize: 12, opacity: 0.8 }}>{w.description}</span>
                                </div>
                                <code className="md-inline-code">{w.path}</code>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="settings-label" style={{ marginBottom: 8 }}>
                          {t('settings.rules.user')}
                        </div>
                        <div className="settings-sublabel" style={{ marginBottom: 6 }}>
                          {t('settings.rules.user.hint')}
                        </div>
                        <textarea
                          style={{
                            width: '100%',
                            minHeight: 100,
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            color: 'var(--text-primary)',
                            padding: 12,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            lineHeight: 1.6,
                          }}
                          value={ideSettings.agent?.userRules ?? ''}
                          onChange={(e) =>
                            setIdeSettings({
                              ...ideSettings,
                              agent: { ...ideSettings.agent, userRules: e.target.value },
                            })
                          }
                          placeholder={t('settings.rules.user.ph')}
                        />
                        <div className="settings-label" style={{ margin: '14px 0 8px' }}>
                          {t('settings.rules.project')}
                        </div>
                        <div className="settings-sublabel" style={{ marginBottom: 6 }}>
                          {t('settings.rules.project.hint')}
                        </div>
                        <textarea
                          style={{
                            width: '100%',
                            minHeight: 140,
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            color: 'var(--text-primary)',
                            padding: 12,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12.5,
                            lineHeight: 1.6,
                          }}
                          value={ideSettings.agent?.projectRules ?? ''}
                          onChange={(e) =>
                            setIdeSettings({
                              ...ideSettings,
                              agent: { ...ideSettings.agent, projectRules: e.target.value },
                            })
                          }
                        />
                        <div style={{ marginTop: 12 }}>
                          <button
                            className="btn primary"
                            onClick={() => void persistIdeSettings(ideSettings)}
                          >
                            {t('settings.rules.save')}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'mcp' && (
                    <div>
                      <div className="settings-section-title">{t('settings.mcp.title')}</div>
                      <div className="settings-section-desc">{t('settings.mcp.desc')}</div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10 }}>
                          {t('settings.mcp.caps')}
                        </div>
                        {(registeredCapabilities ?? []).map((cap: any) => (
                          <div key={cap.name} className="settings-row">
                            <div>
                              <div className="settings-label">
                                <code>{cap.name}</code>{' '}
                                <span
                                  className={`badge ${
                                    cap.requiresApprovalByDefault ? 'warning' : 'success'
                                  }`}
                                >
                                  {cap.requiresApprovalByDefault
                                    ? t('settings.mcp.requiresApproval')
                                    : t('settings.mcp.safeAuto')}
                                </span>
                              </div>
                              <div className="settings-sublabel">{cap.description}</div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: '#60a5fa',
                                  fontFamily: 'var(--font-mono)',
                                  marginTop: 2,
                                }}
                              >
                                {t('settings.mcp.hostApi')} {cap.codeOssApi}
                              </div>
                            </div>
                            <span className="badge">
                              {t('settings.mcp.timeout')} {cap.defaultTimeoutMs}ms
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 10 }}>
                          {t('settings.mcp.servers')}
                        </div>
                        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px 0' }}>
                          {t('settings.mcp.servers.hint')}
                        </p>
                        {(ideSettings.mcpServers ?? []).map((srv: any) => (
                          <div
                            key={srv.id}
                            style={{
                              borderBottom: '1px solid var(--border)',
                              padding: '8px 0',
                            }}
                          >
                            <div className="settings-row">
                              <div>
                                <div className="settings-label">{srv.name}</div>
                                <div
                                  className="settings-sublabel"
                                  style={{ fontFamily: 'var(--font-mono)' }}
                                >
                                  [{srv.transport}] {srv.commandOrUrl}
                                </div>
                                {srv.env && Object.keys(srv.env).length > 0 && (
                                  <div className="settings-sublabel">
                                    {t('settings.mcp.env')} {Object.keys(srv.env).join(', ')}
                                  </div>
                                )}
                                {srv.headers && Object.keys(srv.headers).length > 0 && (
                                  <div className="settings-sublabel">
                                    {t('settings.mcp.headers')}{' '}
                                    {Object.keys(srv.headers).join(', ')}
                                  </div>
                                )}
                                {(srv.disabledTools || []).length > 0 && (
                                  <div className="settings-sublabel">
                                    {t('settings.mcp.disabledTools')}{' '}
                                    {(srv.disabledTools || []).join(', ')}
                                  </div>
                                )}
                              </div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <button
                                  className="btn"
                                  style={{ padding: '2px 8px', fontSize: 11 }}
                                  onClick={() => {
                                    const next = (ideSettings.mcpServers ?? []).map((s: any) =>
                                      s.id === srv.id ? { ...s, enabled: s.enabled === false } : s
                                    );
                                    void persistIdeSettings({ ...ideSettings, mcpServers: next });
                                  }}
                                >
                                  {srv.enabled === false
                                    ? t('settings.mcp.enable')
                                    : t('settings.mcp.disable')}
                                </button>
                                <span
                                  className={`badge ${
                                    String(srv.commandOrUrl || '').startsWith('builtin://')
                                      ? 'warning'
                                      : srv.enabled === false
                                        ? 'danger'
                                        : 'success'
                                  }`}
                                >
                                  {String(srv.commandOrUrl || '').startsWith('builtin://')
                                    ? t('settings.mcp.placeholder')
                                    : srv.enabled === false
                                      ? t('settings.mcp.disabled')
                                      : t('settings.mcp.enabled')}
                                </span>
                                <button
                                  className="btn"
                                  style={{ padding: '2px 8px', fontSize: 11 }}
                                  onClick={() => {
                                    const next = (ideSettings.mcpServers ?? []).filter(
                                      (s: any) => s.id !== srv.id
                                    );
                                    void persistIdeSettings({ ...ideSettings, mcpServers: next });
                                  }}
                                >
                                  {t('settings.mcp.remove')}
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                          <input
                            className="settings-input"
                            placeholder={t('settings.mcp.namePh')}
                            value={newMcpName}
                            onChange={(e) => setNewMcpName(e.target.value)}
                          />
                          <select
                            className="settings-input"
                            value={newMcpTransport}
                            onChange={(e) =>
                              setNewMcpTransport(e.target.value as 'stdio' | 'sse' | 'http')
                            }
                            style={{ maxWidth: 140 }}
                            title="MCP transport"
                          >
                            <option value="stdio">stdio</option>
                            <option value="sse">sse (HTTP+SSE)</option>
                            <option value="http">http (Streamable)</option>
                          </select>
                          <input
                            className="settings-input"
                            placeholder={
                              newMcpTransport === 'stdio'
                                ? t('settings.mcp.cmdPh')
                                : t('settings.mcp.urlPh')
                            }
                            value={newMcpCmd}
                            onChange={(e) => setNewMcpCmd(e.target.value)}
                          />
                          <input
                            className="settings-input"
                            placeholder={t('settings.mcp.envPh')}
                            value={newMcpEnv}
                            onChange={(e) => setNewMcpEnv(e.target.value)}
                            style={{ minWidth: 200 }}
                          />
                          <input
                            className="settings-input"
                            placeholder={t('settings.mcp.headersPh')}
                            value={newMcpHeaders}
                            onChange={(e) => setNewMcpHeaders(e.target.value)}
                            style={{ minWidth: 260 }}
                            title="Paste Bearer token or custom headers. Full OAuth browser flow can use accessToken in mcp.json auth."
                          />
                          <button
                            className="btn primary"
                            onClick={() => {
                              if (!newMcpName.trim() || !newMcpCmd.trim()) return;
                              const env: Record<string, string> = {};
                              for (const part of newMcpEnv.split(/[,;\n]+/)) {
                                const m = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
                                if (m) env[m[1]] = m[2];
                              }
                              const headers: Record<string, string> = {};
                              for (const part of newMcpHeaders.split(/[,;\n]+/)) {
                                const m = part.trim().match(/^([A-Za-z0-9_-]+)=(.*)$/);
                                if (m) headers[m[1]] = m[2];
                              }
                              const next = [
                                ...(ideSettings.mcpServers ?? []),
                                {
                                  id: `mcp_${Date.now()}`,
                                  name: newMcpName.trim(),
                                  transport: newMcpTransport,
                                  commandOrUrl: newMcpCmd.trim(),
                                  enabled: true,
                                  env: Object.keys(env).length ? env : undefined,
                                  headers: Object.keys(headers).length ? headers : undefined,
                                  disabledTools: [],
                                },
                              ];
                              setNewMcpName('');
                              setNewMcpCmd('');
                              setNewMcpEnv('');
                              setNewMcpHeaders('');
                              setNewMcpTransport('stdio');
                              void persistIdeSettings({ ...ideSettings, mcpServers: next });
                              setStatusNotice(
                                `MCP ${newMcpTransport} server saved → .deepautocode/mcp.json`
                              );
                            }}
                          >
                            {t('settings.mcp.add')}
                          </button>
                          <button
                            className="btn"
                            disabled={isTestingMcp}
                            onClick={() => {
                              setIsTestingMcp(true);
                              void fetch('/api/mcp/test', { method: 'POST' })
                                .then((r) => r.json())
                                .then((res) => {
                                  setMcpTestResult({
                                    ok: Boolean(res.ok),
                                    tools: Array.isArray(res.tools) ? res.tools : [],
                                    error: res.error || null,
                                    serverCount: res.serverCount,
                                  });
                                  setStatusNotice(
                                    res.ok
                                      ? `MCP OK · ${(res.tools || []).length} tool(s) from ${res.serverCount || 0} server(s)`
                                      : `MCP test failed: ${res.error || 'unknown'}`
                                  );
                                })
                                .catch((err) => {
                                  setMcpTestResult({
                                    ok: false,
                                    tools: [],
                                    error: (err as Error).message,
                                  });
                                })
                                .finally(() => setIsTestingMcp(false));
                            }}
                          >
                            {isTestingMcp
                              ? t('settings.mcp.testing')
                              : t('settings.mcp.test')}
                          </button>
                        </div>
                        {mcpTestResult && (
                          <div style={{ marginTop: 12 }}>
                            <div className="settings-label" style={{ marginBottom: 6 }}>
                              {t('settings.mcp.liveTools')}{' '}
                              <span className={`badge ${mcpTestResult.ok ? 'success' : 'danger'}`}>
                                {mcpTestResult.ok
                                  ? t('common.connected')
                                  : t('common.failed')}
                              </span>
                            </div>
                            {mcpTestResult.error && (
                              <div style={{ fontSize: 11.5, color: '#fbbf24', marginBottom: 6 }}>
                                {mcpTestResult.error}
                              </div>
                            )}
                            {(mcpTestResult.tools || []).length === 0 ? (
                              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                                {t('settings.mcp.noTools')}
                              </div>
                            ) : (
                              <div style={{ maxHeight: 220, overflow: 'auto' }}>
                                {mcpTestResult.tools.map((mcpTool) => {
                                  const disabledSet = new Set(
                                    (ideSettings.mcpServers || []).flatMap(
                                      (s: any) => s.disabledTools || []
                                    )
                                  );
                                  const isDisabled = disabledSet.has(mcpTool.qualifiedName);
                                  return (
                                    <div
                                      key={mcpTool.qualifiedName}
                                      style={{
                                        fontSize: 11.5,
                                        padding: '4px 0',
                                        borderBottom: '1px solid var(--border)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        gap: 8,
                                        alignItems: 'center',
                                        opacity: isDisabled ? 0.55 : 1,
                                      }}
                                    >
                                      <div>
                                        <code>{mcpTool.qualifiedName}</code>
                                        <span
                                          style={{ color: 'var(--text-secondary)', marginLeft: 8 }}
                                        >
                                          {mcpTool.description || mcpTool.serverName || ''}
                                        </span>
                                      </div>
                                      <button
                                        className="btn"
                                        style={{ padding: '1px 7px', fontSize: 10.5 }}
                                        onClick={() => {
                                          const idMatch = /^mcp__([^_]+)__/.exec(
                                            mcpTool.qualifiedName
                                          );
                                          const ownerId = idMatch?.[1];
                                          const next = (ideSettings.mcpServers ?? []).map(
                                            (s: any) => {
                                              const owns =
                                                (ownerId && s.id === ownerId) ||
                                                s.name === mcpTool.serverName ||
                                                (ideSettings.mcpServers || []).length === 1;
                                              if (!owns) return s;
                                              const cur = new Set<string>(s.disabledTools || []);
                                              if (cur.has(mcpTool.qualifiedName)) {
                                                cur.delete(mcpTool.qualifiedName);
                                              } else {
                                                cur.add(mcpTool.qualifiedName);
                                              }
                                              return { ...s, disabledTools: [...cur] };
                                            }
                                          );
                                          void persistIdeSettings({
                                            ...ideSettings,
                                            mcpServers: next,
                                          });
                                        }}
                                      >
                                        {isDisabled
                                          ? t('settings.mcp.enableTool')
                                          : t('settings.mcp.disableTool')}
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {settingsCategory === 'extensions' && (
                    <div>
                      <div className="settings-section-title">{t('settings.ext.title')}</div>
                      <div className="settings-section-desc">
                        {extensionsCatalog?.policyNote}
                      </div>

                      <div className="settings-card">
                        <div className="settings-label" style={{ marginBottom: 8 }}>
                          {t('settings.ext.manual')}
                        </div>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <input
                            className="settings-input"
                            value={vsixFileName}
                            onChange={(e) => setVsixFileName(e.target.value)}
                          />
                          <label style={{ display: 'flex', gap: 6, fontSize: 12 }}>
                            <input
                              type="checkbox"
                              checked={vsixConfirmed}
                              onChange={(e) => setVsixConfirmed(e.target.checked)}
                            />
                            {t('settings.ext.license')}
                          </label>
                          <button
                            className="btn primary"
                            onClick={async () => {
                              const res = await fetch('/api/extensions/install-vsix', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  vsixFileName,
                                  userConfirmedLicense: vsixConfirmed,
                                }),
                              }).then((r) => r.json());
                              setStatusNotice(res.message || res.error);
                            }}
                          >
                            {t('settings.ext.install')}
                          </button>
                        </div>
                      </div>

                      <div className="settings-card">
                        {(extensionsCatalog?.extensions ?? []).map((ext: any) => (
                          <div key={ext.id} className="settings-row">
                            <div>
                              <div className="settings-label">
                                {ext.displayName}{' '}
                                <span className="badge">{ext.id}</span>{' '}
                                <span
                                  className={`badge ${
                                    ext.openVsxAvailable ? 'success' : 'warning'
                                  }`}
                                >
                                  {ext.openVsxAvailable
                                    ? t('settings.ext.verified')
                                    : t('settings.ext.restricted')}
                                </span>
                              </div>
                              <div className="settings-sublabel">{ext.notes}</div>
                            </div>
                            {ext.openVsxAvailable ? (
                              <button
                                className={`btn ${ext.installed ? '' : 'primary'}`}
                                onClick={async () => {
                                  await fetch('/api/extensions/install-openvsx', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ extensionId: ext.id }),
                                  });
                                  const updated = await fetch('/api/extensions').then((r) =>
                                    r.json()
                                  );
                                  setExtensionsCatalog(updated);
                                  setStatusNotice(`Installed ${ext.id}`);
                                }}
                              >
                                {ext.installed
                                  ? t('settings.ext.installed')
                                  : t('settings.ext.installOpenVsx')}
                              </button>
                            ) : (
                              <span className="badge warning">{t('settings.ext.useAlt')}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
  );
}
