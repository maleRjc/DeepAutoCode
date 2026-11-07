import { WebSocket, WebSocketServer } from 'ws';
import type { BackendMode } from '../types.js';

export interface BackendDiagnosticState {
  configuredMode: BackendMode;
  effectiveMode: BackendMode;
  hubReachable: boolean;
  hubEndpoint?: string;
  fallbackTriggered: boolean;
  fallbackReason?: string;
  lastCheckedAt: string;
  nodeVersion: string;
  sdkVersion: string;
  notes: string[];
}

/**
 * Section 4.2 & Section 5: Backend Manager
 * Manages selection and health verification of `local` / `auto` / `hub` / `remote` modes.
 * Implements minimal Hub-Spoke topology probe & embedded Hub test broker for PoC verification.
 */
export class BackendManager {
  private configuredMode: BackendMode;
  private effectiveMode: BackendMode;
  private hubEndpoint: string;
  private hubReachable = false;
  private fallbackTriggered = false;
  private fallbackReason?: string;
  private lastCheckedAt = new Date().toISOString();
  private readonly notes: string[] = [];

  constructor(options?: {
    initialMode?: BackendMode;
    hubEndpoint?: string;
  }) {
    // ADR-006: `local` is the Phase 0/1 baseline mode
    this.configuredMode = options?.initialMode ?? 'local';
    this.effectiveMode = this.configuredMode === 'auto' ? 'local' : this.configuredMode;
    this.hubEndpoint = options?.hubEndpoint ?? 'ws://127.0.0.1:44991';
  }

  getConfiguredMode(): BackendMode {
    return this.configuredMode;
  }

  getEffectiveMode(): BackendMode {
    return this.effectiveMode;
  }

  getHubEndpoint(): string {
    return this.hubEndpoint;
  }

  /**
   * Probe whether a local or remote Hub WebSocket endpoint is reachable
   */
  async probeHub(endpoint = this.hubEndpoint, timeoutMs = 1200): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const ws = new WebSocket(endpoint);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          resolve(false);
        }
      }, timeoutMs);

      ws.once('open', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ws.close();
          resolve(true);
        }
      });

      ws.once('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });
  }

  /**
   * Resolve effective backend mode according to Section 5.2 & 5.3 rules:
   * - `local`: Direct in-process execution with local file/SQLite storage; no Hub required.
   * - `auto`: Probe compatible local Hub; if unreachable, cleanly fall back to `local` and log diagnostic reason.
   * - `hub`: Require reachable Hub endpoint; throw explicit error if Hub is unavailable.
   * - `remote`: Require explicit remote endpoint and verify reachability.
   */
  async resolveBackend(mode?: BackendMode, customEndpoint?: string): Promise<BackendDiagnosticState> {
    if (mode) {
      this.configuredMode = mode;
    }
    if (customEndpoint) {
      this.hubEndpoint = customEndpoint;
    }

    this.lastCheckedAt = new Date().toISOString();
    this.notes.length = 0;

    if (this.configuredMode === 'local') {
      this.effectiveMode = 'local';
      this.hubReachable = false;
      this.fallbackTriggered = false;
      this.fallbackReason = undefined;
      this.notes.push('Running in baseline local mode (in-process runtime + local persistent storage).');
      return this.getDiagnostics();
    }

    const reachable = await this.probeHub(this.hubEndpoint);
    this.hubReachable = reachable;

    if (this.configuredMode === 'auto') {
      if (reachable) {
        this.effectiveMode = 'hub';
        this.fallbackTriggered = false;
        this.fallbackReason = undefined;
        this.notes.push(`Connected to compatible local Hub at ${this.hubEndpoint}.`);
      } else {
        this.effectiveMode = 'local';
        this.fallbackTriggered = true;
        this.fallbackReason = `Local Hub at ${this.hubEndpoint} is unreachable; auto mode fell back to in-process local mode.`;
        this.notes.push(this.fallbackReason);
      }
      return this.getDiagnostics();
    }

    if (this.configuredMode === 'hub') {
      if (!reachable) {
        this.fallbackTriggered = false;
        this.fallbackReason = `Hub mode requires a running Hub daemon at ${this.hubEndpoint}, but connection failed.`;
        this.notes.push(this.fallbackReason);
        throw new Error(`HUB_UNAVAILABLE: ${this.fallbackReason}`);
      }
      this.effectiveMode = 'hub';
      this.fallbackTriggered = false;
      this.fallbackReason = undefined;
      this.notes.push(`Explicit Hub mode active at ${this.hubEndpoint}.`);
      return this.getDiagnostics();
    }

    // remote mode
    if (!reachable) {
      this.fallbackReason = `Remote Hub endpoint ${this.hubEndpoint} is unreachable.`;
      this.notes.push(this.fallbackReason);
      throw new Error(`REMOTE_HUB_UNAVAILABLE: ${this.fallbackReason}`);
    }
    this.effectiveMode = 'remote';
    this.fallbackTriggered = false;
    this.fallbackReason = undefined;
    this.notes.push(`Connected to remote Hub at ${this.hubEndpoint}.`);
    return this.getDiagnostics();
  }

  getDiagnostics(): BackendDiagnosticState {
    return {
      configuredMode: this.configuredMode,
      effectiveMode: this.effectiveMode,
      hubReachable: this.hubReachable,
      hubEndpoint: this.configuredMode === 'local' ? undefined : this.hubEndpoint,
      fallbackTriggered: this.fallbackTriggered,
      fallbackReason: this.fallbackReason,
      lastCheckedAt: this.lastCheckedAt,
      nodeVersion: process.version,
      sdkVersion: '0.2.0',
      notes: [...this.notes],
    };
  }
}

/**
 * Section 5.4: Minimal Local Hub Broker for Hub-Spoke Topology PoC Verification
 * Supports client attach, capability registration advertisement, and capability routing back to IDE Client.
 */
export class MinimalHubServer {
  private wss?: WebSocketServer;
  private port = 0;
  private readonly registeredClientCapabilities = new Map<string, { ws: WebSocket; capabilities: string[] }>();

  async start(port = 0): Promise<{ port: number; endpoint: string }> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port });
      wss.once('listening', () => {
        const addr = wss.address();
        this.port = typeof addr === 'object' && addr ? addr.port : port;
        this.wss = wss;
        resolve({
          port: this.port,
          endpoint: `ws://127.0.0.1:${this.port}`,
        });
      });
      wss.once('error', reject);

      wss.on('connection', (ws) => {
        let currentClientId = `client_${Date.now()}`;
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'client.attach') {
              currentClientId = msg.clientId ?? currentClientId;
              const caps: string[] = Array.isArray(msg.capabilities) ? msg.capabilities : [];
              this.registeredClientCapabilities.set(currentClientId, { ws, capabilities: caps });
              ws.send(
                JSON.stringify({
                  type: 'client.attached',
                  clientId: currentClientId,
                  registeredCapabilities: caps,
                })
              );
            } else if (msg.type === 'capability.route') {
              // Route capability request to attached client that registered this capability
              const targetCap = msg.capability as string;
              let targetEntry: { ws: WebSocket; capabilities: string[] } | undefined;
              for (const entry of this.registeredClientCapabilities.values()) {
                if (entry.capabilities.includes(targetCap)) {
                  targetEntry = entry;
                  break;
                }
              }
              if (!targetEntry) {
                ws.send(
                  JSON.stringify({
                    type: 'capability.result',
                    requestId: msg.requestId,
                    ok: false,
                    error: `No connected IDE client registered capability "${targetCap}"`,
                  })
                );
                return;
              }
              targetEntry.ws.send(
                JSON.stringify({
                  type: 'capability.invoke',
                  requestId: msg.requestId,
                  capability: targetCap,
                  params: msg.params,
                  sessionId: msg.sessionId,
                })
              );
            } else if (msg.type === 'capability.response') {
              // Broadcast response back to requester
              for (const client of wss.clients) {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(
                    JSON.stringify({
                      type: 'capability.result',
                      requestId: msg.requestId,
                      ok: msg.ok,
                      data: msg.data,
                      error: msg.error,
                    })
                  );
                }
              }
            }
          } catch {
            // ignore malformed JSON
          }
        });

        ws.on('close', () => {
          this.registeredClientCapabilities.delete(currentClientId);
        });
      });
    });
  }

  getConnectedClients(): { clientId: string; capabilities: string[] }[] {
    return Array.from(this.registeredClientCapabilities.entries()).map(([clientId, val]) => ({
      clientId,
      capabilities: val.capabilities,
    }));
  }

  async stop(): Promise<void> {
    if (!this.wss) return;
    const wss = this.wss;
    this.wss = undefined;
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

