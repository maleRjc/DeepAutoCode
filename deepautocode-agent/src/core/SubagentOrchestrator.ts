import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureAgentWorktree } from './WorkspaceSafety.js';

export interface SubagentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  enableWriteTools?: boolean;
  enableMcpTools?: boolean;
  enableSubagentTools?: boolean;
  source?: 'builtin' | 'dynamic' | 'workspace' | 'plugin';
}

export type SubagentWorkspaceMode = 'inherit' | 'branch' | 'share';
export type SubagentModelTier = 'inherit' | 'flash_lite' | 'flash' | 'pro';
export type SubagentRunState = 'running' | 'completed' | 'failed' | 'killed';

export interface SubagentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  createdAt: string;
}

export interface SubagentInstanceSnapshot {
  conversationId: string;
  parentSessionId: string;
  typeName: string;
  role: string;
  model: SubagentModelTier;
  workspaceMode: SubagentWorkspaceMode;
  workspacePath: string;
  worktreeBranch?: string;
  state: SubagentRunState;
  prompt: string;
  startedAt: string;
  endedAt?: string;
  resultSummary?: string;
  error?: string;
  messages: SubagentMessage[];
}

export interface SystemWakeupNotification {
  id: string;
  sessionId: string;
  sender: string;
  priority: 'HIGH' | 'NORMAL';
  content: string;
  createdAt: string;
}

interface SubagentInternalInstance {
  snapshot: SubagentInstanceSnapshot;
  abortController: AbortController;
  cleanupWorktree?: () => Promise<void>;
}

/**
 * Antigravity-style Multi-Agent Orchestrator & Reactive Wakeup Bus.
 * Supports:
 * - `define_subagent` (dynamic in-conversation definitions + `.agents/agents/*.md` discovery)
 * - `invoke_subagent` (sync or background async execution, `inherit` | `branch` | `share` Git worktree isolation)
 * - `manage_subagents` (`list` | `kill` | `kill_all`)
 * - `send_message` (inter-agent messaging)
 * - Reactive Wakeup queue for `<SYSTEM_MESSAGE>` notifications when background subagents/tasks/timers finish.
 */
export class SubagentOrchestrator {
  private readonly definitions = new Map<string, SubagentDefinition>();
  private readonly instances = new Map<string, SubagentInternalInstance>();
  private readonly wakeupQueue = new Map<string, SystemWakeupNotification[]>();
  private readonly wakeupListeners = new Set<(notif: SystemWakeupNotification) => void>();
  private counter = 0;

  constructor() {
    this.registerBuiltinDefinitions();
  }

  private registerBuiltinDefinitions(): void {
    const builtins: SubagentDefinition[] = [
      {
        name: 'self',
        description:
          "Subagent that inherits the parent agent's full configuration including tools, system prompt, and model.",
        systemPrompt:
          'You are an autonomous subagent with full engineering capabilities. Complete the delegated task thoroughly and return a concise, evidence-backed summary.',
        enableWriteTools: true,
        enableMcpTools: true,
        enableSubagentTools: false,
        source: 'builtin',
      },
      {
        name: 'research',
        description:
          'Read-only codebase researcher for multi-round symbol search, file reading, and architecture exploration.',
        systemPrompt:
          'You are a read-only Codebase Research Subagent. Gather exact file:line citations and architectural relationships without mutating any files.',
        enableWriteTools: false,
        enableMcpTools: false,
        enableSubagentTools: false,
        source: 'builtin',
      },
      {
        name: 'planner',
        description:
          'Architectural planner that inspects dependencies and produces a step-by-step implementation & verification plan.',
        systemPrompt:
          'You are an Architectural Planner Subagent. Analyze target files, boundary conditions, and test requirements to produce an actionable implementation plan.',
        enableWriteTools: false,
        enableMcpTools: false,
        enableSubagentTools: false,
        source: 'builtin',
      },
      {
        name: 'editor',
        description:
          'Surgical code editor subagent that applies isolated changes and runs post-edit diagnostics.',
        systemPrompt:
          'You are a Surgical Code Editor Subagent. Apply minimal, accurate edits to the specified files and verify syntax/diagnostics.',
        enableWriteTools: true,
        enableMcpTools: false,
        enableSubagentTools: false,
        source: 'builtin',
      },
      {
        name: 'verifier',
        description:
          'Verification subagent that runs compiler diagnostics and test suites on modified files.',
        systemPrompt:
          'You are a Verification Subagent. Run diagnostics and verification checks and report pass/fail details.',
        enableWriteTools: false,
        enableMcpTools: false,
        enableSubagentTools: false,
        source: 'builtin',
      },
      {
        name: 'image-generator',
        description:
          'Generates or edits visual assets (SVG diagrams, UI mockups, icons, HTML/Canvas visuals) from a brief and replies with the saved file paths.',
        systemPrompt:
          'You are an Image & Visual Asset Generator Subagent. Generate clean, self-contained SVG or visual asset files using write_file or edit_file according to the brief, and reply with the exact saved file paths so the parent agent can embed them.',
        enableWriteTools: true,
        enableMcpTools: false,
        enableSubagentTools: false,
        source: 'builtin',
      },
    ];
    for (const def of builtins) {
      this.definitions.set(def.name.toLowerCase(), def);
    }
  }

  public defineSubagent(def: SubagentDefinition): SubagentDefinition {
    const key = String(def.name || '')
      .trim()
      .toLowerCase();
    if (!key) {
      throw new Error('Subagent name is required');
    }
    const normalized: SubagentDefinition = {
      name: key,
      description: String(def.description || '').trim() || `Custom subagent ${key}`,
      systemPrompt: String(def.systemPrompt || '').trim(),
      enableWriteTools: Boolean(def.enableWriteTools),
      enableMcpTools: Boolean(def.enableMcpTools),
      enableSubagentTools: Boolean(def.enableSubagentTools),
      source: def.source || 'dynamic',
    };
    this.definitions.set(key, normalized);
    return normalized;
  }

  public getDefinition(name: string): SubagentDefinition | undefined {
    return this.definitions.get(String(name || '').trim().toLowerCase());
  }

  public listDefinitions(): SubagentDefinition[] {
    return [...this.definitions.values()];
  }

  /**
   * Discover declarative subagents from `.agents/agents/*.md` and `.deepautocode/agents/*.md`.
   */
  public async loadWorkspaceSubagents(workspaceRoot: string): Promise<SubagentDefinition[]> {
    const loaded: SubagentDefinition[] = [];
    const dirs = [
      path.join(workspaceRoot, '.agents', 'agents'),
      path.join(workspaceRoot, '.deepautocode', 'agents'),
    ];
    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !/\.(md|json)$/i.test(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          const raw = await fs.readFile(fullPath, 'utf-8');
          if (entry.name.endsWith('.json')) {
            const parsed = JSON.parse(raw);
            if (parsed?.name && parsed?.systemPrompt) {
              const def = this.defineSubagent({
                name: String(parsed.name),
                description: String(parsed.description || parsed.name),
                systemPrompt: String(parsed.systemPrompt),
                enableWriteTools: Boolean(parsed.enableWriteTools ?? true),
                enableMcpTools: Boolean(parsed.enableMcpTools),
                enableSubagentTools: Boolean(parsed.enableSubagentTools),
                source: 'workspace',
              });
              loaded.push(def);
            }
          } else {
            const nameBase = entry.name.replace(/\.md$/i, '');
            const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
            const fm = fmMatch ? fmMatch[1] : '';
            const body = fmMatch ? fmMatch[2] : raw;
            const descMatch = fm.match(/^\s*description:\s*(.+)$/im);
            const writeMatch = fm.match(/^\s*enableWriteTools:\s*(true|false)$/im);
            const def = this.defineSubagent({
              name: nameBase,
              description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : `Workspace agent ${nameBase}`,
              systemPrompt: body.trim(),
              enableWriteTools: writeMatch ? writeMatch[1].toLowerCase() === 'true' : true,
              source: 'workspace',
            });
            loaded.push(def);
          }
        }
      } catch {
        // ignore missing directory
      }
    }
    return loaded;
  }

  public async spawnSubagent(params: {
    parentSessionId: string;
    typeName: string;
    role?: string;
    prompt: string;
    model?: SubagentModelTier;
    workspaceMode?: SubagentWorkspaceMode;
    workspaceRoot: string;
    runInBackground?: boolean;
    executor: (ctx: {
      conversationId: string;
      definition: SubagentDefinition;
      workspacePath: string;
      signal: AbortSignal;
      getInboxMessages: () => SubagentMessage[];
    }) => Promise<string>;
  }): Promise<{
    conversationId: string;
    asyncLaunched: boolean;
    snapshot: SubagentInstanceSnapshot;
    result?: string;
  }> {
    const typeKey = String(params.typeName || 'research').trim().toLowerCase();
    const definition =
      this.definitions.get(typeKey) ||
      this.definitions.get('research')!;
    const conversationId = `sub_${Date.now().toString(36)}_${++this.counter}`;
    const workspaceMode: SubagentWorkspaceMode = params.workspaceMode || 'inherit';
    const model: SubagentModelTier = params.model || 'inherit';

    let effectiveWorkspacePath = params.workspaceRoot;
    let worktreeBranch: string | undefined;
    let cleanupWorktree: (() => Promise<void>) | undefined;

    if (workspaceMode === 'branch' || workspaceMode === 'share') {
      try {
        const wt = await ensureAgentWorktree({
          workspaceRoot: params.workspaceRoot,
          sessionId: conversationId,
        });
        if (wt.enabled && wt.worktreePath) {
          effectiveWorkspacePath = wt.worktreePath;
          worktreeBranch = wt.branch;
        }
      } catch {
        effectiveWorkspacePath = params.workspaceRoot;
      }
    }

    const abortController = new AbortController();
    const snapshot: SubagentInstanceSnapshot = {
      conversationId,
      parentSessionId: params.parentSessionId,
      typeName: definition.name,
      role: params.role || definition.description.slice(0, 48),
      model,
      workspaceMode,
      workspacePath: effectiveWorkspacePath,
      worktreeBranch,
      state: 'running',
      prompt: params.prompt,
      startedAt: new Date().toISOString(),
      messages: [],
    };

    const internal: SubagentInternalInstance = {
      snapshot,
      abortController,
      cleanupWorktree,
    };
    this.instances.set(conversationId, internal);

    const runPromise = (async () => {
      try {
        const output = await params.executor({
          conversationId,
          definition,
          workspacePath: effectiveWorkspacePath,
          signal: abortController.signal,
          getInboxMessages: () => [...snapshot.messages],
        });
        if (snapshot.state === 'running') {
          snapshot.state = 'completed';
          snapshot.endedAt = new Date().toISOString();
          snapshot.resultSummary = String(output || '').slice(0, 8000);
          this.enqueueWakeup({
            sessionId: params.parentSessionId,
            sender: conversationId,
            priority: 'HIGH',
            content: `Subagent "${snapshot.role}" (${conversationId}, type=${snapshot.typeName}${worktreeBranch ? `, branch=${worktreeBranch}` : ''}) completed:\n${snapshot.resultSummary}`,
          });
        }
        return output;
      } catch (err) {
        if (snapshot.state === 'running') {
          snapshot.state = abortController.signal.aborted ? 'killed' : 'failed';
          snapshot.endedAt = new Date().toISOString();
          snapshot.error = (err as Error).message || String(err);
          this.enqueueWakeup({
            sessionId: params.parentSessionId,
            sender: conversationId,
            priority: 'HIGH',
            content: `Subagent "${snapshot.role}" (${conversationId}) ${snapshot.state}: ${snapshot.error}`,
          });
        }
        throw err;
      }
    })();

    if (params.runInBackground) {
      void runPromise.catch(() => undefined);
      return {
        conversationId,
        asyncLaunched: true,
        snapshot: { ...snapshot, messages: [...snapshot.messages] },
      };
    }

    const finalOutput = await runPromise;
    return {
      conversationId,
      asyncLaunched: false,
      snapshot: { ...snapshot, messages: [...snapshot.messages] },
      result: finalOutput,
    };
  }

  public sendMessage(params: {
    fromSessionId: string;
    recipient: string;
    message: string;
  }): { ok: boolean; deliveredTo: string; state?: SubagentRunState; error?: string } {
    const inst = this.instances.get(params.recipient);
    if (!inst) {
      return {
        ok: false,
        deliveredTo: params.recipient,
        error: `Subagent conversationId not found: ${params.recipient}`,
      };
    }
    const msg: SubagentMessage = {
      id: `msg_${Date.now().toString(36)}_${++this.counter}`,
      from: params.fromSessionId,
      to: params.recipient,
      content: String(params.message || ''),
      createdAt: new Date().toISOString(),
    };
    inst.snapshot.messages.push(msg);
    return {
      ok: true,
      deliveredTo: params.recipient,
      state: inst.snapshot.state,
    };
  }

  public listSubagents(parentSessionId?: string): SubagentInstanceSnapshot[] {
    const out: SubagentInstanceSnapshot[] = [];
    for (const inst of this.instances.values()) {
      if (!parentSessionId || inst.snapshot.parentSessionId === parentSessionId) {
        out.push({
          ...inst.snapshot,
          messages: [...inst.snapshot.messages],
        });
      }
    }
    return out;
  }

  public async killSubagents(params: {
    parentSessionId?: string;
    conversationIds?: string[];
    killAll?: boolean;
  }): Promise<{ killedIds: string[] }> {
    const killedIds: string[] = [];
    const targetSet = new Set(params.conversationIds || []);
    for (const [id, inst] of this.instances.entries()) {
      const matchSession =
        !params.parentSessionId || inst.snapshot.parentSessionId === params.parentSessionId;
      if (!matchSession) continue;
      if (params.killAll || targetSet.has(id)) {
        if (inst.snapshot.state === 'running') {
          inst.snapshot.state = 'killed';
          inst.snapshot.endedAt = new Date().toISOString();
          inst.abortController.abort();
          killedIds.push(id);
        }
        if (inst.cleanupWorktree) {
          await inst.cleanupWorktree().catch(() => undefined);
        }
      }
    }
    return { killedIds };
  }

  /**
   * Enqueue a Reactive Wakeup `<SYSTEM_MESSAGE>` notification for a session.
   */
  public enqueueWakeup(params: {
    sessionId: string;
    sender: string;
    priority?: 'HIGH' | 'NORMAL';
    content: string;
  }): SystemWakeupNotification {
    const notif: SystemWakeupNotification = {
      id: `wakeup_${Date.now().toString(36)}_${++this.counter}`,
      sessionId: params.sessionId,
      sender: params.sender,
      priority: params.priority || 'HIGH',
      content: params.content,
      createdAt: new Date().toISOString(),
    };
    const list = this.wakeupQueue.get(params.sessionId) || [];
    list.push(notif);
    this.wakeupQueue.set(params.sessionId, list.slice(-30));
    for (const listener of this.wakeupListeners) {
      try {
        listener(notif);
      } catch {
        // ignore listener error
      }
    }
    return notif;
  }

  /**
   * Drain pending Reactive Wakeup notifications for a session and format them as `<SYSTEM_MESSAGE>` blocks.
   */
  public drainWakeupMessagesForPrompt(sessionId: string): string {
    const list = this.wakeupQueue.get(sessionId);
    if (!list || list.length === 0) return '';
    this.wakeupQueue.delete(sessionId);
    return list
      .map(
        (n) =>
          `<SYSTEM_MESSAGE>\n[Message] timestamp=${n.createdAt} sender=${n.sender} priority=MESSAGE_PRIORITY_${n.priority} content=${n.content}\n</SYSTEM_MESSAGE>`
      )
      .join('\n\n');
  }

  public onWakeup(listener: (notif: SystemWakeupNotification) => void): () => void {
    this.wakeupListeners.add(listener);
    return () => this.wakeupListeners.delete(listener);
  }
}

export const globalSubagentOrchestrator = new SubagentOrchestrator();
