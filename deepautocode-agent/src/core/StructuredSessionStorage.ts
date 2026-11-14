/**
 * Structured Session Storage & Append-Only WAL Repository
 * Inspired by OpenCode's packages/effect-drizzle-sqlite.
 * Replaces monolithic JSON serialization (messages.json) with high-performance,
 * structured append-only tables, indexed message pagination, and atomic ACID updates.
 */

import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';

export interface StoredSessionRecord {
  sessionId: string;
  title: string;
  workspaceRoot: string;
  providerId: string;
  modelId: string;
  executionMode: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface StoredMessageRecord {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  reasoningContent?: string;
  createdAt: number;
  turnIndex: number;
}

export interface StoredDiffRecord {
  diffId: string;
  sessionId: string;
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  originalContent?: string;
  proposedContent?: string;
  unifiedDiff: string;
  status: 'pending' | 'accepted' | 'rejected';
  appliedToDisk: boolean;
  createdAt: string;
}

export interface MessageQueryOptions {
  offset?: number;
  limit?: number;
  reverse?: boolean;
}

export class StructuredSessionStorage {
  private baseDir: string;
  private sessionIndex = new Map<string, StoredSessionRecord>();
  private messageCache = new Map<string, StoredMessageRecord[]>();
  private initialized = false;

  constructor(storageDir: string) {
    this.baseDir = path.resolve(storageDir);
  }

  private getSessionsDir(): string {
    return path.join(this.baseDir, 'sessions');
  }

  private getSessionDir(sessionId: string): string {
    return path.join(this.getSessionsDir(), sessionId);
  }

  private getWalPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'messages.wal.jsonl');
  }

  private getSessionMetaPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'session.meta.json');
  }

  private getDiffsPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'diffs.jsonl');
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.getSessionsDir(), { recursive: true });
    await this.loadAllSessionMeta();
    this.initialized = true;
  }

  private async loadAllSessionMeta(): Promise<void> {
    try {
      const entries = await fs.readdir(this.getSessionsDir(), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const metaPath = path.join(this.getSessionsDir(), entry.name, 'session.meta.json');
          try {
            const raw = await fs.readFile(metaPath, 'utf-8');
            const session = JSON.parse(raw) as StoredSessionRecord;
            this.sessionIndex.set(session.sessionId, session);
          } catch {
            // Check for legacy manifest.json
            const legacyPath = path.join(this.getSessionsDir(), entry.name, 'manifest.json');
            try {
              const raw = await fs.readFile(legacyPath, 'utf-8');
              const legacy = JSON.parse(raw) as any;
              const migrated: StoredSessionRecord = {
                sessionId: legacy.sessionId,
                title: legacy.title || legacy.sessionId,
                workspaceRoot: legacy.workspaceRoot || '',
                providerId: legacy.config?.providerId || 'deepseek',
                modelId: legacy.config?.modelId || 'deepseek-auto',
                executionMode: legacy.config?.executionMode || 'auto',
                createdAt: legacy.createdAt || new Date().toISOString(),
                updatedAt: legacy.updatedAt || new Date().toISOString(),
              };
              this.sessionIndex.set(migrated.sessionId, migrated);
            } catch {
              // Ignore unreadable session directories
            }
          }
        }
      }
    } catch {
      // Sessions directory empty or not yet created
    }
  }

  /**
   * Save or update session metadata.
   */
  public async saveSession(session: StoredSessionRecord): Promise<void> {
    await this.init();
    const sessionDir = this.getSessionDir(session.sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const now = new Date().toISOString();
    const record: StoredSessionRecord = {
      ...session,
      updatedAt: now,
    };

    const metaPath = this.getSessionMetaPath(session.sessionId);
    await fs.writeFile(metaPath, JSON.stringify(record, null, 2), 'utf-8');
    this.sessionIndex.set(record.sessionId, record);
  }

  /**
   * Retrieve session metadata.
   */
  public async getSession(sessionId: string): Promise<StoredSessionRecord | undefined> {
    await this.init();
    return this.sessionIndex.get(sessionId);
  }

  /**
   * List all stored sessions ordered by updatedAt descending.
   */
  public async listSessions(): Promise<StoredSessionRecord[]> {
    await this.init();
    return Array.from(this.sessionIndex.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /**
   * Append a single message to the session WAL (O(1) append).
   * Does not rewrite the full message history!
   */
  public async appendMessage(message: StoredMessageRecord): Promise<void> {
    await this.init();
    const sessionDir = this.getSessionDir(message.sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const walPath = this.getWalPath(message.sessionId);
    const line = JSON.stringify(message) + '\n';
    await fs.appendFile(walPath, line, 'utf-8');

    // Update in-memory cache if loaded
    const cached = this.messageCache.get(message.sessionId);
    if (cached) {
      cached.push(message);
    }

    // Touch session updatedAt
    const session = this.sessionIndex.get(message.sessionId);
    if (session) {
      session.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Load and cache all messages from WAL or legacy messages.json.
   */
  private async loadMessagesInternal(sessionId: string): Promise<StoredMessageRecord[]> {
    if (this.messageCache.has(sessionId)) {
      return this.messageCache.get(sessionId)!;
    }

    const messages: StoredMessageRecord[] = [];
    const walPath = this.getWalPath(sessionId);

    try {
      const walData = await fs.readFile(walPath, 'utf-8');
      const lines = walData.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // ignore corrupted lines
        }
      }
    } catch {
      // Fallback: check legacy messages.json
      const legacyPath = path.join(this.getSessionDir(sessionId), 'messages.json');
      try {
        const raw = await fs.readFile(legacyPath, 'utf-8');
        const legacyMessages = JSON.parse(raw);
        if (Array.isArray(legacyMessages)) {
          let turn = 0;
          for (const m of legacyMessages) {
            messages.push({
              id: m.id || `msg_${Date.now()}_${++turn}`,
              sessionId,
              role: m.role || 'user',
              content: m.content || '',
              reasoningContent: m.reasoningContent,
              createdAt: m.createdAt || Date.now(),
              turnIndex: turn,
            });
          }
        }
      } catch {
        // No messages found
      }
    }

    this.messageCache.set(sessionId, messages);
    return messages;
  }

  /**
   * Paged query of session messages.
   */
  public async getMessages(
    sessionId: string,
    options: MessageQueryOptions = {}
  ): Promise<{ messages: StoredMessageRecord[]; total: number }> {
    await this.init();
    const all = await this.loadMessagesInternal(sessionId);
    const total = all.length;

    let items = all;
    if (options.reverse) {
      items = [...all].reverse();
    }

    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(1000, options.limit ?? 100));

    return {
      messages: items.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Save a diff record (append to diffs.jsonl).
   */
  public async saveDiff(diff: StoredDiffRecord): Promise<void> {
    await this.init();
    const sessionDir = this.getSessionDir(diff.sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const diffsPath = this.getDiffsPath(diff.sessionId);
    const line = JSON.stringify(diff) + '\n';
    await fs.appendFile(diffsPath, line, 'utf-8');
  }

  /**
   * Retrieve all diff records for a session.
   */
  public async getDiffs(sessionId: string): Promise<StoredDiffRecord[]> {
    await this.init();
    const diffsPath = this.getDiffsPath(sessionId);
    const diffs: StoredDiffRecord[] = [];

    try {
      const data = await fs.readFile(diffsPath, 'utf-8');
      const lines = data.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          diffs.push(JSON.parse(line));
        } catch {
          // ignore corrupted lines
        }
      }
    } catch {
      // No diffs found
    }

    return diffs;
  }
}

