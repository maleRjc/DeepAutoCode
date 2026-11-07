import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentClientBridge,
  BackendManager,
  MinimalHubServer,
  ProviderManager,
  RuntimeFactory,
  redactSensitiveText,
  sanitizeObjectForLog,
  validateWorkspacePath,
  type EventMessage,
} from '../src/index.js';

describe('DeepAutoCode Agent Runtime & Bridge Suite (v1.1)', () => {
  let tmpDir: string;
  let storageDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-agent-test-'));
    storageDir = path.join(tmpDir, 'storage');
    workspaceDir = path.join(tmpDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, 'sample.ts'),
      'export const version = "1.0.0";\n',
      'utf-8'
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('PoC-L1 & PoC-L2: persists session, messages, and tool calls to disk and recovers across instance restart', async () => {
    const bridge1 = await AgentClientBridge.create({
      storageDir,
      workspaceRoot: workspaceDir,
      initialBackendMode: 'local',
    });

    const createResp = await bridge1.handleWebviewMessage({
      category: 'request',
      type: 'session.create',
      requestId: 'req_create_1',
      payload: {
        title: 'Persistence Test',
        prompt: '读取 sample.ts',
        executionMode: 'auto',
      },
    });

    expect(createResp.ok).toBe(true);
    const { sessionId } = createResp.data as { sessionId: string };

    // Verify PoC-L1 files on disk
    const manifestFile = path.join(storageDir, 'sessions', sessionId, 'manifest.json');
    const messagesFile = path.join(storageDir, 'sessions', sessionId, 'messages.json');
    const diskMessages = JSON.parse(await fs.readFile(messagesFile, 'utf-8'));
    expect(diskMessages.length).toBe(2);
    expect(diskMessages[1].toolCalls?.[0]?.toolName).toBe('read-file');
    expect(diskMessages[1].toolCalls?.[0]?.status).toBe('completed');
    expect((await fs.stat(manifestFile)).size).toBeGreaterThan(20);

    // Tear down Instance 1 (simulate Extension Host restart)
    await bridge1.dispose();

    // Create brand-new Instance 2 (PoC-L2)
    const bridge2 = await AgentClientBridge.create({
      storageDir,
      workspaceRoot: workspaceDir,
      initialBackendMode: 'local',
    });

    const listResp = await bridge2.handleWebviewMessage({
      category: 'request',
      type: 'session.list',
      requestId: 'req_list_2',
      payload: {},
    });
    expect(listResp.ok).toBe(true);
    const sessions = listResp.data as any[];
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe(sessionId);

    const resumeResp = await bridge2.handleWebviewMessage({
      category: 'resume',
      sessionId,
      lastSequence: 0,
    });
    expect(resumeResp.ok).toBe(true);
    const resumed = resumeResp.data as any;
    expect(resumed.recoveredAcrossInstanceRestart).toBe(true);
    expect(resumed.messages.length).toBe(2);

    await bridge2.dispose();
  }, 20000);

  it('Enforces human-in-the-loop approval for file writes and supports Diff review', async () => {
    const bridge = await AgentClientBridge.create({
      storageDir,
      workspaceRoot: workspaceDir,
      initialBackendMode: 'local',
    });

    const events: EventMessage[] = [];
    bridge.attachWebview('main-webview', (ev) => {
      events.push(ev);
      if (ev.type === 'approval.requested') {
        const approvalId = ev.payload.approvalId as string;
        setTimeout(() => {
          bridge.approvalBridge.respond(approvalId, true, 'Looks safe');
        }, 15);
      }
    });

    const created = await bridge.sessionBridge.createSession({
      title: 'Write & Diff Test',
      workspaceRoot: workspaceDir,
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      executionMode: 'manual',
    });

    const msg = await bridge.sessionBridge.sendPrompt({
      sessionId: created.sessionId,
      prompt: '写入 sample.ts: export const version = "1.1.0";\n',
      executionMode: 'manual',
    });

    expect(msg.diffIds?.length).toBe(1);
    expect(events.some((e) => e.type === 'approval.requested')).toBe(true);
    expect(events.some((e) => e.type === 'approval.resolved')).toBe(true);
    expect(events.some((e) => e.type === 'diff.proposed')).toBe(true);

    const updatedContent = await fs.readFile(path.join(workspaceDir, 'sample.ts'), 'utf-8');
    expect(updatedContent).toContain('1.1.0');

    await bridge.dispose();
  });

  it('Blocks path traversal, blocks mutations in Plan mode, and redacts API keys', async () => {
    const checkTraversal = validateWorkspacePath('../../etc/passwd', workspaceDir);
    expect(checkTraversal.valid).toBe(false);
    expect(checkTraversal.reason).toContain('outside workspace root');

    const redacted = redactSensitiveText(
      'Error with key sk-1234567890abcdef123456 and Authorization: Bearer secret_token_999'
    );
    expect(redacted).not.toContain('sk-1234567890abcdef123456');
    expect(redacted).not.toContain('secret_token_999');
    expect(redacted).toContain('***REDACTED***');

    const sanitizedObj = sanitizeObjectForLog({
      providerId: 'deepseek',
      apiKey: 'sk-super-secret-value-12345678',
      nested: { token: 'tok_abcdef123456' },
    });
    expect(sanitizedObj.apiKey).toBe('***REDACTED***');
    expect(sanitizedObj.nested.token).toBe('***REDACTED***');

    const bridge = await AgentClientBridge.create({
      storageDir,
      workspaceRoot: workspaceDir,
    });

    const denyResp = await bridge.handleWebviewMessage({
      category: 'request',
      type: 'capability.invoke',
      requestId: 'req_plan_write',
      payload: {
        capability: 'write-file',
        executionMode: 'plan',
        params: { filePath: 'sample.ts', content: 'blocked' },
      },
    });
    expect(denyResp.ok).toBe(false);
    expect(denyResp.error?.code).toBe('POLICY_DENIED');

    await bridge.dispose();
  });

  it('Handles Webview close/reopen without duplicate subscriptions and rejects duplicate requestIds', async () => {
    const bridge = await AgentClientBridge.create({
      storageDir,
      workspaceRoot: workspaceDir,
    });

    let receivedCount = 0;
    // Attach same webviewId twice (simulating Webview close & reopen)
    bridge.attachWebview('webview-panel-1', () => {
      receivedCount++;
    });
    bridge.attachWebview('webview-panel-1', () => {
      receivedCount++;
    });

    expect(bridge.eventBridge.getActiveSubscriberCount()).toBe(1);
    bridge.eventBridge.emit('sess_1', 'assistant.text.delta', { delta: 'hello' });
    expect(receivedCount).toBe(1);

    // Duplicate requestId test
    const first = await bridge.handleWebviewMessage({
      category: 'request',
      type: 'session.list',
      requestId: 'dup_req_001',
      payload: {},
    });
    expect(first.ok).toBe(true);

    const second = await bridge.handleWebviewMessage({
      category: 'request',
      type: 'session.list',
      requestId: 'dup_req_001',
      payload: {},
    });
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('DUPLICATE_REQUEST_ID');

    await bridge.dispose();
  });

  it('Verifies BackendManager auto fallback and MinimalHubServer capability routing', async () => {
    const bm = new BackendManager({
      initialMode: 'auto',
      hubEndpoint: 'ws://127.0.0.1:59998',
    });
    const fallbackDiag = await bm.resolveBackend('auto');
    expect(fallbackDiag.effectiveMode).toBe('local');
    expect(fallbackDiag.fallbackTriggered).toBe(true);

    const hub = new MinimalHubServer();
    const { endpoint } = await hub.start(0);
    const connectedDiag = await bm.resolveBackend('auto', endpoint);
    expect(connectedDiag.effectiveMode).toBe('hub');
    expect(connectedDiag.hubReachable).toBe(true);
    await hub.stop();
  });

  it('Verifies ProviderManager DeepSeek default and OpenAI-compatible smoke tests', async () => {
    const pm = new ProviderManager();
    const active = await pm.getActiveProviderWithKeyStatus();
    expect(active.provider.providerId).toBe('deepseek');
    expect(active.model.modelId).toBe('deepseek-chat');

    const smoke = await pm.runSmokeTest({
      providerId: 'openai-compatible',
      customFetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
          status: 200,
        }),
    });
    expect(smoke.ok).toBe(true);
  });

  it('Executes multi-step autonomous coding via @cline/sdk Agent + createBuiltinTools + CapabilityRegistry', async () => {
    const sdkReport = await RuntimeFactory.verifyLockedSdk();
    expect(sdkReport.sdkModuleImportable).toBe(true);
    expect(sdkReport.exportedSymbols).toContain('Agent');
    expect(sdkReport.exportedSymbols).toContain('createBuiltinTools');

    let turnCount = 0;
    const mockLlmServer = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      const parsed = JSON.parse(body || '{}');
      turnCount++;

      res.setHeader('Content-Type', 'application/json');
      if (turnCount === 1) {
        // Turn 1: @cline/sdk Agent calls builtin `editor` tool (str_replace) on sample.ts
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '正在通过 @cline/sdk 内置 editor 工具升级版本号...',
                  tool_calls: [
                    {
                      id: 'call_cline_editor_1',
                      type: 'function',
                      function: {
                        name: 'editor',
                        arguments: JSON.stringify({
                          path: 'sample.ts',
                          old_text: '1.0.0',
                          new_text: '2.0.0-cline-sdk',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 45 },
          })
        );
      } else {
        // Turn 2: Verify tool result was fed back into @cline/sdk Agent transcript
        const hasToolMsg = (parsed.messages ?? []).some((m: any) => m.role === 'tool');
        expect(hasToolMsg).toBe(true);
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '已通过 @cline/sdk Agent 完成 sample.ts 的版本升级（2.0.0-cline-sdk）。',
                },
              },
            ],
            usage: { prompt_tokens: 180, completion_tokens: 30 },
          })
        );
      }
    });

    await new Promise<void>((resolve) => mockLlmServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockLlmServer.address() as { port: number };
    const mockEndpoint = `http://127.0.0.1:${addr.port}/v1`;

    try {
      const bridge = await AgentClientBridge.create({
        storageDir,
        workspaceRoot: workspaceDir,
        initialBackendMode: 'local',
      });

      await bridge.providerManager.configureProvider({
        providerId: 'deepseek',
        apiEndpoint: mockEndpoint,
        modelId: 'deepseek-chat',
        apiKey: 'sk-test-cline-sdk-key',
      });

      const created = await bridge.sessionBridge.createSession({
        title: 'Cline SDK Agent Test',
        workspaceRoot: workspaceDir,
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        executionMode: 'auto',
      });

      const assistantMsg = await bridge.sessionBridge.sendPrompt({
        sessionId: created.sessionId,
        prompt: '请使用 editor 工具把 sample.ts 的版本改为 2.0.0-cline-sdk',
        executionMode: 'auto',
      });

      expect(turnCount).toBe(2);
      expect(assistantMsg.content).toContain('2.0.0-cline-sdk');
      expect(assistantMsg.diffIds?.length).toBe(1);

      const updatedDisk = await fs.readFile(path.join(workspaceDir, 'sample.ts'), 'utf-8');
      expect(updatedDisk).toContain('2.0.0-cline-sdk');

      await bridge.dispose();
    } finally {
      await new Promise<void>((resolve) => mockLlmServer.close(() => resolve()));
    }
  }, 25000);

  it('Antigravity Scientific Debugging Engine: parallel read-only tools, outline_file, and post-edit mandatory build verification guardrail', async () => {
    await fs.writeFile(
      path.join(workspaceDir, 'enqueue.cc'),
      [
        '#include <cstdio>',
        'struct ncclComm {',
        '  int rank;',
        '  void* stream;',
        '};',
        'static int scheduleP2pTasksToPlan(struct ncclComm* comm) {',
        '  return 1;',
        '}',
      ].join('\n'),
      'utf-8'
    );

    let llmCalls = 0;
    const mockLlmServer = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      llmCalls++;
      res.setHeader('Content-Type', 'application/json');

      if (llmCalls === 1) {
        // Turn 1: Parallel batch of outline_file + search_codebase
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tc_outline_1',
                      type: 'function',
                      function: {
                        name: 'outline_file',
                        arguments: JSON.stringify({ filePath: 'enqueue.cc' }),
                      },
                    },
                    {
                      id: 'tc_search_1',
                      type: 'function',
                      function: {
                        name: 'search_codebase',
                        arguments: JSON.stringify({ query: 'ncclComm', context_lines: 2 }),
                      },
                    },
                  ],
                },
              },
            ],
          })
        );
      } else if (llmCalls === 2) {
        // Turn 2: Edit enqueue.cc (C++ file)
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tc_edit_cpp_1',
                      type: 'function',
                      function: {
                        name: 'edit_file',
                        arguments: JSON.stringify({
                          filePath: 'enqueue.cc',
                          oldText: 'return 1;',
                          newText: 'return 0;',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })
        );
      } else if (llmCalls === 3) {
        // Turn 3: Model tries to stop prematurely after editing .cc without running build!
        // The Antigravity Post-Edit Guardrail will intercept this and immediately issue Call 4.
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '已修改 enqueue.cc，请确认是否现在编译？',
                },
              },
            ],
          })
        );
      } else if (llmCalls === 4) {
        // Turn 4 (triggered by Guardrail nudge): Model runs build/verification command
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tc_build_1',
                      type: 'function',
                      function: {
                        name: 'run_command',
                        arguments: JSON.stringify({ command: 'echo "make -j16: build OK"' }),
                      },
                    },
                  ],
                },
              },
            ],
          })
        );
      } else {
        // Turn 5: Final verified response
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '## ✅ 已自动修复并验证的问题清单\n- `enqueue.cc`: 修复返回值并通过编译验证（exitCode=0）。',
                },
              },
            ],
          })
        );
      }
    });

    await new Promise<void>((resolve) => mockLlmServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockLlmServer.address() as { port: number };
    const mockEndpoint = `http://127.0.0.1:${addr.port}/v1`;

    try {
      const bridge = await AgentClientBridge.create({
        storageDir,
        workspaceRoot: workspaceDir,
        initialBackendMode: 'local',
      });

      await bridge.providerManager.configureProvider({
        providerId: 'deepseek',
        apiEndpoint: mockEndpoint,
        modelId: 'deepseek-chat',
        apiKey: 'sk-test-antigravity-engine',
      });

      const created = await bridge.sessionBridge.createSession({
        title: 'Antigravity Engine Test',
        workspaceRoot: workspaceDir,
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        executionMode: 'auto',
      });

      const assistantMsg = await bridge.sessionBridge.sendPrompt({
        sessionId: created.sessionId,
        prompt: '排查并修复 enqueue.cc 中的返回值问题',
        executionMode: 'auto',
      });

      expect(llmCalls).toBe(5);
      expect(assistantMsg.content).toContain('已自动修复并验证');
      const finalCpp = await fs.readFile(path.join(workspaceDir, 'enqueue.cc'), 'utf-8');
      expect(finalCpp).toContain('return 0;');

      await bridge.dispose();
    } finally {
      await new Promise<void>((resolve) => mockLlmServer.close(() => resolve()));
    }
  }, 25000);

  it('prevents duplicate read-only tool calls across turns and persists onBeforeFinish nudges in conversation history', async () => {
    const http = await import('node:http');
    await fs.writeFile(
      path.join(workspaceDir, 'common_kernel.h'),
      'template<typename T>\nvoid reduceCopy(int nBytesAhead) {\n#if 0\n  if (nBytesAhead == 0) return;\n#endif\n}\n',
      'utf-8'
    );

    let llmCalls = 0;
    let secondTurnMessages: any[] = [];
    const mockLlmServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      llmCalls += 1;
      res.setHeader('Content-Type', 'application/json');

      if (llmCalls === 1) {
        // Turn 1: Model calls two identical read_file calls in the same turn
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tc_dup_1',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ filePath: 'common_kernel.h' }),
                      },
                    },
                    {
                      id: 'tc_dup_2',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ filePath: 'common_kernel.h' }),
                      },
                    },
                  ],
                },
              },
            ],
          })
        );
      } else if (llmCalls === 2) {
        secondTurnMessages = body.messages || [];
        // Turn 2: Model outputs a modification plan asking user to run grep without editing files
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '### 改动 1：修复 common_kernel.h\n请先执行 grep 命令确认，需要我现在执行吗？',
                },
              },
            ],
          })
        );
      } else {
        // Turn 3: Model receives persistent onBeforeFinish prompt in body.messages and completes response
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '## ✅ 已完成 common_kernel.h 尾包拷贝分支分析',
                },
              },
            ],
          })
        );
      }
    });

    await new Promise<void>((resolve) => mockLlmServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockLlmServer.address() as { port: number };
    const mockEndpoint = `http://127.0.0.1:${addr.port}/v1`;

    try {
      const bridge = await AgentClientBridge.create({
        storageDir,
        workspaceRoot: workspaceDir,
        initialBackendMode: 'local',
      });

      await bridge.providerManager.configureProvider({
        providerId: 'deepseek',
        apiEndpoint: mockEndpoint,
        modelId: 'deepseek-chat',
        apiKey: 'sk-test-dedup-engine',
      });

      const created = await bridge.sessionBridge.createSession({
        title: 'Dedup & Persistent Nudge Test',
        workspaceRoot: workspaceDir,
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        executionMode: 'auto',
      });

      const assistantMsg = await bridge.sessionBridge.sendPrompt({
        sessionId: created.sessionId,
        prompt: '检查 common_kernel.h 的 #if 0 问题',
        executionMode: 'auto',
      });

      expect(llmCalls).toBe(3);
      const toolOutputs = secondTurnMessages.filter((m) => m.role === 'tool');
      // Intra-turn duplicate read_file was automatically deduplicated from 2 calls down to 1!
      expect(toolOutputs.length).toBe(1);
      expect(assistantMsg.content).toContain('已完成 common_kernel.h 尾包拷贝分支分析');

      await bridge.dispose();
    } finally {
      await new Promise<void>((resolve) => mockLlmServer.close(() => resolve()));
    }
  }, 25000);

  it('supports deepseek-reasoner reasoning_content across tool calls and auto-expands partial sed -n reads', async () => {
    const http = await import('node:http');
    await fs.writeFile(
      path.join(workspaceDir, 'common_kernel.h'),
      [
        'void reduceCopy(int nBytesAhead) {',
        '  if (nBytesAhead == 0) return;',
        '// FIXME: workaround',
        '#if 0',
        '  reduceCopyPacks_tail(nBytesAhead);',
        '#endif',
        '}',
      ].join('\n'),
      'utf-8'
    );

    let llmCalls = 0;
    let turn2RequestBody: any = null;
    const mockLlmServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      llmCalls += 1;
      res.setHeader('Content-Type', 'application/json');

      if (llmCalls === 1) {
        // Turn 1: deepseek-reasoner emits reasoning_content + partial sed -n '1,3p' common_kernel.h
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  reasoning_content: '4B and 8B are < 16B (BigPackSize). Checking reduceCopy in common_kernel.h.',
                  tool_calls: [
                    {
                      id: 'tc_r1_1',
                      type: 'function',
                      function: {
                        name: 'run_command',
                        arguments: JSON.stringify({
                          command: `echo "1: void reduceCopy" && rem sed -n '1,3p' common_kernel.h`,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })
        );
      } else {
        turn2RequestBody = body;
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  reasoning_content: 'Saw auto-expanded lines 4..7 with #if 0 around reduceCopyPacks_tail!',
                  content: '## ✅ 已通过 deepseek-reasoner 定位到 #if 0 尾包分支问题',
                },
              },
            ],
          })
        );
      }
    });

    await new Promise<void>((resolve) => mockLlmServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockLlmServer.address() as { port: number };
    const mockEndpoint = `http://127.0.0.1:${addr.port}/v1`;

    try {
      const bridge = await AgentClientBridge.create({
        storageDir,
        workspaceRoot: workspaceDir,
        initialBackendMode: 'local',
      });

      await bridge.providerManager.configureProvider({
        providerId: 'deepseek',
        apiEndpoint: mockEndpoint,
        modelId: 'deepseek-chat',
        apiKey: 'sk-test-r1-engine',
      });

      const created = await bridge.sessionBridge.createSession({
        title: 'DeepSeek R1 Test',
        workspaceRoot: workspaceDir,
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        executionMode: 'auto',
      });

      // Dynamically switch to deepseek-reasoner via sendPrompt.modelId
      const assistantMsg = await bridge.sessionBridge.sendPrompt({
        sessionId: created.sessionId,
        prompt: '排查 4B/8B 失败原因',
        executionMode: 'auto',
        modelId: 'deepseek-reasoner',
      });

      expect(llmCalls).toBe(2);
      expect(turn2RequestBody.model).toBe('deepseek-reasoner');
      expect(turn2RequestBody.temperature).toBeUndefined();
      const assistantToolMsg = turn2RequestBody.messages.find(
        (m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls)
      );
      expect(assistantToolMsg.reasoning_content).toContain('BigPackSize');
      const toolResultMsg = turn2RequestBody.messages.find((m: any) => m.role === 'tool');
      expect(toolResultMsg.content).toContain('Function-Completeness Auto-Expand');
      expect(toolResultMsg.content).toContain('reduceCopyPacks_tail');
      expect(assistantMsg.content).toContain('已通过 deepseek-reasoner 定位到 #if 0');

      await bridge.dispose();
    } finally {
      await new Promise<void>((resolve) => mockLlmServer.close(() => resolve()));
    }
  }, 25000);

  it('Verifies Claude Code ported FileStateCache (snapshots + mismatch diagnosis) & GoalSteering (Completion Audit + Multi-Tier Routing)', async () => {
    const {
      FileStateCache,
      createGoalState,
      buildGoalContinuationPrompt,
      resolveTieredModelForTurn,
    } = await import('../src/core/index.js');

    const cache = new FileStateCache();
    const sampleCode = [
      '#include <vector>',
      'void scheduleP2pTasksToPlan() {',
      '  int sendPeer = 0;',
      '  int recvPeer = 0;',
      '  if (sendPeer == comm->rank) {',
      '    return;',
      '  }',
      '}',
    ].join('\n');

    cache.recordRead({
      filePath: 'src\\enqueue.cc',
      content: sampleCode,
      startLine: 1,
      endLine: 8,
    });
    expect(cache.hasRead('src/enqueue.cc')).toBe(true);

    const snap = cache.makeSnapshot('src/enqueue.cc', sampleCode);
    expect(snap.filePath).toBe('src/enqueue.cc');
    expect(cache.getLatestSnapshot('src/enqueue.cc')?.content).toContain('scheduleP2pTasksToPlan');

    const mismatch = cache.diagnoseEditMismatch(
      'src/enqueue.cc',
      sampleCode,
      'if (sendPeer == comm->rank) {\n  wrong_line();\n}'
    );
    expect(mismatch.wasReadPreviously).toBe(true);
    expect(mismatch.hintMessage).toContain('Closest matching lines in');
    expect(mismatch.hintMessage).toContain('5:   if (sendPeer == comm->rank) {');

    const goal = createGoalState('/goal 修复单卡 sendrecv_perf #wrong=1');
    expect(goal.objective).toBe('修复单卡 sendrecv_perf #wrong=1');
    const contPrompt = buildGoalContinuationPrompt(goal, '尚未执行编译验证');
    expect(contPrompt).toContain('<goal-steering type="continuation">');
    expect(contPrompt).toContain('Strict Completion Audit');

    // Phase 1: Turn 1 file discovery before any files are read -> automatically uses fast deepseek-chat
    const turn1Discovery = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-auto',
      providerId: 'deepseek',
      userPrompt: 'sendrecv_perf -b 4 -e 32 -f 2 还是不对，分析一下根因',
      turnIndex: 1,
      selfHealCount: 0,
      hasReadFiles: false,
      hasEditedFiles: false,
    });
    expect(turn1Discovery.effectiveModelId).toBe('deepseek-chat');
    expect(turn1Discovery.tier).toBe('fast-tool');

    // Phase 2: Turn 2 root-cause diagnosis once source files are read into context -> automatically promotes to deepseek-reasoner
    const turn2Diagnosis = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-chat',
      providerId: 'deepseek',
      userPrompt: 'sendrecv_perf -b 4 -e 32 -f 2 还是不对，分析一下根因',
      turnIndex: 2,
      selfHealCount: 0,
      hasReadFiles: true,
      hasEditedFiles: false,
    });
    expect(turn2Diagnosis.effectiveModelId).toBe('deepseek-reasoner');
    expect(turn2Diagnosis.tier).toBe('deep-reasoner');

    // Phase 3: Turn 3 post-edit compilation & test verification -> automatically uses fast deepseek-chat
    const turn3Verify = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-reasoner',
      providerId: 'deepseek',
      userPrompt: 'sendrecv_perf -b 4 -e 32 -f 2 还是不对，分析一下根因',
      turnIndex: 3,
      selfHealCount: 0,
      hasReadFiles: true,
      hasEditedFiles: true,
      hasBuildOrTestFailure: false,
    });
    expect(turn3Verify.effectiveModelId).toBe('deepseek-chat');
    expect(turn3Verify.tier).toBe('fast-tool');

    // Phase 4: Self-heal turn when build or test fails -> automatically promotes to deepseek-reasoner
    const turn4SelfHeal = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-chat',
      providerId: 'deepseek',
      userPrompt: '修复编译问题',
      turnIndex: 4,
      selfHealCount: 1,
      hasReadFiles: true,
      hasEditedFiles: true,
      hasBuildOrTestFailure: true,
    });
    expect(turn4SelfHeal.effectiveModelId).toBe('deepseek-reasoner');
    expect(turn4SelfHeal.tier).toBe('deep-reasoner');

    // Smart Intent Classifier: distinguishes query-only vs auto-action
    const { classifyPromptIntent } = await import('../src/core/index.js');
    const queryIntent = classifyPromptIntent('帮我分析一下 scheduleP2pTasksToPlan 的流程是什么？');
    expect(queryIntent.intent).toBe('query-only');
    expect(queryIntent.allowFileMutations).toBe(false);

    const fixIntent = classifyPromptIntent('帮我修复 sendrecv_perf 单卡 #wrong=1 的问题并编译验证');
    expect(fixIntent.intent).toBe('auto-action');
    expect(fixIntent.allowFileMutations).toBe(true);
  });

  it('Verifies autonomous browser_action tool execution and /browser workflow expansion', async () => {
    const { expandSlashCommandPrompt, createToolPoliciesWithPreset } = await import(
      '../src/core/index.js'
    );
    const promptRes = expandSlashCommandPrompt(
      '/browser http://localhost:3000/ Verify dashboard rendering and DOM buttons'
    );
    expect(promptRes.slashCommand).toBe('/browser');
    expect(promptRes.suggestedMode).toBe('auto');
    expect(promptRes.expandedPrompt).toContain('[Antigravity /browser Autonomous Web Inspection]');
    expect(promptRes.expandedPrompt).toContain('http://localhost:3000/');
    expect(promptRes.expandedPrompt).toContain('browser_action');

    const policies = createToolPoliciesWithPreset('default');
    expect(policies.browser_action).toBe('allow');

    // Test autonomous HTTP DOM inspection via mock server
    const mockHttp = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>DeepAutoCode Web Preview</title></head>
          <body>
            <h1>Welcome to App</h1>
            <button id="cta-btn">Get Started</button>
            <a href="/docs">Documentation</a>
          </body>
        </html>
      `);
    });

    await new Promise<void>((resolve) => mockHttp.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockHttp.address() as any).port;

    try {
      let turnCount = 0;
      const mockLlm = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        turnCount++;
        res.setHeader('Content-Type', 'application/json');
        if (turnCount === 1) {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: 'tc_browser_1',
                        type: 'function',
                        function: {
                          name: 'browser_action',
                          arguments: JSON.stringify({
                            action: 'inspect_elements',
                            url: `http://127.0.0.1:${port}/`,
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            })
          );
        } else {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '## ✅ Autonomous browser inspection complete: verified page title and buttons.',
                  },
                },
              ],
            })
          );
        }
      });
      await new Promise<void>((resolve) => mockLlm.listen(0, '127.0.0.1', () => resolve()));
      const llmPort = (mockLlm.address() as any).port;

      try {
        const bridge = await AgentClientBridge.create({
          storageDir,
          workspaceRoot: workspaceDir,
          initialBackendMode: 'local',
        });
        await bridge.providerManager.configureProvider({
          providerId: 'deepseek',
          apiEndpoint: `http://127.0.0.1:${llmPort}/v1`,
          modelId: 'deepseek-chat',
          apiKey: 'sk-test-browser-key',
        });
        const created = await bridge.sessionBridge.createSession({
          title: 'Browser Action Test',
          workspaceRoot: workspaceDir,
          providerId: 'deepseek',
          modelId: 'deepseek-chat',
          executionMode: 'auto',
        });
        const assistantMsg = await bridge.sessionBridge.sendPrompt({
          sessionId: created.sessionId,
          prompt: `/browser http://127.0.0.1:${port}/ Verify dashboard`,
          executionMode: 'auto',
        });
        expect(turnCount).toBe(2);
        expect(assistantMsg.content).toContain('Autonomous browser inspection complete');
        await bridge.dispose();
      } finally {
        await new Promise<void>((resolve) => mockLlm.close(() => resolve()));
      }
    } finally {
      await new Promise<void>((resolve) => mockHttp.close(() => resolve()));
    }
  }, 25000);
});
