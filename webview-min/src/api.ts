export interface BridgeEvent {
  category: 'event';
  type: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  payload: Record<string, any>;
}

let reqSeq = 0;

export async function bridge<T = any>(
  type: string,
  payload: Record<string, unknown> = {},
  sessionId?: string
): Promise<T> {
  const res = await fetch('/api/bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: 'request',
      type,
      requestId: `ui_${Date.now()}_${++reqSeq}`,
      sessionId,
      payload,
    }),
  });
  const json = await res.json();
  if (!json?.ok) {
    throw new Error(json?.error?.message || `${type} failed`);
  }
  return json.data as T;
}

export async function cancelSession(sessionId: string, reason = '用户点击停止'): Promise<void> {
  await fetch('/api/bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: 'cancel',
      requestId: `cancel_${Date.now()}_${++reqSeq}`,
      sessionId,
      reason,
    }),
  });
}

export function connectEvents(onEvent: (event: BridgeEvent) => void): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg?.category === 'event') onEvent(msg as BridgeEvent);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      if (closed) return;
      retry = setTimeout(open, 1200);
    };
  };

  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    socket?.close();
  };
}

export async function apiGet<T = any>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function apiPost<T = any>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

export interface WorkspaceInfo {
  workspaceRoot: string;
  workspaceName: string;
  tree: FileNode[];
  files: string[];
}

export function readFile(path: string): Promise<string> {
  return fetch(`/api/workspace/raw?path=${encodeURIComponent(path)}`).then((r) => {
    if (!r.ok) throw new Error(`读取失败: ${path}`);
    return r.text();
  });
}

export function saveFile(path: string, content: string): Promise<void> {
  return bridge('capability.invoke', {
    capability: 'write-file',
    executionMode: 'auto',
    params: { filePath: path, content },
  });
}
