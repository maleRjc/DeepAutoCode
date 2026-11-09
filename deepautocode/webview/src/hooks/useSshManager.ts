import { useState } from 'react';
import type { SshFormState } from '../types/workbench';

export interface UseSshManagerOptions {
  setStatusNotice: (msg: string) => void;
  appendLog: (line: string) => void;
  setWorkspaceRoot: (root: string) => void;
  setWorkspaceName: (name: string) => void;
  setFileTree: (tree: any[]) => void;
  setExpandedDirs: (dirs: Record<string, boolean>) => void;
  setShowLeftSidebar: (show: boolean) => void;
  setShowRightAiDock: (show: boolean) => void;
  setActiveActivity: (act: 'explorer' | 'search' | 'git' | 'extensions') => void;
  setWorkspaceSectionOpen: (open: boolean) => void;
  setTabs: (tabs: any[]) => void;
  setActiveTabPath: (path: string) => void;
  openFileInTab: (path: string, activate?: boolean) => Promise<void>;
  bridge: { request: <T = any>(method: string, params?: any, sessionId?: string) => Promise<T> };
  executionMode: 'plan' | 'auto' | 'manual';
  setSessions: (sessions: any[]) => void;
  selectAndResumeSession: (sessionId: string) => Promise<void>;
  refreshGitStatus: () => Promise<void>;
}

export function useSshManager(opts: UseSshManagerOptions) {
  const [showSshModal, setShowSshModal] = useState<boolean>(false);
  const [sshStatus, setSshStatus] = useState<any>({ connected: false });
  const [sshProfiles, setSshProfiles] = useState<any[]>([]);
  const [sshQuickCmd, setSshQuickCmd] = useState<string>('');
  const [sshForm, setSshForm] = useState<SshFormState>({
    name: 'Linux Dev Server',
    host: '10.0.62.83',
    port: 22,
    username: 'root',
    authMethod: 'password',
    password: '',
    identityFile: '~/.ssh/id_rsa',
    remotePath: '/root',
  });
  const [sshTestResult, setSshTestResult] = useState<any>(null);
  const [isTestingSsh, setIsTestingSsh] = useState<boolean>(false);
  const [isConnectingSsh, setIsConnectingSsh] = useState<boolean>(false);
  const [sshBrowseData, setSshBrowseData] = useState<{
    currentDir: string;
    directories: string[];
  } | null>(null);

  async function openSshConnectionModal() {
    setShowSshModal(true);
    setSshTestResult(null);
    setSshBrowseData(null);
    try {
      const res = await fetch('/api/ssh/status').then((r) => r.json());
      if (res?.status) {
        setSshStatus(res.status);
        if (res.status.activeProfile) {
          setSshForm({
            id: res.status.activeProfile.id,
            name: res.status.activeProfile.name || '',
            host: res.status.activeProfile.host || '127.0.0.1',
            port: res.status.activeProfile.port || 22,
            username: res.status.activeProfile.username || 'root',
            authMethod: res.status.activeProfile.authMethod || 'password',
            password: res.status.activeProfile.password || '',
            identityFile: res.status.activeProfile.identityFile || '~/.ssh/id_rsa',
            remotePath: res.status.activeProfile.remotePath || '~',
          });
        }
      }
      if (Array.isArray(res?.profiles)) {
        setSshProfiles(res.profiles);
        if (!res?.status?.activeProfile && res.profiles.length > 0) {
          const first = res.profiles[0];
          setSshForm({
            id: first.id,
            name: first.name || '',
            host: first.host || '127.0.0.1',
            port: first.port || 22,
            username: first.username || 'root',
            authMethod: first.authMethod || 'password',
            password: first.password || '',
            identityFile: first.identityFile || '~/.ssh/id_rsa',
            remotePath: first.remotePath || '~',
          });
        }
      }
    } catch {
      // ignore
    }
  }

  function parseQuickSshCommand() {
    const raw = sshQuickCmd.trim();
    if (!raw) return;
    let port = sshForm.port || 22;
    let identityFile = sshForm.identityFile;
    let authMethod = sshForm.authMethod;

    const portMatch = raw.match(/(?:-p|--port)\s+(\d+)/);
    if (portMatch) port = Number(portMatch[1]) || 22;

    const keyMatch = raw.match(/-i\s+([^\s]+)/);
    if (keyMatch) {
      identityFile = keyMatch[1].replace(/^["']|["']$/g, '');
      authMethod = 'identity-file';
    }

    const cleaned = raw
      .replace(/^ssh\s+/i, '')
      .replace(/(?:-p|--port)\s+\d+/g, '')
      .replace(/-i\s+[^\s]+/g, '')
      .trim();

    const targetToken = cleaned.split(/\s+/)[0] || '';
    let username = sshForm.username || 'root';
    let hostPart = targetToken;
    let remotePath = sshForm.remotePath || '~';

    if (targetToken.includes('@')) {
      const [u, rest] = targetToken.split('@');
      if (u) username = u;
      hostPart = rest || '';
    }

    if (hostPart.includes(':')) {
      const [h, p] = hostPart.split(':');
      hostPart = h;
      if (p) {
        if (/^\d+$/.test(p)) {
          port = Number(p);
        } else {
          remotePath = p;
        }
      }
    }

    if (hostPart) {
      setSshForm({
        ...sshForm,
        id: undefined,
        name: `${username}@${hostPart}`,
        host: hostPart,
        port,
        username,
        authMethod,
        identityFile,
        remotePath,
      });
      opts.setStatusNotice(`Parsed SSH target: ${username}@${hostPart}:${port}`);
    }
  }

  async function handleTestSshConnection() {
    if (isTestingSsh) return;
    setIsTestingSsh(true);
    setSshTestResult(null);
    opts.setStatusNotice(
      `Testing SSH connection to ${sshForm.username}@${sshForm.host}:${sshForm.port}...`
    );
    try {
      const res = await fetch('/api/ssh/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sshForm),
      }).then((r) => r.json());
      setSshTestResult(res);
      opts.setStatusNotice(
        res.ok
          ? `✓ SSH Connection Verified (${res.latencyMs}ms) — Syncing remote files...`
          : `✗ SSH Test Failed: ${res.message}`
      );
      if (res.ok) {
        await handleConnectSshHost(true);
      }
    } catch (err) {
      setSshTestResult({
        ok: false,
        message: (err as Error).message,
      });
    } finally {
      setIsTestingSsh(false);
    }
  }

  async function handleSaveSshProfile() {
    const res = await fetch('/api/ssh/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sshForm),
    }).then((r) => r.json());
    if (Array.isArray(res?.profiles)) {
      setSshProfiles(res.profiles);
      opts.setStatusNotice(`Saved SSH Host "${sshForm.name || sshForm.host}"`);
    }
  }

  async function handleDeleteSshProfile(profileId: string) {
    const res = await fetch('/api/ssh/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    }).then((r) => r.json());
    if (Array.isArray(res?.profiles)) {
      setSshProfiles(res.profiles);
      opts.setStatusNotice('Deleted saved SSH Host profile');
    }
  }

  async function handleBrowseRemoteSsh(targetDir?: string) {
    const dirToBrowse = targetDir ?? sshForm.remotePath ?? '~';
    opts.setStatusNotice(`Browsing remote directory ${dirToBrowse}...`);
    try {
      const res = await fetch('/api/ssh/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: sshForm, targetDir: dirToBrowse }),
      }).then((r) => r.json());
      if (res?.ok) {
        setSshBrowseData({
          currentDir: res.currentDir,
          directories: res.directories || [],
        });
        setSshForm((prev) => ({ ...prev, remotePath: res.currentDir }));
        opts.setStatusNotice(`Loaded remote directory: ${res.currentDir}`);
      } else {
        opts.setStatusNotice(`Remote browse failed: ${res?.error || 'Check SSH connection'}`);
      }
    } catch (err) {
      opts.setStatusNotice(`Remote browse error: ${(err as Error).message}`);
    }
  }

  async function handleConnectSshHost(keepModalOpen = false, remotePathOverride?: string) {
    if (isConnectingSsh) return;
    setIsConnectingSsh(true);
    const activeP = sshStatus?.activeProfile;
    const payload = {
      ...sshForm,
      host: activeP && remotePathOverride ? activeP.host : sshForm.host,
      port: activeP && remotePathOverride ? activeP.port : sshForm.port,
      username: activeP && remotePathOverride ? activeP.username : sshForm.username,
      authMethod: activeP && remotePathOverride ? activeP.authMethod : sshForm.authMethod,
      password:
        (activeP && remotePathOverride ? activeP.password : undefined) || sshForm.password,
      identityFile:
        activeP && remotePathOverride ? activeP.identityFile : sshForm.identityFile,
      remotePath: remotePathOverride ?? sshForm.remotePath,
    };
    opts.setStatusNotice(
      `Connecting to Remote SSH ${payload.username}@${payload.host}:${payload.remotePath}...`
    );
    try {
      const res = await fetch('/api/ssh/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json());

      if (!res.ok) {
        setSshTestResult({
          ok: false,
          message: res.error || 'SSH Connection Failed',
        });
        opts.setStatusNotice(`✗ SSH Connect Failed: ${res.error}`);
        return;
      }

      setSshStatus(res.status);
      if (res.status?.activeProfile?.remotePath) {
        setSshForm((prev) => ({
          ...prev,
          remotePath: res.status.activeProfile.remotePath,
        }));
      }
      if (Array.isArray(res.profiles)) setSshProfiles(res.profiles);
      opts.setWorkspaceRoot(res.workspaceRoot);
      opts.setWorkspaceName(res.workspaceName);
      opts.setFileTree(res.tree ?? []);
      opts.setExpandedDirs({});
      opts.setShowLeftSidebar(true);
      opts.setShowRightAiDock(true);
      opts.setActiveActivity('explorer');
      opts.setWorkspaceSectionOpen(true);
      opts.setTabs([]);
      opts.setActiveTabPath('');
      if (!keepModalOpen) {
        setShowSshModal(false);
      }

      const newFiles: string[] = Array.isArray(res.files) ? res.files : [];
      const preferred =
        newFiles.find((f) => /^readme\.md$/i.test(f)) ||
        newFiles.find((f) => /^makefile$/i.test(f)) ||
        newFiles.find((f) => /^package\.json$/i.test(f)) ||
        newFiles[0];
      if (preferred) {
        await opts.openFileInTab(preferred);
      }

      const sessList = await opts.bridge.request<any[]>('session.list');
      const normRoot = (p: string) => (p || '').replace(/\\/g, '/').toLowerCase();
      const matchingSession = sessList.find(
        (s: any) => normRoot(s.workspaceRoot) === normRoot(res.workspaceRoot)
      );
      if (matchingSession) {
        opts.setSessions(sessList);
        await opts.selectAndResumeSession(matchingSession.sessionId);
      } else {
        const created = await opts.bridge.request<any>('session.create', {
          title: `${res.workspaceName} AI Session`,
          workspaceRoot: res.workspaceRoot,
          executionMode: opts.executionMode,
        });
        const updatedList = await opts.bridge.request<any[]>('session.list');
        opts.setSessions(updatedList);
        await opts.selectAndResumeSession(created.sessionId);
      }

      await opts.refreshGitStatus();
      opts.appendLog(
        `[Remote-SSH] Connected to ${sshForm.username}@${sshForm.host}:${sshForm.remotePath}`
      );
      opts.setStatusNotice(`🌐 Connected to SSH: ${res.workspaceName}`);
    } catch (err) {
      opts.setStatusNotice(`SSH Error: ${(err as Error).message}`);
    } finally {
      setIsConnectingSsh(false);
    }
  }

  async function handleDisconnectSshHost() {
    const res = await fetch('/api/ssh/disconnect', { method: 'POST' }).then((r) => r.json());
    if (res?.ok) {
      setSshStatus(res.status);
      opts.setWorkspaceRoot(res.workspaceRoot);
      opts.setWorkspaceName(res.workspaceName);
      opts.setFileTree(res.tree ?? []);
      opts.setTabs([]);
      opts.setActiveTabPath('');
      setShowSshModal(false);
      await opts.refreshGitStatus();
      opts.setStatusNotice(`Disconnected Remote SSH -> Local (${res.workspaceName})`);
    }
  }

  return {
    showSshModal,
    setShowSshModal,
    sshStatus,
    setSshStatus,
    sshProfiles,
    setSshProfiles,
    sshQuickCmd,
    setSshQuickCmd,
    sshForm,
    setSshForm,
    sshTestResult,
    setSshTestResult,
    isTestingSsh,
    isConnectingSsh,
    sshBrowseData,
    setSshBrowseData,
    openSshConnectionModal,
    parseQuickSshCommand,
    handleTestSshConnection,
    handleSaveSshProfile,
    handleDeleteSshProfile,
    handleBrowseRemoteSsh,
    handleConnectSshHost,
    handleDisconnectSshHost,
  };
}

