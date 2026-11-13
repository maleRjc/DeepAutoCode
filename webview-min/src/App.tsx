import React from 'react';
import {
  apiGet,
  apiPost,
  bridge,
  cancelSession,
  connectEvents,
  readFile,
  saveFile,
  type BridgeEvent,
  type FileNode,
  type WorkspaceInfo,
} from './api';
import { LOCALES, createTranslator, detectLocale, type Locale, type Translate } from './i18n';
import { ChatMessage as ChatMessageView, ToolCallCard, toolIcon } from './ChatMessage';

type AgentState = 'idle' | 'running' | 'error';
type Theme = 'dark' | 'light';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  timestamp: string;
}

interface ToolCall {
  toolCallId: string;
  toolName: string;
  status: string;
  args?: unknown;
  result?: unknown;
  error?: string;
}

interface Approval {
  approvalId: string;
  toolName: string;
  summary: string;
  risk: string;
  targetPath?: string;
  command?: string;
}

interface DiffRecord {
  diffId: string;
  filePath: string;
  operation: string;
  unifiedDiff: string;
  status: string;
}

interface OpenTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
}

interface ProviderInfo {
  providerId: string;
  displayName: string;
  apiEndpoint: string;
  defaultModelId: string;
  models: Array<{ modelId: string; displayName?: string }>;
}

let localSeq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now()}_${++localSeq}`;

const CUSTOM_MODEL = '__custom__';

function DiffText({ diff }: { diff: DiffRecord }) {
  return (
    <pre className="diff-body">
      {diff.unifiedDiff.split(/\r?\n/).map((line, index) => {
        const cls = line.startsWith('+')
          ? 'diff-add'
          : line.startsWith('-')
            ? 'diff-del'
            : line.startsWith('@@')
              ? 'diff-hunk'
              : 'diff-ctx';
        return (
          <div key={index} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function TreeNode({
  node,
  depth,
  onOpen,
  onRename,
  onDelete,
}: {
  node: FileNode;
  depth: number;
  onOpen: (path: string) => void;
  onRename?: (path: string) => void;
  onDelete?: (path: string) => void;
}) {
  const [open, setOpen] = React.useState(depth === 0);
  if (node.type === 'directory') {
    return (
      <div>
        <div className="tree-line">
          <button className="tree-row" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => setOpen((v) => !v)}>
            <span className="tree-caret">{open ? '▾' : '▸'}</span>
            <span className="tree-icon">📁</span>
            <span className="tree-name">{node.name}</span>
          </button>
          {onDelete && (
            <span className="tree-actions">
              <button title="delete" onClick={() => onDelete(node.path)}>✕</button>
            </span>
          )}
        </div>
        {open &&
          (node.children ?? []).map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
      </div>
    );
  }
  const ext = (node.name.split('.').pop() || '').toLowerCase();
  const icon = /^(ts|tsx)$/.test(ext)
    ? '🟦'
    : /^(js|jsx|mjs|cjs)$/.test(ext)
      ? '🟨'
      : ext === 'json'
        ? '🟨'
        : /^(md|txt)$/.test(ext)
          ? '📝'
          : /^(css|scss|less)$/.test(ext)
            ? '🎨'
            : /^(html|htm)$/.test(ext)
              ? '🌐'
              : /^(png|jpg|jpeg|gif|svg|ico)$/.test(ext)
                ? '🖼'
                : /^(py)$/.test(ext)
                  ? '🐍'
                  : '📄';
  return (
    <div className="tree-line">
      <button className="tree-row file" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onOpen(node.path)}>
        <span className="tree-caret">·</span>
        <span className="tree-icon">{icon}</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {(onRename || onDelete) && (
        <span className="tree-actions">
          {onRename && <button title="rename" onClick={() => onRename(node.path)}>✎</button>}
          {onDelete && <button title="delete" onClick={() => onDelete(node.path)}>✕</button>}
        </span>
      )}
    </div>
  );
}

export default function App() {
  const [socketState, setSocketState] = React.useState<'connecting' | 'open' | 'closed'>('connecting');
  const [workspace, setWorkspace] = React.useState<WorkspaceInfo>({
    workspaceRoot: '',
    workspaceName: '',
    tree: [],
    files: [],
  });
  const [remote, setRemote] = React.useState(false);
  const [sshOpen, setSshOpen] = React.useState(false);
  const [sshBusy, setSshBusy] = React.useState(false);
  const [sshMsg, setSshMsg] = React.useState('');
  const [sshProfiles, setSshProfiles] = React.useState<any[]>([]);
  const [sshForm, setSshForm] = React.useState({
    name: '',
    host: '',
    port: '22',
    username: 'root',
    authMethod: 'password' as 'password' | 'identity-file' | 'agent-or-default-key',
    password: '',
    identityFile: '',
    remotePath: '~',
  });
  const [tabs, setTabs] = React.useState<OpenTab[]>([]);
  const [activePath, setActivePath] = React.useState('');
  const [sessionId, setSessionId] = React.useState('');
  const [agentState, setAgentState] = React.useState<AgentState>('idle');
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [streamText, setStreamText] = React.useState('');
  const [streamThinking, setStreamThinking] = React.useState('');
  const [toolCalls, setToolCalls] = React.useState<ToolCall[]>([]);
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [diffs, setDiffs] = React.useState<DiffRecord[]>([]);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsBusy, setSettingsBusy] = React.useState(false);
  const [settingsMsg, setSettingsMsg] = React.useState('');
  const [aboutOpen, setAboutOpen] = React.useState(false);
  const [openMenu, setOpenMenu] = React.useState<'file' | 'view' | 'help' | null>(null);
  const [providers, setProviders] = React.useState<ProviderInfo[]>([]);
  const [activeProviderId, setActiveProviderId] = React.useState('');
  const [providerHasKey, setProviderHasKey] = React.useState(false);
  const [endpoint, setEndpoint] = React.useState('');
  const [model, setModel] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [locale, setLocale] = React.useState<Locale>(() => detectLocale());
  const [theme, setTheme] = React.useState<Theme>(() => {
    const saved = localStorage.getItem('dac.theme');
    return saved === 'light' ? 'light' : 'dark';
  });
  const [notice, setNotice] = React.useState('');
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [stage, setStage] = React.useState<'idle' | 'starting' | 'waiting' | 'tool' | 'writing'>('idle');
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [leftTab, setLeftTab] = React.useState<'files' | 'sessions'>('files');
  const [rightOpen, setRightOpen] = React.useState(true);
  const [usage, setUsage] = React.useState<{
    tokensUsed: number;
    tokenBudget: number;
    cacheReadTokens: number;
  } | null>(null);
  const [attachedImages, setAttachedImages] = React.useState<
    Array<{ id: string; name: string; dataUrl: string; mimeType: string }>
  >([]);
  const [mention, setMention] = React.useState<{ query: string; start: number } | null>(null);

  const messageEndRef = React.useRef<HTMLDivElement | null>(null);
  const sessionRef = React.useRef('');
  const tabsRef = React.useRef<OpenTab[]>([]);
  const agentRef = React.useRef<AgentState>('idle');
  const gutterRef = React.useRef<HTMLDivElement | null>(null);
  sessionRef.current = sessionId;
  tabsRef.current = tabs;
  agentRef.current = agentState;

  const t: Translate = React.useMemo(() => createTranslator(locale), [locale]);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('dac.theme', theme);
    // Keep the native window controls (title bar overlay) in sync with the UI.
    (window as any).deepAutoCodeDesktop?.setThemeOverlay?.(theme);
  }, [theme]);

  React.useEffect(() => {
    localStorage.setItem('dac.locale', locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const scrollToEnd = React.useCallback(() => {
    requestAnimationFrame(() => messageEndRef.current?.scrollIntoView({ behavior: 'smooth' }));
  }, []);

  const refreshMessages = React.useCallback(async (sid: string) => {
    if (!sid) return;
    try {
      const snapshot = await bridge<any>('session.resume', { sessionId: sid, lastSequence: 0 }, sid);
      const list: ChatMessage[] = (snapshot?.messages ?? []).map((m: any) => ({
        id: m.id,
        role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
        content: m.content ?? '',
        thinking: m.thinking,
        toolCalls: m.toolCalls,
        timestamp: m.timestamp,
      }));
      setMessages(list);
      setApprovals(snapshot?.pendingApprovals ?? []);
      setDiffs((prev) => {
        const incoming: DiffRecord[] = (snapshot?.diffs ?? []).map((d: any) => ({
          diffId: d.diffId,
          filePath: d.filePath,
          operation: d.operation,
          unifiedDiff: d.unifiedDiff ?? '',
          status: d.status,
        }));
        const map = new Map(prev.map((d) => [d.diffId, d]));
        for (const d of incoming) map.set(d.diffId, d);
        return [...map.values()];
      });
    } catch (err) {
      setMessages((prev) => [...prev, errorMessage((err as Error).message)]);
    }
  }, []);

  const loadWorkspace = React.useCallback(async () => {
    try {
      const info = await apiGet<WorkspaceInfo>('/api/workspace/files');
      setWorkspace(info);
    } catch {
      // no folder opened yet
    }
  }, []);

  const loadProviders = React.useCallback(async () => {
    try {
      const data = await bridge<any>('provider.get');
      const list: ProviderInfo[] = data?.providers ?? [];
      setProviders(list);
      const active = data?.active;
      if (active?.provider) {
        setActiveProviderId(active.provider.providerId);
        setProviderHasKey(Boolean(active.hasApiKeyConfigured));
        setEndpoint(active.provider.apiEndpoint ?? '');
        setModel(active.model?.modelId ?? active.provider.defaultModelId ?? '');
      }
    } catch {
      // ignore
    }
  }, []);

  const loadSessions = React.useCallback(async () => {
    try {
      const list = await bridge<any[]>('session.list');
      setSessions(Array.isArray(list) ? list : []);
    } catch {
      // ignore
    }
  }, []);

  React.useEffect(() => {
    void loadWorkspace();
    void loadProviders();
    void loadSessions();
    void loadSshProfiles();
    const disconnect = connectEvents((event) => handleEvent(event));
    setSocketState('open');
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (agentState !== 'running') {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [agentState]);

  React.useEffect(() => {
    if (!settingsOpen || !activeProviderId || activeProviderId === 'deepseek') return;
    if (!endpoint || settingsBusy || fetchedModels.length > 0) return;
    void handleFetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, activeProviderId, endpoint]);

  React.useEffect(() => {
    scrollToEnd();
  }, [messages, streamText, scrollToEnd]);

  function errorMessage(text: string): ChatMessage {
    return { id: nextId('err'), role: 'error', content: text, timestamp: new Date().toISOString() };
  }

  function handleEvent(event: BridgeEvent) {
    const sid = event.sessionId;
    const payload = event.payload ?? {};
    if (sid && sessionRef.current && sid !== sessionRef.current) {
      if (event.type !== 'approval.requested' && event.type !== 'diff.proposed') return;
    }

    switch (event.type) {
      case 'assistant.thinking.delta':
        setStage('writing');
        setStreamThinking((prev) => prev + String(payload.delta ?? ''));
        break;
      case 'assistant.text.delta':
        setStage('writing');
        setStreamText((prev) => prev + String(payload.delta ?? ''));
        break;
      case 'assistant.text.done':
        setStreamText('');
        setStreamThinking('');
        setToolCalls([]);
        setAgentState('idle');
        setStage('idle');
        setBusy(false);
        void refreshMessages(sid || sessionRef.current);
        void loadWorkspace();
        void loadSessions();
        void refreshOpenTabs();
        break;
      case 'session.state.changed': {
        const status = String(payload.status ?? '');
        if (status === 'running') {
          setAgentState('running');
          setStage((prev) => (prev === 'idle' || prev === 'starting' ? 'waiting' : prev));
          setBusy(true);
        } else if (status === 'error') {
          setAgentState('error');
          setStage('idle');
          setBusy(false);
        } else {
          setAgentState('idle');
          setStage('idle');
          setBusy(false);
        }
        break;
      }
      case 'goal_usage':
      case 'goal.usage': {
        setUsage({
          tokensUsed: Number(payload.tokensUsed ?? 0),
          tokenBudget: Number(payload.tokenBudget ?? 0),
          cacheReadTokens: Number(payload.cacheReadTokens ?? 0),
        });
        break;
      }
      case 'tool.call.started': {
        setStage('tool');
        const call = payload as unknown as ToolCall;
        setToolCalls((prev) => [...prev.filter((c) => c.toolCallId !== call.toolCallId), call]);
        break;
      }
      case 'tool.call.completed':
      case 'tool.call.failed': {
        const call = payload as unknown as ToolCall;
        setToolCalls((prev) => {
          const exists = prev.some((c) => c.toolCallId === call.toolCallId);
          return exists
            ? prev.map((c) => (c.toolCallId === call.toolCallId ? { ...c, ...call } : c))
            : [...prev, call];
        });
        break;
      }
      case 'runtime.error': {
        const text = String(payload.message ?? 'unknown error');
        setMessages((prev) => [...prev, errorMessage(text)]);
        setAgentState('error');
        setBusy(false);
        setStreamText('');
        setStreamThinking('');
        break;
      }
      case 'approval.requested':
        setApprovals((prev) => [
          ...prev.filter((a) => a.approvalId !== payload.approvalId),
          payload as unknown as Approval,
        ]);
        break;
      case 'approval.resolved':
        setApprovals((prev) => prev.filter((a) => a.approvalId !== payload.approvalId));
        break;
      case 'diff.proposed':
      case 'diff.updated': {
        const diff = payload as unknown as DiffRecord;
        setDiffs((prev) => {
          const exists = prev.some((d) => d.diffId === diff.diffId);
          return exists
            ? prev.map((d) => (d.diffId === diff.diffId ? { ...d, ...diff } : d))
            : [diff, ...prev];
        });
        break;
      }
      default:
        break;
    }
  }

  async function refreshOpenTabs() {
    const candidates = tabsRef.current.filter((tab) => tab.content === tab.savedContent);
    for (const tab of candidates) {
      try {
        const content = await readFile(tab.path);
        setTabs((prev) =>
          prev.map((t0) =>
            t0.path === tab.path && t0.content === t0.savedContent
              ? { ...t0, content, savedContent: content }
              : t0
          )
        );
      } catch {
        // file may have been deleted by the agent
      }
    }
  }

  async function ensureSession(title: string): Promise<string> {
    if (sessionRef.current) return sessionRef.current;
    const created = await bridge<any>('session.create', {
      title: title.slice(0, 40),
      workspaceRoot: workspace.workspaceRoot || undefined,
      executionMode: 'auto',
    });
    const sid = String(created?.sessionId ?? '');
    setSessionId(sid);
    sessionRef.current = sid;
    return sid;
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || busy) return;
    if (!workspace.workspaceRoot) {
      setNotice(t('notice.noWorkspace'));
      return;
    }
    setInput('');
    setNotice('');
    setMessages((prev) => [
      ...prev,
      { id: nextId('u'), role: 'user', content: text, timestamp: new Date().toISOString() },
    ]);
    setStreamText('');
    setStreamThinking('');
    setToolCalls([]);
    setBusy(true);
    setAgentState('running');
    setStage('starting');

    try {
      const sid = await ensureSession(text);
      const imagesToSend = attachedImages.map((img) => ({
        name: img.name,
        dataUrl: img.dataUrl,
        mimeType: img.mimeType,
      }));
      setAttachedImages([]);
      setMention(null);
      await bridge('session.send', {
        sessionId: sid,
        prompt: text,
        workspaceRoot: workspace.workspaceRoot || undefined,
        executionMode: 'auto',
        images: imagesToSend.length > 0 ? imagesToSend : undefined,
      }, sid);
    } catch (err) {
      setMessages((prev) => [...prev, errorMessage((err as Error).message)]);
      setAgentState('error');
      setBusy(false);
    }
  }

  async function handleStop() {
    if (!sessionRef.current) return;
    await cancelSession(sessionRef.current);
    setAgentState('idle');
    setBusy(false);
  }

  async function handleNewSession() {
    if (busy) return;
    setSessionId('');
    sessionRef.current = '';
    setMessages([]);
    setStreamText('');
    setStreamThinking('');
    setToolCalls([]);
    setApprovals([]);
    setDiffs([]);
    setAgentState('idle');
    setUsage(null);
    setAttachedImages([]);
    setMention(null);
    setNotice(t('notice.newSession'));
  }

  async function handleSelectSession(id: string) {
    if (busy || !id) return;
    setSessionId(id);
    sessionRef.current = id;
    setStreamText('');
    setStreamThinking('');
    setToolCalls([]);
    setApprovals([]);
    setUsage(null);
    setAgentState('idle');
    await refreshMessages(id);
  }

  async function handleModelChange(nextModel: string) {
    if (!nextModel || nextModel === model) return;
    try {
      await bridge('provider.update', {
        providerId: activeProviderId,
        apiEndpoint: endpoint,
        modelId: nextModel,
      });
      setModel(nextModel);
      await loadProviders();
      await handleNewSession();
      setNotice(t('chat.modelChanged', { model: nextModel }));
    } catch (err) {
      setNotice(t('settings.saveFailed', { msg: (err as Error).message }));
    }
  }

  function handlePaste(event: React.ClipboardEvent) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      setAttachedImages((prev) => [
        ...prev.slice(-3),
        {
          id: `img_${Date.now()}`,
          name: file.name || 'pasted.png',
          dataUrl: String(reader.result || ''),
          mimeType: file.type || 'image/png',
        },
      ]);
    };
    reader.readAsDataURL(file);
  }

  function handleInputChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setInput(value);
    const caret = event.target.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const match = /@([^\s@]*)$/.exec(before);
    if (match) setMention({ query: match[1], start: caret - match[0].length });
    else setMention(null);
  }

  function applyMention(path: string) {
    if (!mention) return;
    const token = `@${mention.query}`;
    const next = `${input.slice(0, mention.start)}@${path} ${input.slice(mention.start + token.length)}`;
    setInput(next);
    setMention(null);
  }

  async function handleAnswerApproval(approvalId: string, approved: boolean) {
    try {
      await bridge('approval.respond', {
        approvalId,
        approved,
        reason: approved ? 'allowed in IDE' : 'rejected in IDE',
      });
      setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
    } catch (err) {
      setNotice(t('notice.approvalFailed', { msg: (err as Error).message }));
    }
  }

  async function handleDiffAction(diff: DiffRecord, action: 'accept' | 'reject') {
    try {
      await bridge('diff.review', {
        sessionId: sessionRef.current,
        diffId: diff.diffId,
        action,
      }, sessionRef.current);
      setDiffs((prev) =>
        prev.map((d) =>
          d.diffId === diff.diffId ? { ...d, status: action === 'accept' ? 'accepted' : 'rejected' } : d
        )
      );
      if (action === 'accept') {
        await openFile(diff.filePath, true);
      }
    } catch (err) {
      setNotice(t('notice.diffFailed', { msg: (err as Error).message }));
    }
  }

  async function openFile(path: string, force = false) {
    const existing = tabs.find((t0) => t0.path === path);
    if (existing && !force) {
      setActivePath(path);
      return;
    }
    try {
      const content = await readFile(path);
      setTabs((prev) => {
        const found = prev.find((t0) => t0.path === path);
        if (found) return prev.map((t0) => (t0.path === path ? { ...t0, content, savedContent: content } : t0));
        return [...prev, { path, name: path.split('/').pop() || path, content, savedContent: content }];
      });
      setActivePath(path);
    } catch (err) {
      setNotice(t('notice.readFailed', { msg: (err as Error).message }));
    }
  }

  async function handleSave() {
    const tab = tabs.find((t0) => t0.path === activePath);
    if (!tab) return;
    try {
      await saveFile(tab.path, tab.content);
      setTabs((prev) => prev.map((t0) => (t0.path === tab.path ? { ...t0, savedContent: t0.content } : t0)));
      setNotice(t('notice.savedFile', { path: tab.path }));
    } catch (err) {
      setNotice(t('notice.saveFailed', { msg: (err as Error).message }));
    }
  }

  function handleCloseTab() {
    if (!activePath) return;
    setTabs((prev) => prev.filter((t0) => t0.path !== activePath));
    setActivePath('');
  }

  async function handleOpenFolder() {
    try {
      const desktop = (window as any).deepAutoCodeDesktop;
      let folder: string | null = null;
      if (desktop?.openFolderDialog) {
        folder = await desktop.openFolderDialog();
      } else {
        folder = window.prompt('Project folder (absolute path)', workspace.workspaceRoot || '');
      }
      if (!folder) return;
      const res = await apiPost<any>('/api/workspace/switch', { folderPath: folder });
      if (!res?.ok) throw new Error(res?.error || 'open folder failed');
      setWorkspace({
        workspaceRoot: res.workspaceRoot,
        workspaceName: (res.workspaceRoot || '').split(/[\\/]/).pop() || '',
        tree: res.tree ?? [],
        files: res.files ?? [],
      });
      setRemote(false);
      setTabs([]);
      setActivePath('');
      await handleNewSession();
      setNotice(t('notice.opened', { path: res.workspaceRoot }));
    } catch (err) {
      setNotice(t('notice.openFailed', { msg: (err as Error).message }));
    }
  }

  async function loadSshProfiles() {
    try {
      const data = await apiGet<any>('/api/ssh/profiles');
      setSshProfiles(Array.isArray(data?.profiles) ? data.profiles : []);
    } catch {
      setSshProfiles([]);
    }
  }

  async function handleTestSsh() {
    if (!sshForm.host.trim()) {
      setSshMsg(t('ssh.needHost'));
      return;
    }
    setSshBusy(true);
    setSshMsg(t('ssh.testing'));
    try {
      const res = await apiPost<any>('/api/ssh/test', {
        ...sshForm,
        port: Number(sshForm.port) || 22,
      });
      setSshMsg(
        res?.ok
          ? `${t('ssh.ok')} · ${res.latencyMs ?? '?'}ms${res.remoteOsInfo ? ' · ' + res.remoteOsInfo : ''}`
          : t('ssh.fail', { msg: res?.message || res?.error || 'unknown' })
      );
    } catch (err) {
      setSshMsg(t('ssh.fail', { msg: (err as Error).message }));
    } finally {
      setSshBusy(false);
    }
  }

  async function handleConnectSsh() {
    if (!sshForm.host.trim()) {
      setSshMsg(t('ssh.needHost'));
      return;
    }
    setSshBusy(true);
    setSshMsg(t('ssh.connecting'));
    try {
      const res = await apiPost<any>('/api/ssh/connect', {
        ...sshForm,
        port: Number(sshForm.port) || 22,
      });
      if (!res?.ok) throw new Error(res?.error || res?.message || 'connect failed');
      setWorkspace({
        workspaceRoot: res.workspaceRoot,
        workspaceName: res.workspaceName || res.workspaceRoot,
        tree: res.tree ?? [],
        files: res.files ?? [],
      });
      setRemote(true);
      setTabs([]);
      setActivePath('');
      setSshOpen(false);
      await handleNewSession();
      setNotice(t('notice.connectSsh'));
      await loadSshProfiles();
    } catch (err) {
      setSshMsg(t('ssh.fail', { msg: (err as Error).message }));
    } finally {
      setSshBusy(false);
    }
  }

  async function refreshTree() {
    await loadWorkspace();
  }

  async function handleCreateEntry(kind: 'file' | 'directory') {
    const raw = window.prompt(kind === 'file' ? t('tree.newFilePrompt') : t('tree.newFolderPrompt'), '');
    if (!raw) return;
    const targetPath = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    try {
      const res = await apiPost<any>('/api/workspace/create', {
        targetPath,
        kind,
        content: '',
      });
      if (!res?.ok) throw new Error(res?.error || 'create failed');
      await refreshTree();
      setNotice(t('notice.created', { path: targetPath }));
      if (kind === 'file') await openFile(targetPath, true);
    } catch (err) {
      setNotice(t('notice.actionFailed', { msg: (err as Error).message }));
    }
  }

  async function handleDeleteEntry(path: string) {
    if (!window.confirm(t('tree.deleteConfirm', { path }))) return;
    try {
      const res = await apiPost<any>('/api/workspace/delete', { targetPath: path });
      if (!res?.ok) throw new Error(res?.error || 'delete failed');
      setTabs((prev) => prev.filter((t0) => t0.path !== path));
      if (activePath === path) setActivePath('');
      await refreshTree();
      setNotice(t('notice.deleted', { path }));
    } catch (err) {
      setNotice(t('notice.actionFailed', { msg: (err as Error).message }));
    }
  }

  async function handleRenameEntry(path: string) {
    const next = window.prompt(t('tree.renamePrompt'), path);
    if (!next || next === path) return;
    try {
      const content = await readFile(path);
      const created = await apiPost<any>('/api/workspace/create', {
        targetPath: next,
        kind: 'file',
        content,
      });
      if (!created?.ok) throw new Error(created?.error || 'rename failed');
      const removed = await apiPost<any>('/api/workspace/delete', { targetPath: path });
      if (!removed?.ok) throw new Error(removed?.error || 'rename failed');
      setTabs((prev) =>
        prev.map((t0) => (t0.path === path ? { ...t0, path: next, name: next.split('/').pop() || next } : t0))
      );
      if (activePath === path) setActivePath(next);
      await refreshTree();
      setNotice(t('notice.renamed', { path: next }));
    } catch (err) {
      setNotice(t('notice.actionFailed', { msg: (err as Error).message }));
    }
  }

  async function saveProviderConfig(): Promise<void> {
    await bridge('provider.update', {
      providerId: activeProviderId,
      apiEndpoint: endpoint,
      modelId: model,
      apiKey: apiKey.trim() || undefined,
    });
    setApiKey('');
    await loadProviders();
  }

  async function handleSaveProvider() {
    setSettingsBusy(true);
    setSettingsMsg('');
    try {
      await saveProviderConfig();
      setSettingsMsg(t('settings.saved'));
      setNotice(t('settings.saved'));
    } catch (err) {
      const message = t('settings.saveFailed', { msg: (err as Error).message });
      setSettingsMsg(message);
      setNotice(message);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleFetchModels() {
    setSettingsBusy(true);
    setSettingsMsg(t('settings.fetching'));
    try {
      const res = await apiPost<any>('/api/providers/models', {
        providerId: activeProviderId,
        apiEndpoint: endpoint,
        apiKey: apiKey.trim() || undefined,
      });
      if (!res?.ok) {
        setSettingsMsg(t('settings.fetchFail', { msg: res?.error || 'unknown' }));
        return;
      }
      setFetchedModels(res.models);
      setSettingsMsg(
        t('settings.fetchOk', {
          count: res.models.length,
          relay: res.relayed ? t('settings.fetchRelay') : '',
        })
      );
      if (res.models.length > 0 && (!model || !res.models.includes(model))) {
        setModel(res.models[0]);
      }
    } catch (err) {
      setSettingsMsg(t('settings.fetchFail', { msg: (err as Error).message }));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleTestProvider() {
    setSettingsBusy(true);
    setSettingsMsg(t('settings.testing'));
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(t('settings.testTimeout'))), 20000);
    });
    try {
      // Persist the form first: the tester runs against the saved provider
      // configuration, so an unsaved custom endpoint/model would test the old one.
      await saveProviderConfig();
      const res = await Promise.race([
        bridge<any>('provider.test', { providerId: activeProviderId, modelId: model }),
        timeout,
      ]);
      setSettingsMsg(
        res?.ok
          ? t('settings.testOk', { ms: res.latencyMs ?? '?' })
          : t('settings.testFail', { msg: res?.diagnostic?.userMessage ?? res?.error?.message ?? 'unknown' })
      );
    } catch (err) {
      setSettingsMsg(t('settings.testFail', { msg: (err as Error).message }));
    } finally {
      setSettingsBusy(false);
    }
  }

  const activeTab = tabs.find((t0) => t0.path === activePath) || null;
  const dirty = activeTab ? activeTab.content !== activeTab.savedContent : false;
  const activeProvider = providers.find((p) => p.providerId === activeProviderId);
  const statusText =
    agentState === 'running' ? t('chat.running') : agentState === 'error' ? t('chat.error') : t('chat.idle');
  const [fetchedModels, setFetchedModels] = React.useState<string[]>([]);
  const modelIds = React.useMemo(() => {
    const base = (activeProvider?.models ?? []).map((m) => m.modelId);
    return Array.from(new Set([...base, ...fetchedModels]));
  }, [activeProvider, fetchedModels]);
  const modelIsCustom = Boolean(model) && !modelIds.includes(model);
  const mentionOptions = React.useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return workspace.files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  }, [mention, workspace.files]);
  const langLabel = LOCALES.find((l) => l.id === locale)?.label ?? locale;

  function closeMenus() {
    setOpenMenu(null);
  }

  return (
    <div className="app" onClick={() => (openMenu ? closeMenus() : undefined)}>
      <header className="topbar">
        <span className="brand">{t('app.title')}</span>

        <div className="menubar">
          <div className="menu-wrap">
            <button
              className={`menu-btn ${openMenu === 'file' ? 'open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenu(openMenu === 'file' ? null : 'file');
              }}
            >
              {t('menu.file')}
            </button>
            {openMenu === 'file' && (
              <div className="menu-pop" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => { closeMenus(); void handleOpenFolder(); }}>{t('menu.openFolder')}</button>
                <button disabled={!activeTab} onClick={() => { closeMenus(); void handleSave(); }}>
                  {t('menu.save')}
                </button>
                <button disabled={!activeTab} onClick={() => { closeMenus(); handleCloseTab(); }}>
                  {t('menu.closeTab')}
                </button>
                <div className="sep" />
                <button onClick={() => { closeMenus(); void handleNewSession(); }}>{t('menu.newSession')}</button>
                <button onClick={() => { closeMenus(); setSettingsOpen(true); }}>{t('menu.settings')}</button>
              </div>
            )}
          </div>

          <div className="menu-wrap">
            <button
              className={`menu-btn ${openMenu === 'view' ? 'open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenu(openMenu === 'view' ? null : 'view');
              }}
            >
              {t('menu.view')}
            </button>
            {openMenu === 'view' && (
              <div className="menu-pop" onClick={(e) => e.stopPropagation()}>
                <div className="group">{t('menu.theme')}</div>
                <button onClick={() => { setTheme('dark'); closeMenus(); }}>
                  {t('menu.theme.dark')}
                  {theme === 'dark' && <span className="check">✓</span>}
                </button>
                <button onClick={() => { setTheme('light'); closeMenus(); }}>
                  {t('menu.theme.light')}
                  {theme === 'light' && <span className="check">✓</span>}
                </button>
                <div className="sep" />
                <div className="group">{t('menu.language')}</div>
                {LOCALES.map((item) => (
                  <button key={item.id} onClick={() => { setLocale(item.id); closeMenus(); }}>
                    {item.label}
                    {locale === item.id && <span className="check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="menu-wrap">
            <button
              className={`menu-btn ${openMenu === 'help' ? 'open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenu(openMenu === 'help' ? null : 'help');
              }}
            >
              {t('menu.help')}
            </button>
            {openMenu === 'help' && (
              <div className="menu-pop" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => { closeMenus(); setAboutOpen(true); }}>{t('menu.about')}</button>
              </div>
            )}
          </div>
        </div>

        <button className="btn small" onClick={() => void handleOpenFolder()}>{t('top.openFolder')}</button>
        <span className="ws-path" title={workspace.workspaceRoot}>
          {workspace.workspaceRoot || t('top.noProject')}
        </span>
        <span className="spacer" />
        <select
          className="top-select"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          title={t('menu.language')}
        >
          {LOCALES.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        <button
          className="top-toggle"
          title={`${t('menu.theme')}: ${theme === 'dark' ? t('menu.theme.dark') : t('menu.theme.light')}`}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
        <button className="btn" onClick={() => void handleNewSession()}>{t('top.newSession')}</button>
        <button className="btn" onClick={() => setSettingsOpen(true)}>{t('top.settings')}</button>
      </header>

      {!workspace.workspaceRoot && (
        <div className="welcome">
          <div className="welcome-card">
            <h1>{t('welcome.title')}</h1>
            <p>{t('welcome.sub')}</p>
            <div className="welcome-actions">
              <button className="welcome-tile" onClick={() => void handleOpenFolder()}>
                <span className="welcome-icon">📂</span>
                <b>{t('welcome.open')}</b>
                <span className="hint">{t('welcome.open.desc')}</span>
              </button>
              <button className="welcome-tile" onClick={() => { void loadSshProfiles(); setSshOpen(true); }}>
                <span className="welcome-icon">🖥</span>
                <b>{t('welcome.ssh')}</b>
                <span className="hint">{t('welcome.ssh.desc')}</span>
              </button>
            </div>
            <div className="welcome-recent">
              <div className="group">{t('welcome.recent')}</div>
              {sshProfiles.length === 0 && <div className="hint">{t('welcome.none')}</div>}
              {sshProfiles.slice(0, 5).map((p) => (
                <button
                  key={p.id || `${p.username}@${p.host}`}
                  className="recent-row"
                  onClick={() => {
                    setSshForm({
                      name: p.name || '',
                      host: p.host || '',
                      port: String(p.port ?? 22),
                      username: p.username || 'root',
                      authMethod: p.authMethod || 'password',
                      password: '',
                      identityFile: p.identityFile || '',
                      remotePath: p.remotePath || '~',
                    });
                    setSshOpen(true);
                  }}
                >
                  <span>🖥 {p.name || p.host}</span>
                  <span className="hint">{p.username}@{p.host}:{p.remotePath || '~'}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className={`body ${rightOpen ? 'with-right' : ''}`} style={{ display: workspace.workspaceRoot ? 'grid' : 'none' }}>
        <aside className="tree-pane">
          <div className="side-tabs">
            <button className={leftTab === 'files' ? 'active' : ''} onClick={() => setLeftTab('files')}>
              {t('tree.title')}
            </button>
            <button
              className={leftTab === 'sessions' ? 'active' : ''}
              onClick={() => {
                setLeftTab('sessions');
                void loadSessions();
              }}
            >
              {t('sessions.title')}
            </button>
          </div>

          {leftTab === 'files' ? (
            <>
          <div className="pane-title tree-head">
            <span>{remote ? `${t('tree.title')} · ${t('status.remote')}` : t('tree.title')}</span>
            {!remote && (
              <span className="tree-head-actions">
                <button title={t('tree.newFile')} onClick={() => void handleCreateEntry('file')}>＋</button>
                <button title={t('tree.newFolder')} onClick={() => void handleCreateEntry('directory')}>⊞</button>
                <button title={t('tree.refresh')} onClick={() => void refreshTree()}>⟳</button>
              </span>
            )}
          </div>
          <div className="tree-scroll">
            {workspace.tree.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                onOpen={openFile}
                onRename={remote ? undefined : handleRenameEntry}
                onDelete={remote ? undefined : handleDeleteEntry}
              />
            ))}
            {workspace.tree.length === 0 && <div className="empty">{t('tree.empty')}</div>}
          </div>
            </>
          ) : (
            <div className="sessions-list">
              {sessions.map((item) => (
                <button
                  key={item.sessionId}
                  className={`session-item ${item.sessionId === sessionId ? 'active' : ''}`}
                  onClick={() => void handleSelectSession(item.sessionId)}
                  title={item.sessionId}
                >
                  <div className="session-title">{item.title || item.sessionId}</div>
                  <div className="session-meta">
                    {item.modelId} · {new Date(item.updatedAt).toLocaleString()}
                  </div>
                </button>
              ))}
              {sessions.length === 0 && <div className="empty">{t('sessions.empty')}</div>}
            </div>
          )}
        </aside>

        <main className="editor-pane">
          <div className="tabs">
            {tabs.map((tab) => (
              <button
                key={tab.path}
                className={`tab ${tab.path === activePath ? 'active' : ''}`}
                onClick={() => setActivePath(tab.path)}
                title={tab.path}
              >
                {tab.name}
                {tab.content !== tab.savedContent && <span className="dirty">●</span>}
                <span
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTabs((prev) => prev.filter((t0) => t0.path !== tab.path));
                    if (activePath === tab.path) setActivePath('');
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
          {activeTab ? (
            <div className="editor-wrap">
              <div className="editor-body">
                <div className="gutter" ref={gutterRef}>
                  {activeTab.content.split('\n').map((_line, index) => (
                    <div key={index}>{index + 1}</div>
                  ))}
                </div>
                <textarea
                  className="editor"
                  value={activeTab.content}
                  spellCheck={false}
                  onChange={(e) => {
                    const value = e.target.value;
                    setTabs((prev) =>
                      prev.map((t0) => (t0.path === activeTab.path ? { ...t0, content: value } : t0))
                    );
                  }}
                  onScroll={(e) => {
                    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                  }}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                      e.preventDefault();
                      void handleSave();
                    }
                  }}
                />
              </div>
              <div className="editor-foot">
                <span>{activeTab.path}</span>
                <span>{dirty ? t('editor.unsaved') : t('editor.saved')}</span>
                <button className="btn small" onClick={handleSave} disabled={!dirty}>
                  {t('editor.save')}
                </button>
              </div>
            </div>
          ) : (
            <div className="empty center">{t('editor.empty')}</div>
          )}
        </main>

        <section className="chat-pane">
          <div className="chat-head">
            <span className={`status-pill ${agentState}`}>{statusText}</span>
            {stage !== 'idle' && (
              <span className="stage-chip">
                {t(`stage.${stage}`)}
                {elapsed >= 3 ? ` · ${elapsed}s` : ''}
              </span>
            )}
            <span className="chat-title">{t('chat.title')}</span>
            <span className="spacer" />
            {busy && <button className="btn small danger" onClick={handleStop}>{t('chat.stop')}</button>}
            <button className="btn small" onClick={() => setRightOpen((v) => !v)} title={t('panel.title')}>
              {rightOpen ? t('panel.hide') : t('panel.show')}
            </button>
          </div>

          <div className="messages">
            {messages.map((m) => (
              <ChatMessageView
                key={m.id}
                message={{
                  id: m.id,
                  role: m.role,
                  content: m.content,
                  thinking: m.thinking,
                  toolCalls: m.toolCalls,
                  timestamp: m.timestamp,
                }}
                t={t}
              />
            ))}

            {(streamThinking || streamText) && (
              <ChatMessageView
                streaming
                t={t}
                message={{
                  id: 'streaming',
                  role: 'assistant',
                  content: streamText,
                  thinking: streamThinking || undefined,
                  timestamp: new Date().toISOString(),
                }}
              />
            )}
            {toolCalls.map((call) => <ToolCallCard key={call.toolCallId} call={call} />)}

            {approvals.map((approval) => (
              <div className="card approval" key={approval.approvalId}>
                <div className="card-title">
                  {t('approval.title', { tool: approval.toolName, risk: approval.risk })}
                </div>
                <div className="card-body">{approval.summary}</div>
                {approval.command && <pre className="card-code">{approval.command}</pre>}
                <div className="card-actions">
                  <button className="btn primary" onClick={() => handleAnswerApproval(approval.approvalId, true)}>
                    {t('approval.allow')}
                  </button>
                  <button className="btn danger" onClick={() => handleAnswerApproval(approval.approvalId, false)}>
                    {t('approval.deny')}
                  </button>
                </div>
              </div>
            ))}

            {diffs.map((diff) => (
              <div className={`card diff ${diff.status}`} key={diff.diffId}>
                <div className="card-title">
                  {diff.operation === 'create' ? t('diff.new') : t('diff.modify')} {diff.filePath}
                  <span className="badge">{diff.status}</span>
                </div>
                <details>
                  <summary>{t('diff.view')}</summary>
                  <DiffText diff={diff} />
                </details>
                {diff.status === 'pending' && (
                  <div className="card-actions">
                    <button className="btn primary" onClick={() => handleDiffAction(diff, 'accept')}>
                      {t('diff.accept')}
                    </button>
                    <button className="btn danger" onClick={() => handleDiffAction(diff, 'reject')}>
                      {t('diff.reject')}
                    </button>
                  </div>
                )}
              </div>
            ))}

            {!busy && messages.length === 0 && !streamText && (
              <div className="empty center">
                {t('chat.empty')
                  .split('\n')
                  .map((line, index) => (
                    <React.Fragment key={index}>
                      {line}
                      <br />
                    </React.Fragment>
                  ))}
              </div>
            )}
            <div ref={messageEndRef} />
          </div>

          {notice && (
            <div className="notice">
              {notice}
              <button className="link" onClick={() => setNotice('')}>{t('notice.close')}</button>
            </div>
          )}

          <div className="composer">
            <div className="composer-box">
              {mentionOptions.length > 0 && (
                <div className="mention-pop">
                  {mentionOptions.map((file) => (
                    <button
                      key={file}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyMention(file);
                      }}
                    >
                      {file}
                    </button>
                  ))}
                </div>
              )}
              {attachedImages.length > 0 && (
                <div className="attach-row">
                  {attachedImages.map((img) => (
                    <span key={img.id} className="attach-chip">
                      <img src={img.dataUrl} alt={img.name} />
                      <span title={img.name}>{img.name}</span>
                      <button
                        onClick={() => setAttachedImages((prev) => prev.filter((item) => item.id !== img.id))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                placeholder={t('chat.placeholder')}
                rows={2}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
                }}
                onChange={handleInputChange}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setMention(null);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <div className="composer-actions">
                <select
                  className="composer-chip composer-model"
                  value={modelIds.includes(model) ? model : ''}
                  onChange={(e) => void handleModelChange(e.target.value)}
                >
                  {!modelIds.includes(model) && model && <option value="">{model}</option>}
                  {modelIds.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
                <span className="hint">
                  {busy
                    ? t('chat.sending')
                    : t('chat.enterHint') + ' · @文件 · 可粘贴图片'}
                </span>
                <span className="spacer" />
                {busy ? (
                  <button className="btn small danger" onClick={handleStop}>{t('chat.stop')}</button>
                ) : (
                  <button
                    className="btn primary send-btn"
                    onClick={() => void handleSend()}
                    disabled={!input.trim() || !workspace.workspaceRoot}
                  >
                    {t('chat.send')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        {rightOpen && (
          <aside className="right-pane">
            <div className="pane-title">{t('panel.title')}</div>

            <div className="right-section">
              <div className="right-section-title">{t('panel.context')}</div>
              {usage ? (
                <>
                  <div className="usage-row">
                    <span>{usage.tokensUsed.toLocaleString()}</span>
                    <span className="hint">/ {usage.tokenBudget.toLocaleString()}</span>
                  </div>
                  <div className="usage-bar">
                    <div
                      className="usage-fill"
                      style={{ width: `${Math.min(100, Math.round((usage.tokensUsed / Math.max(1, usage.tokenBudget)) * 100))}%` }}
                    />
                  </div>
                  <div className="hint">
                    {t('panel.cacheRead')}: {usage.cacheReadTokens.toLocaleString()}
                  </div>
                </>
              ) : (
                <div className="hint">{t('panel.noUsage')}</div>
              )}
              <div className="hint" style={{ marginTop: 6 }}>
                {activeProviderId} / {model || '—'}
              </div>
            </div>

            <div className="right-section">
              <div className="right-section-title">
                {t('panel.changes')} · {diffs.length}
              </div>
              {diffs.length === 0 && <div className="hint">{t('panel.noChanges')}</div>}
              {diffs.map((diff) => (
                <div key={diff.diffId} className="right-diff">
                  <div className="right-diff-path" title={diff.filePath}>
                    {diff.operation === 'create' ? '＋' : '✎'} {diff.filePath}
                  </div>
                  <div className="right-diff-actions">
                    <span className="badge">{diff.status}</span>
                    {diff.status === 'pending' && (
                      <>
                        <button className="link" onClick={() => void handleDiffAction(diff, 'accept')}>
                          {t('diff.accept')}
                        </button>
                        <button className="link danger" onClick={() => void handleDiffAction(diff, 'reject')}>
                          {t('diff.reject')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="right-section">
              <div className="right-section-title">
                {t('panel.tools')} · {toolCalls.length}
              </div>
              {toolCalls.length === 0 && <div className="hint">{t('panel.noTools')}</div>}
              {toolCalls
                .slice(-8)
                .reverse()
                .map((call) => (
                  <div key={call.toolCallId} className="right-tool">
                    <span>{toolIcon(call.toolName)}</span>
                    <span className="right-tool-name">{call.toolName}</span>
                    <span className={`tool-status ${call.status === 'failed' ? 'failed' : call.status === 'completed' ? 'done' : 'running'}`}>
                      {call.status}
                    </span>
                  </div>
                ))}
            </div>
          </aside>
        )}
      </div>

      <footer className="statusbar">
        <span>{remote ? `🖥 ${workspace.workspaceRoot}` : workspace.workspaceRoot || t('status.workspace')}</span>
        <span>{sessionId ? t('status.session', { id: sessionId.slice(0, 14) + '…' }) : t('status.sessionNone')}</span>
        <span className="spacer" />
        <span>{t('status.provider', { provider: activeProviderId || '—', model: model || '—' })}</span>
        <span>{t('status.ws', { state: socketState })}</span>
      </footer>

      {sshOpen && (
        <div className="modal-mask" onClick={() => !sshBusy && setSshOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>{t('ssh.title')}</b>
              <button className="btn small" onClick={() => setSshOpen(false)} disabled={sshBusy}>
                {t('ssh.cancel')}
              </button>
            </div>
            <div className="field-row">
              <div className="field">
                <label>{t('ssh.host')}</label>
                <input
                  value={sshForm.host}
                  onChange={(e) => setSshForm({ ...sshForm, host: e.target.value })}
                  placeholder="192.168.1.10"
                />
              </div>
              <div className="field narrow">
                <label>{t('ssh.port')}</label>
                <input value={sshForm.port} onChange={(e) => setSshForm({ ...sshForm, port: e.target.value })} placeholder="22" />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>{t('ssh.user')}</label>
                <input
                  value={sshForm.username}
                  onChange={(e) => setSshForm({ ...sshForm, username: e.target.value })}
                />
              </div>
              <div className="field">
                <label>{t('ssh.name')}</label>
                <input
                  value={sshForm.name}
                  onChange={(e) => setSshForm({ ...sshForm, name: e.target.value })}
                  placeholder="my-server"
                />
              </div>
            </div>
            <div className="field">
              <label>{t('ssh.auth')}</label>
              <select
                value={sshForm.authMethod}
                onChange={(e) =>
                  setSshForm({ ...sshForm, authMethod: e.target.value as typeof sshForm.authMethod })
                }
              >
                <option value="password">{t('ssh.auth.password')}</option>
                <option value="identity-file">{t('ssh.auth.key')}</option>
                <option value="agent-or-default-key">{t('ssh.auth.agent')}</option>
              </select>
            </div>
            {sshForm.authMethod === 'password' && (
              <div className="field">
                <label>{t('ssh.password')}</label>
                <input
                  type="password"
                  value={sshForm.password}
                  onChange={(e) => setSshForm({ ...sshForm, password: e.target.value })}
                />
              </div>
            )}
            {sshForm.authMethod === 'identity-file' && (
              <div className="field">
                <label>{t('ssh.keyFile')}</label>
                <input
                  value={sshForm.identityFile}
                  onChange={(e) => setSshForm({ ...sshForm, identityFile: e.target.value })}
                  placeholder="C:\\Users\\me\\.ssh\\id_rsa"
                />
              </div>
            )}
            <div className="field">
              <label>{t('ssh.remotePath')}</label>
              <input
                value={sshForm.remotePath}
                onChange={(e) => setSshForm({ ...sshForm, remotePath: e.target.value })}
                placeholder="~ 或 /home/user/project"
              />
            </div>
            {sshMsg && <div className="hint" style={{ marginBottom: 8 }}>{sshMsg}</div>}
            <div className="modal-actions">
              <button className="btn primary" onClick={() => void handleConnectSsh()} disabled={sshBusy}>
                {sshBusy ? t('ssh.connecting') : t('ssh.connect')}
              </button>
              <button className="btn" onClick={() => void handleTestSsh()} disabled={sshBusy}>
                {sshBusy ? t('ssh.testing') : t('ssh.test')}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>{t('settings.title')}</b>
              <button className="btn small" onClick={() => setSettingsOpen(false)}>{t('settings.close')}</button>
            </div>
            <div className="field">
              <label>{t('settings.provider')}</label>
              <select
                value={activeProviderId}
                onChange={(e) => {
                  const nextId2 = e.target.value;
                  setActiveProviderId(nextId2);
                  setFetchedModels([]);
                  const p = providers.find((x) => x.providerId === nextId2);
                  if (p) {
                    setEndpoint(p.apiEndpoint);
                    setModel(p.defaultModelId);
                  }
                }}
              >
                {providers.map((p) => (
                  <option key={p.providerId} value={p.providerId}>{p.displayName}</option>
                ))}
              </select>
              {activeProviderId !== 'deepseek' && (
                <div className="hint">{t('settings.gatewayHint')}</div>
              )}
            </div>
            <div className="field">
              <label>{t('settings.endpoint')}</label>
              <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.deepseek.com/v1" />
            </div>
            <div className="field">
              <label className="field-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{t('settings.model')}</span>
                <button
                  className="btn small"
                  onClick={() => void handleFetchModels()}
                  disabled={settingsBusy}
                  type="button"
                >
                  {settingsBusy ? t('settings.fetching') : t('settings.fetchModels')}
                </button>
              </label>
              <select
                value={modelIsCustom ? CUSTOM_MODEL : model}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === CUSTOM_MODEL) setModel('');
                  else setModel(value);
                }}
              >
                {modelIds.map((id) => (
                  <option key={id} value={id}>
                    {activeProvider?.models?.find((m) => m.modelId === id)?.displayName || id}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>{t('settings.model.custom')}</option>
              </select>
              {modelIsCustom && (
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-v4-flash"
                  style={{ marginTop: 6 }}
                />
              )}
            </div>
            <div className="field">
              <label>
                {t('settings.apiKey')}
                <span className="hint" style={{ marginLeft: 8 }}>
                  {providerHasKey ? t('settings.apiKey.saved') : t('settings.apiKey.empty')}
                </span>
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
              {!providerHasKey && <div className="hint">{t('settings.apiKey.homeHint')}</div>}
            </div>
            {settingsMsg && (
              <div className="settings-msg" role="status">
                {settingsMsg}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn primary" onClick={() => void handleSaveProvider()} disabled={settingsBusy}>
                {t('settings.save')}
              </button>
              <button className="btn" onClick={() => void handleTestProvider()} disabled={settingsBusy}>
                {settingsBusy ? t('settings.testing') : t('settings.test')}
              </button>
            </div>
          </div>
        </div>
      )}

      {aboutOpen && (
        <div className="modal-mask" onClick={() => setAboutOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
            <div className="modal-head">
              <b>{t('menu.about.title')}</b>
              <button className="btn small" onClick={() => setAboutOpen(false)}>{t('settings.close')}</button>
            </div>
            <p>{t('menu.about.body')}</p>
            <p className="hint">{t('menu.about.kernel')}</p>
            <p className="hint">{t('menu.about.ui')}</p>
            <p className="hint">
              {t('menu.language')}: {langLabel}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
