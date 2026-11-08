/**
 * Minimal MCP (Model Context Protocol) client.
 * Transports: stdio (Content-Length / NDJSON), SSE (HTTP+SSE), http (Streamable HTTP).
 * Optional `headers` for Bearer / API-key auth on remote transports.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { URL } from 'node:url';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  /** Shell command for stdio, or SSE/HTTP URL for remote transports */
  commandOrUrl: string;
  enabled?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  /** Extra HTTP headers for SSE / Streamable HTTP (e.g. Authorization) */
  headers?: Record<string, string>;
  /** Optional bearer / access token → Authorization: Bearer … (Stage W OAuth paste) */
  auth?: { accessToken?: string; bearerToken?: string };
  /** Qualified or bare tool names the Agent must not expose/call */
  disabledTools?: string[];
}

export interface McpResourceDescriptor {
  serverId: string;
  serverName: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDescriptor {
  serverId: string;
  serverName: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpToolDescriptor {
  serverId: string;
  serverName: string;
  name: string;
  /** Prefixed name exposed to the Agent: mcp__<serverId>__<toolName> */
  qualifiedName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  content?: unknown;
  error?: string;
  isError?: boolean;
}

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface McpSession {
  readonly serverId: string;
  readonly serverName: string;
  listTools(): McpToolDescriptor[];
  listResources(): McpResourceDescriptor[];
  listPrompts(): McpPromptDescriptor[];
  start(timeoutMs?: number): Promise<void>;
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<McpCallResult>;
  readResource(uri: string, timeoutMs?: number): Promise<McpCallResult>;
  getPrompt(
    name: string,
    args?: Record<string, string>,
    timeoutMs?: number
  ): Promise<McpCallResult>;
  dispose(): Promise<void>;
}

function resolveAuthHeaders(config: McpServerConfig): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(config.headers || {}) };
  const token = config.auth?.accessToken || config.auth?.bearerToken;
  if (token && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  return Object.keys(headers).length ? headers : undefined;
}

function qualifyToolName(serverId: string, toolName: string): string {
  const sid = String(serverId || 'mcp').replace(/[^a-zA-Z0-9_-]/g, '_');
  const tn = String(toolName || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${sid}__${tn}`;
}

function parseCommandLine(commandOrUrl: string): { cmd: string; args: string[] } {
  const raw = String(commandOrUrl || '').trim();
  if (!raw) return { cmd: '', args: [] };
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur) parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return { cmd: parts[0] || '', args: parts.slice(1) };
}

function normalizeTransport(raw: unknown): 'stdio' | 'sse' | 'http' {
  const t = String(raw || 'stdio').toLowerCase();
  if (t === 'sse' || t === 'http+sse' || t === 'http_sse') return 'sse';
  if (t === 'http' || t === 'streamable' || t === 'streamable-http' || t === 'streamable_http') {
    return 'http';
  }
  return 'stdio';
}

function mapToolsFromList(
  config: McpServerConfig,
  toolArr: any[]
): McpToolDescriptor[] {
  return toolArr.map((t: any) => ({
    serverId: config.id,
    serverName: config.name || config.id,
    name: String(t.name || ''),
    qualifiedName: qualifyToolName(config.id, String(t.name || '')),
    description: t.description ? String(t.description) : undefined,
    inputSchema:
      t.inputSchema && typeof t.inputSchema === 'object'
        ? (t.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} },
  }));
}

/** Parse one or more SSE frames from a text buffer; returns events + remainder. */
export function consumeSseBuffer(buffer: string): {
  events: Array<{ event: string; data: string }>;
  rest: string;
} {
  const events: Array<{ event: string; data: string }> = [];
  let rest = buffer;
  while (true) {
    const sep = rest.indexOf('\n\n');
    if (sep < 0) break;
    const frame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    if (!frame.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    events.push({ event, data: dataLines.join('\n') });
  }
  return { events, rest };
}

function mergeHeaders(
  base: Record<string, string>,
  extra?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (k && v != null) out[k] = String(v);
  }
  return out;
}

function httpRequest(
  urlStr: string,
  opts: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      reject(new Error(`Invalid MCP URL: ${urlStr}`));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`HTTP ${opts.method} timed out after ${opts.timeoutMs || 15_000}ms`));
    }, opts.timeoutMs || 15_000);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on('close', () => clearTimeout(timer));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

class McpStdioSession implements McpSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private buffer = Buffer.alloc(0);
  private tools: McpToolDescriptor[] = [];
  private resources: McpResourceDescriptor[] = [];
  private prompts: McpPromptDescriptor[] = [];
  private closed = false;

  constructor(private readonly config: McpServerConfig) {}

  get serverId(): string {
    return this.config.id;
  }

  get serverName(): string {
    return this.config.name || this.config.id;
  }

  listTools(): McpToolDescriptor[] {
    return [...this.tools];
  }

  listResources(): McpResourceDescriptor[] {
    return [...this.resources];
  }

  listPrompts(): McpPromptDescriptor[] {
    return [...this.prompts];
  }

  async start(timeoutMs = 15_000): Promise<void> {
    if (/^builtin:\/\//i.test(this.config.commandOrUrl)) {
      throw new Error(
        `Built-in MCP placeholder "${this.config.commandOrUrl}" is not a real process. Remove it or replace with an npx/stdio MCP server.`
      );
    }

    const { cmd, args } = parseCommandLine(this.config.commandOrUrl);
    if (!cmd) throw new Error(`Empty MCP command for server "${this.config.name}"`);

    this.child = spawn(cmd, args, {
      cwd: this.config.cwd || process.cwd(),
      env: { ...process.env, ...(this.config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', () => {
      // stderr is noisy for many MCP servers; keep process alive
    });
    this.child.on('exit', () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server "${this.config.name}" exited`));
      }
      this.pending.clear();
    });

    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'deepautocode-agent', version: '1.1.0' },
      },
      timeoutMs
    );
    this.notify('notifications/initialized', {});

    const listed = await this.request('tools/list', {}, timeoutMs);
    const toolArr = Array.isArray(listed?.tools) ? listed.tools : [];
    this.tools = mapToolsFromList(this.config, toolArr);
    await this.refreshResourcesAndPrompts(timeoutMs);
  }

  private async refreshResourcesAndPrompts(timeoutMs: number): Promise<void> {
    try {
      const listed = await this.request('resources/list', {}, Math.min(timeoutMs, 8000));
      const arr = Array.isArray(listed?.resources) ? listed.resources : [];
      this.resources = arr.map((r: any) => ({
        serverId: this.config.id,
        serverName: this.serverName,
        uri: String(r.uri || ''),
        name: r.name ? String(r.name) : undefined,
        description: r.description ? String(r.description) : undefined,
        mimeType: r.mimeType ? String(r.mimeType) : undefined,
      })).filter((r: McpResourceDescriptor) => r.uri);
    } catch {
      this.resources = [];
    }
    try {
      const listed = await this.request('prompts/list', {}, Math.min(timeoutMs, 8000));
      const arr = Array.isArray(listed?.prompts) ? listed.prompts : [];
      this.prompts = arr.map((p: any) => ({
        serverId: this.config.id,
        serverName: this.serverName,
        name: String(p.name || ''),
        description: p.description ? String(p.description) : undefined,
        arguments: Array.isArray(p.arguments) ? p.arguments : undefined,
      })).filter((p: McpPromptDescriptor) => p.name);
    } catch {
      this.prompts = [];
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<McpCallResult> {
    try {
      const result = await this.request(
        'tools/call',
        { name: toolName, arguments: args || {} },
        timeoutMs
      );
      return {
        ok: !result?.isError,
        content: result?.content ?? result,
        isError: Boolean(result?.isError),
        error: result?.isError ? JSON.stringify(result?.content ?? result) : undefined,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) };
    }
  }

  async readResource(uri: string, timeoutMs = 30_000): Promise<McpCallResult> {
    try {
      const result = await this.request('resources/read', { uri }, timeoutMs);
      return { ok: true, content: result?.contents ?? result };
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) };
    }
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    timeoutMs = 30_000
  ): Promise<McpCallResult> {
    try {
      const result = await this.request(
        'prompts/get',
        { name, arguments: args || {} },
        timeoutMs
      );
      return { ok: true, content: result };
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) };
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('MCP session disposed'));
    }
    this.pending.clear();
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
    }
    this.child = null;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.writeMessage({ jsonrpc: '2.0', method, params });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<any> {
    if (this.closed || !this.child) {
      return Promise.reject(new Error(`MCP server "${this.config.name}" is not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  private writeMessage(msg: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf-8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf-8');
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        const nl = this.buffer.indexOf('\n');
        if (nl >= 0) {
          const line = this.buffer.slice(0, nl).toString('utf-8').trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line.startsWith('{')) {
            try {
              this.handleMessage(JSON.parse(line));
            } catch {
              // ignore
            }
          }
          continue;
        }
        break;
      }
      const headerText = this.buffer.slice(0, headerEnd).toString('utf-8');
      const lenMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!lenMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lenMatch[1]);
      const total = headerEnd + 4 + length;
      if (this.buffer.length < total) break;
      const body = this.buffer.slice(headerEnd + 4, total).toString('utf-8');
      this.buffer = this.buffer.slice(total);
      try {
        this.handleMessage(JSON.parse(body));
      } catch {
        // ignore malformed
      }
    }
  }

  private handleMessage(msg: any): void {
    if (msg == null || typeof msg !== 'object') return;
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(
          new Error(
            typeof msg.error === 'string'
              ? msg.error
              : msg.error.message || JSON.stringify(msg.error)
          )
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }
}

/**
 * Remote MCP session: SSE (GET stream + POST messages) or Streamable HTTP (POST JSON/SSE).
 */
class McpRemoteSession implements McpSession {
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private tools: McpToolDescriptor[] = [];
  private resources: McpResourceDescriptor[] = [];
  private prompts: McpPromptDescriptor[] = [];
  private closed = false;
  private postUrl = '';
  private sseReq: http.ClientRequest | null = null;
  private sseRes: http.IncomingMessage | null = null;
  private sseBuffer = '';

  constructor(private readonly config: McpServerConfig) {}

  get serverId(): string {
    return this.config.id;
  }

  get serverName(): string {
    return this.config.name || this.config.id;
  }

  listTools(): McpToolDescriptor[] {
    return [...this.tools];
  }

  listResources(): McpResourceDescriptor[] {
    return [...this.resources];
  }

  listPrompts(): McpPromptDescriptor[] {
    return [...this.prompts];
  }

  async start(timeoutMs = 15_000): Promise<void> {
    const url = String(this.config.commandOrUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(
        `MCP ${this.config.transport} URL must be http(s)://… for server "${this.config.name}"`
      );
    }

    if (this.config.transport === 'sse') {
      await this.startSse(url, timeoutMs);
    } else {
      this.postUrl = url;
    }

    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'deepautocode-agent', version: '1.1.0' },
      },
      timeoutMs
    );
    await this.notify('notifications/initialized', {});

    const listed = await this.request('tools/list', {}, timeoutMs);
    const toolArr = Array.isArray(listed?.tools) ? listed.tools : [];
    this.tools = mapToolsFromList(this.config, toolArr);
    await this.refreshResourcesAndPrompts(timeoutMs);
  }

  private async refreshResourcesAndPrompts(timeoutMs: number): Promise<void> {
    try {
      const listed = await this.request('resources/list', {}, Math.min(timeoutMs, 8000));
      const arr = Array.isArray(listed?.resources) ? listed.resources : [];
      this.resources = arr
        .map((r: any) => ({
          serverId: this.config.id,
          serverName: this.serverName,
          uri: String(r.uri || ''),
          name: r.name ? String(r.name) : undefined,
          description: r.description ? String(r.description) : undefined,
          mimeType: r.mimeType ? String(r.mimeType) : undefined,
        }))
        .filter((r: McpResourceDescriptor) => r.uri);
    } catch {
      this.resources = [];
    }
    try {
      const listed = await this.request('prompts/list', {}, Math.min(timeoutMs, 8000));
      const arr = Array.isArray(listed?.prompts) ? listed.prompts : [];
      this.prompts = arr
        .map((p: any) => ({
          serverId: this.config.id,
          serverName: this.serverName,
          name: String(p.name || ''),
          description: p.description ? String(p.description) : undefined,
          arguments: Array.isArray(p.arguments) ? p.arguments : undefined,
        }))
        .filter((p: McpPromptDescriptor) => p.name);
    } catch {
      this.prompts = [];
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<McpCallResult> {
    try {
      const result = await this.request(
        'tools/call',
        { name: toolName, arguments: args || {} },
        timeoutMs
      );
      return {
        ok: !result?.isError,
        content: result?.content ?? result,
        isError: Boolean(result?.isError),
        error: result?.isError ? JSON.stringify(result?.content ?? result) : undefined,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) };
    }
  }

  async readResource(uri: string, timeoutMs = 30_000): Promise<McpCallResult> {
    try {
      const result = await this.request('resources/read', { uri }, timeoutMs);
      return { ok: true, content: result?.contents ?? result };
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) };
    }
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    timeoutMs = 30_000
  ): Promise<McpCallResult> {
    try {
      const result = await this.request(
        'prompts/get',
        { name, arguments: args || {} },
        timeoutMs
      );
      return { ok: true, content: result };
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) };
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('MCP session disposed'));
    }
    this.pending.clear();
    try {
      this.sseRes?.destroy();
    } catch {
      // ignore
    }
    try {
      this.sseReq?.destroy();
    } catch {
      // ignore
    }
    this.sseRes = null;
    this.sseReq = null;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return mergeHeaders(extra || {}, resolveAuthHeaders(this.config));
  }

  private async startSse(sseUrl: string, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error(`MCP SSE connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let parsed: URL;
      try {
        parsed = new URL(sseUrl);
      } catch {
        finish(new Error(`Invalid MCP SSE URL: ${sseUrl}`));
        return;
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: this.authHeaders({
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          }),
        },
        (res) => {
          this.sseRes = res;
          if ((res.statusCode || 0) >= 400) {
            finish(new Error(`MCP SSE HTTP ${res.statusCode}`));
            return;
          }
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            this.sseBuffer += chunk;
            const { events, rest } = consumeSseBuffer(this.sseBuffer);
            this.sseBuffer = rest;
            for (const ev of events) {
              if (ev.event === 'endpoint' && ev.data) {
                try {
                  this.postUrl = new URL(ev.data, sseUrl).toString();
                  finish();
                } catch (err) {
                  finish(err as Error);
                }
              } else if (ev.event === 'message' || !ev.event) {
                this.handleSseData(ev.data);
              } else if (ev.data?.startsWith('{')) {
                this.handleSseData(ev.data);
              }
            }
          });
          res.on('error', (err) => {
            this.failAllPending(err);
            finish(err);
          });
          res.on('end', () => {
            this.failAllPending(new Error(`MCP SSE closed for "${this.config.name}"`));
          });
        }
      );
      this.sseReq = req;
      req.on('error', (err) => finish(err));
      req.end();
    });

    if (!this.postUrl) {
      throw new Error(`MCP SSE server "${this.config.name}" did not send an endpoint event`);
    }
  }

  private handleSseData(data: string): void {
    const trimmed = String(data || '').trim();
    if (!trimmed.startsWith('{')) return;
    try {
      this.handleRpcMessage(JSON.parse(trimmed));
    } catch {
      // ignore
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private handleRpcMessage(msg: any): void {
    if (msg == null || typeof msg !== 'object') return;
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(
          new Error(
            typeof msg.error === 'string'
              ? msg.error
              : msg.error.message || JSON.stringify(msg.error)
          )
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.closed || !this.postUrl) return;
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    try {
      await httpRequest(this.postUrl, {
        method: 'POST',
        headers: this.authHeaders({
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        }),
        body,
        timeoutMs: 10_000,
      });
    } catch {
      // notifications are best-effort
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<any> {
    if (this.closed || !this.postUrl) {
      return Promise.reject(new Error(`MCP server "${this.config.name}" is not connected`));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      void (async () => {
        try {
          const res = await httpRequest(this.postUrl, {
            method: 'POST',
            headers: this.authHeaders({
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            }),
            body: JSON.stringify(payload),
            timeoutMs,
          });

          const ct = String(res.headers['content-type'] || '').toLowerCase();
          const text = res.body.toString('utf-8');

          // Streamable HTTP may return JSON directly
          if (ct.includes('application/json') || text.trim().startsWith('{')) {
            try {
              const msg = JSON.parse(text);
              this.handleRpcMessage(msg);
              return;
            } catch {
              // fall through
            }
          }

          // Or an SSE body with the response
          if (ct.includes('text/event-stream') || text.includes('data:')) {
            const { events } = consumeSseBuffer(text.endsWith('\n\n') ? text : `${text}\n\n`);
            for (const ev of events) {
              if (ev.data) this.handleSseData(ev.data);
            }
            // Classic SSE: response arrives on the long-lived GET stream; pending stays until then
            if (this.config.transport === 'sse' && this.pending.has(id)) {
              return;
            }
          }

          // HTTP 202 Accepted — wait for SSE message event
          if (res.status === 202 && this.config.transport === 'sse' && this.pending.has(id)) {
            return;
          }

          if (this.pending.has(id) && res.status >= 400) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new Error(`MCP ${method} HTTP ${res.status}: ${text.slice(0, 200)}`));
          }
        } catch (err) {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(err as Error);
          }
        }
      })();
    });
  }
}

function createSession(config: McpServerConfig): McpSession {
  const withAuth: McpServerConfig = {
    ...config,
    headers: resolveAuthHeaders(config),
  };
  if (withAuth.transport === 'sse' || withAuth.transport === 'http') {
    return new McpRemoteSession(withAuth);
  }
  return new McpStdioSession(withAuth);
}

export class McpHost {
  private sessions = new Map<string, McpSession>();
  private tools: McpToolDescriptor[] = [];
  private resources: McpResourceDescriptor[] = [];
  private prompts: McpPromptDescriptor[] = [];
  private lastError: string | null = null;
  private closedIds = new Set<string>();

  getLastError(): string | null {
    return this.lastError;
  }

  listTools(): McpToolDescriptor[] {
    return [...this.tools];
  }

  listResources(): McpResourceDescriptor[] {
    return [...this.resources];
  }

  listPrompts(): McpPromptDescriptor[] {
    return [...this.prompts];
  }

  async readResource(uri: string): Promise<McpCallResult & { serverId?: string }> {
    const hit = this.resources.find((r) => r.uri === uri);
    if (hit) {
      const s = this.sessions.get(hit.serverId);
      if (s) {
        const res = await s.readResource(uri);
        return { ...res, serverId: hit.serverId };
      }
    }
    for (const [id, s] of this.sessions) {
      const res = await s.readResource(uri);
      if (res.ok) return { ...res, serverId: id };
    }
    return { ok: false, error: `Unknown MCP resource: ${uri}` };
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    serverId?: string
  ): Promise<McpCallResult & { serverId?: string }> {
    if (serverId) {
      const s = this.sessions.get(serverId);
      if (!s) return { ok: false, error: `MCP server not connected: ${serverId}` };
      return { ...(await s.getPrompt(name, args)), serverId };
    }
    const hits = this.prompts.filter((p) => p.name === name);
    if (hits.length === 1) {
      const s = this.sessions.get(hits[0].serverId);
      if (s) return { ...(await s.getPrompt(name, args)), serverId: hits[0].serverId };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        error: `Ambiguous MCP prompt "${name}". Pass serverId. Candidates: ${hits
          .map((h) => h.serverId)
          .join(', ')}`,
      };
    }
    return { ok: false, error: `Unknown MCP prompt: ${name}` };
  }

  getStatus(): Array<{
    id: string;
    name: string;
    connected: boolean;
    toolCount: number;
    error?: string;
  }> {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      name: s.serverName,
      connected: s.listTools().length >= 0 && !this.closedIds.has(id),
      toolCount: s.listTools().length,
    }));
  }

  async connectAll(configs: McpServerConfig[], cwd?: string): Promise<void> {
    await this.dispose();
    this.lastError = null;
    const enabled = (configs || []).filter(
      (c) => c && c.enabled !== false && String(c.commandOrUrl || '').trim()
    );
    for (const cfg of enabled) {
      const session = createSession({
        ...cfg,
        cwd: cfg.cwd || cwd,
      });
      try {
        await session.start();
        this.sessions.set(cfg.id, session);
        const disabled = new Set(
          (cfg.disabledTools || []).map((t) => String(t).toLowerCase())
        );
        const tools = session.listTools().filter((t) => {
          if (disabled.size === 0) return true;
          return (
            !disabled.has(t.qualifiedName.toLowerCase()) &&
            !disabled.has(t.name.toLowerCase()) &&
            !disabled.has(`${t.serverId}/${t.name}`.toLowerCase())
          );
        });
        this.tools.push(...tools);
        this.resources.push(...session.listResources());
        this.prompts.push(...session.listPrompts());
      } catch (err) {
        this.closedIds.add(cfg.id);
        const msg = `MCP "${cfg.name}" failed: ${(err as Error).message || String(err)}`;
        this.lastError = this.lastError ? `${this.lastError}; ${msg}` : msg;
        await session.dispose().catch(() => undefined);
      }
    }
  }

  /** Also block call_mcp_tool for disabled names (defense in depth). */
  isToolDisabled(qualifiedOrRawName: string, configs: McpServerConfig[]): boolean {
    const raw = String(qualifiedOrRawName || '').toLowerCase();
    for (const cfg of configs || []) {
      for (const t of cfg.disabledTools || []) {
        if (String(t).toLowerCase() === raw) return true;
      }
    }
    return false;
  }

  async call(
    qualifiedOrRawName: string,
    args: Record<string, unknown>
  ): Promise<McpCallResult & { serverId?: string; toolName?: string }> {
    const raw = String(qualifiedOrRawName || '');
    let serverId = '';
    let toolName = raw;
    const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(raw);
    const parts = raw.split('__');
    if (parts[0] === 'mcp' && parts.length >= 3) {
      serverId = parts[1];
      toolName = parts.slice(2).join('__');
    } else if (m) {
      serverId = m[1];
      toolName = m[2];
    } else {
      const hits = this.tools.filter((t) => t.name === raw || t.qualifiedName === raw);
      if (hits.length === 1) {
        serverId = hits[0].serverId;
        toolName = hits[0].name;
      } else if (hits.length === 0) {
        return { ok: false, error: `Unknown MCP tool: ${raw}` };
      } else {
        return {
          ok: false,
          error: `Ambiguous MCP tool "${raw}". Use qualified name: ${hits
            .map((h) => h.qualifiedName)
            .join(', ')}`,
        };
      }
    }

    const session = this.sessions.get(serverId);
    if (!session) {
      const hit = this.tools.find((t) => t.qualifiedName === raw || t.name === toolName);
      if (hit) {
        const s = this.sessions.get(hit.serverId);
        if (s) {
          const res = await s.callTool(hit.name, args);
          return { ...res, serverId: hit.serverId, toolName: hit.name };
        }
      }
      return { ok: false, error: `MCP server not connected: ${serverId || '(unknown)'}` };
    }
    const res = await session.callTool(toolName, args);
    return { ...res, serverId, toolName };
  }

  async dispose(): Promise<void> {
    for (const s of this.sessions.values()) {
      await s.dispose().catch(() => undefined);
    }
    this.sessions.clear();
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.closedIds.clear();
  }
}

export async function loadMcpConfigsFromWorkspace(
  workspaceRoot: string
): Promise<McpServerConfig[]> {
  const candidates = [
    path.join(workspaceRoot, '.deepautocode', 'mcp.json'),
    path.join(workspaceRoot, '.mcp.json'),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.mcpServers)
          ? parsed.mcpServers
          : Array.isArray(parsed?.servers)
            ? parsed.servers
            : [];
      return arr
        .map((s: any, idx: number) => {
          const headersRaw = s.headers && typeof s.headers === 'object' ? s.headers : undefined;
          const headers: Record<string, string> | undefined = headersRaw
            ? Object.fromEntries(
                Object.entries(headersRaw)
                  .filter(([k, v]) => k && v != null)
                  .map(([k, v]) => [String(k), String(v)])
              )
            : undefined;
          const authRaw = s.auth && typeof s.auth === 'object' ? s.auth : undefined;
          const accessToken =
            authRaw?.accessToken ||
            authRaw?.bearerToken ||
            s.accessToken ||
            s.bearerToken ||
            undefined;
          return {
            id: String(s.id || s.name || `mcp_${idx}`),
            name: String(s.name || s.id || `mcp_${idx}`),
            transport: normalizeTransport(s.transport),
            commandOrUrl: String(s.commandOrUrl || s.command || s.url || ''),
            enabled: s.enabled !== false,
            env: s.env && typeof s.env === 'object' ? s.env : undefined,
            cwd: s.cwd ? String(s.cwd) : undefined,
            headers: headers && Object.keys(headers).length ? headers : undefined,
            auth: accessToken
              ? { accessToken: String(accessToken), bearerToken: String(accessToken) }
              : undefined,
            disabledTools: Array.isArray(s.disabledTools)
              ? s.disabledTools.map((t: unknown) => String(t)).filter(Boolean)
              : undefined,
          };
        })
        .filter((s: McpServerConfig) => s.commandOrUrl.trim());
    } catch {
      // try next
    }
  }
  return [];
}
