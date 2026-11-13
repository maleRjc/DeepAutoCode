/**
 * Section 3.2 & 6.2: Webview Message Bridge Client
 * IMPORTANT: Never imports `@cline/sdk` internal types.
 * Uses only serializable UI protocol models (`request`, `response`, `event`, `cancel`, `resume`).
 */

export interface UIEventMessage {
  category: 'event';
  type:
  | 'assistant.text.delta'
  | 'assistant.thinking.delta'
  | 'assistant.text.done'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'tool.call.failed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'diff.proposed'
  | 'diff.updated'
  | 'session.state.changed'
  | 'backend.state.changed'
  | 'runtime.error'
  | 'sandbox.branch.created'
  | 'circuit.breaker.triggered'
  | 'artifact.created'
  | 'model.tier'
  | 'goal.usage'
  | 'trace.updated'
  | 'checkpoint.created'
  | 'question.requested'
  | 'question.resolved'
  | 'task.state.changed';
  sessionId: string;
  sequence: number;
  timestamp: string;
  payload: Record<string, any>;
}

export interface UIResponseMessage {
  category: 'response';
  type: string;
  requestId: string;
  ok: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
  };
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage(msg: unknown): void;
      getState(): unknown;
      setState(state: unknown): void;
    };
  }
}

export class WebviewBridgeClient {
  private readonly pendingRequests = new Map<
    string,
    { resolve: (res: UIResponseMessage) => void; reject: (err: Error) => void }
  >();
  private readonly eventListeners = new Set<(event: UIEventMessage) => void>();
  private vscodeApi?: ReturnType<NonNullable<Window['acquireVsCodeApi']>>;
  private ws?: WebSocket;
  private reqCounter = 0;

  constructor() {
    if (typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function') {
      this.vscodeApi = window.acquireVsCodeApi();
      window.addEventListener('message', (ev) => {
        this.handleIncomingMessage(ev.data);
      });
    } else if (typeof window !== 'undefined') {
      this.connectWorkbenchWebSocket();
    }
  }

  private connectWorkbenchWebSocket(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.addEventListener('message', (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data));
        this.handleIncomingMessage(parsed);
      } catch {
        // ignore invalid JSON
      }
    });

    ws.addEventListener('close', () => {
      setTimeout(() => {
        if (typeof window !== 'undefined') {
          this.connectWorkbenchWebSocket();
        }
      }, 1000);
    });
  }

  private handleIncomingMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.category === 'response' && typeof msg.requestId === 'string') {
      const pending = this.pendingRequests.get(msg.requestId);
      if (pending) {
        this.pendingRequests.delete(msg.requestId);
        pending.resolve(msg as UIResponseMessage);
      }
      return;
    }

    if (msg.category === 'event') {
      for (const listener of this.eventListeners) {
        listener(msg as UIEventMessage);
      }
    }
  }

  onEvent(listener: (event: UIEventMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async request<T = any>(
    type: string,
    payload: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    const requestId = `ui_req_${Date.now()}_${++this.reqCounter}`;
    const message = {
      category: 'request' as const,
      type,
      requestId,
      sessionId,
      payload,
    };

    const response = await this.sendRawAndWait(requestId, message);
    if (!response.ok) {
      throw new Error(`${response.error?.code ?? 'ERR'}: ${response.error?.message ?? 'Request failed'}`);
    }
    return response.data as T;
  }

  async cancelSession(sessionId: string, reason = 'User clicked Stop'): Promise<any> {
    const requestId = `ui_cancel_${Date.now()}_${++this.reqCounter}`;
    const message = {
      category: 'cancel' as const,
      requestId,
      sessionId,
      reason,
    };
    const response = await this.sendRawAndWait(requestId, message);
    return response.data;
  }

  async resumeSession(sessionId: string, lastSequence: number): Promise<any> {
    return this.request('session.resume', { sessionId, lastSequence }, sessionId);
  }

  private async sendRawAndWait(
    requestId: string,
    message: Record<string, unknown>
  ): Promise<UIResponseMessage> {
    if (this.vscodeApi) {
      return new Promise<UIResponseMessage>((resolve, reject) => {
        this.pendingRequests.set(requestId, { resolve, reject });
        this.vscodeApi!.postMessage(message);
      });
    }

    // HTTP /api/bridge fallback for immediate request-response in Workbench server
    const token =
      typeof window !== 'undefined' ? String((window as any).__DAC_WORKBENCH_TOKEN__ || '') : '';
    const res = await fetch('/api/bridge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-DeepAutoCode-Token': token } : {}),
      },
      body: JSON.stringify(message),
    });
    return (await res.json()) as UIResponseMessage;
  }
}

