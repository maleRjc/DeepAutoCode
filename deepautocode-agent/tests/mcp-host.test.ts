import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  consumeSseBuffer,
  loadMcpConfigsFromWorkspace,
  McpHost,
} from '../src/core/McpClient.js';

describe('McpHost config loading', () => {
  it('loads .deepautocode/mcp.json from workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-mcp-'));
    await fs.mkdir(path.join(root, '.deepautocode'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.deepautocode', 'mcp.json'),
      JSON.stringify({
        mcpServers: [
          {
            id: 'demo',
            name: 'Demo Server',
            transport: 'stdio',
            commandOrUrl: 'npx -y @modelcontextprotocol/server-everything',
            enabled: true,
          },
          {
            id: 'disabled',
            name: 'Off',
            transport: 'stdio',
            commandOrUrl: 'echo hi',
            enabled: false,
          },
        ],
      }),
      'utf-8'
    );

    const configs = await loadMcpConfigsFromWorkspace(root);
    expect(configs.length).toBe(2);
    expect(configs[0].id).toBe('demo');
    expect(configs[0].commandOrUrl).toContain('server-everything');
  });

  it('loads sse/http transport + headers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-mcp-hdr-'));
    await fs.mkdir(path.join(root, '.deepautocode'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.deepautocode', 'mcp.json'),
      JSON.stringify({
        mcpServers: [
          {
            id: 'remote',
            name: 'Remote',
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer test-token' },
            enabled: true,
          },
          {
            id: 'sse1',
            name: 'SSE',
            transport: 'sse',
            commandOrUrl: 'http://127.0.0.1:9999/sse',
            headers: { 'X-Api-Key': 'k' },
          },
        ],
      }),
      'utf-8'
    );
    const configs = await loadMcpConfigsFromWorkspace(root);
    expect(configs[0].transport).toBe('http');
    expect(configs[0].commandOrUrl).toBe('https://example.com/mcp');
    expect(configs[0].headers?.Authorization).toBe('Bearer test-token');
    expect(configs[1].transport).toBe('sse');
    expect(configs[1].headers?.['X-Api-Key']).toBe('k');
  });

  it('skips builtin placeholders without crashing connectAll', async () => {
    const host = new McpHost();
    await host.connectAll([
      {
        id: 'builtin',
        name: 'Builtin Guard',
        transport: 'stdio',
        commandOrUrl: 'builtin://capability-registry/workspace-fs',
        enabled: true,
      },
    ]);
    expect(host.listTools()).toHaveLength(0);
    expect(host.getLastError() || '').toMatch(/Built-in MCP placeholder|failed/i);
    await host.dispose();
  });
});

describe('consumeSseBuffer', () => {
  it('parses endpoint and message frames', () => {
    const { events, rest } = consumeSseBuffer(
      'event: endpoint\ndata: /messages?sid=1\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\npartial'
    );
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('endpoint');
    expect(events[0].data).toBe('/messages?sid=1');
    expect(events[1].event).toBe('message');
    expect(rest).toBe('partial');
  });
});

describe('McpHost Streamable HTTP', () => {
  it('connects via http transport with Authorization header', async () => {
    const seenAuth: string[] = [];
    const server = http.createServer((req, res) => {
      seenAuth.push(String(req.headers.authorization || ''));
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (body.method === 'initialize') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'mock', version: '0.0.1' },
              },
            })
          );
          return;
        }
        if (body.method === 'notifications/initialized') {
          res.end('{}');
          return;
        }
        if (body.method === 'tools/list') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                tools: [
                  {
                    name: 'echo',
                    description: 'Echo tool',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              },
            })
          );
          return;
        }
        if (body.method === 'tools/call') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { content: [{ type: 'text', text: 'pong' }], isError: false },
            })
          );
          return;
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const host = new McpHost();
    try {
      await host.connectAll([
        {
          id: 'http-mock',
          name: 'HTTP Mock',
          transport: 'http',
          commandOrUrl: `http://127.0.0.1:${port}/mcp`,
          enabled: true,
          headers: { Authorization: 'Bearer secret-token' },
        },
      ]);
      expect(host.getLastError()).toBeNull();
      const tools = host.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].qualifiedName).toBe('mcp__http-mock__echo');
      expect(seenAuth.some((a) => a === 'Bearer secret-token')).toBe(true);

      const call = await host.call('mcp__http-mock__echo', { x: 1 });
      expect(call.ok).toBe(true);
    } finally {
      await host.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  it('connects via classic SSE transport', async () => {
    const sessions = new Map<http.ServerResponse, string>();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/sse') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('event: endpoint\ndata: /messages\n\n');
        sessions.set(res, '');
        req.on('close', () => sessions.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          let result: unknown = {};
          if (body.method === 'initialize') {
            result = {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'sse-mock', version: '0.0.1' },
            };
          } else if (body.method === 'tools/list') {
            result = {
              tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }],
            };
          } else if (body.method === 'notifications/initialized') {
            res.writeHead(202);
            res.end();
            return;
          }
          // Reply on the SSE stream
          const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
          for (const sse of sessions.keys()) {
            sse.write(`event: message\ndata: ${payload}\n\n`);
          }
          res.writeHead(202);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const host = new McpHost();
    try {
      await host.connectAll([
        {
          id: 'sse-mock',
          name: 'SSE Mock',
          transport: 'sse',
          commandOrUrl: `http://127.0.0.1:${port}/sse`,
          enabled: true,
        },
      ]);
      expect(host.getLastError()).toBeNull();
      expect(host.listTools().map((t) => t.name)).toEqual(['ping']);
    } finally {
      await host.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
