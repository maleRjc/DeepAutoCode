import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DiffChangeRecord,
  SessionManifest,
  SessionMessage,
} from '@deepautocode/agent';

/**
 * A DAC session manifest extended with the DeepSeek Harness kernel identity.
 * `dshSessionId` is the session id inside the Harness runtime (DSH_HOME/sessions),
 * kept so a restarted Workbench host can resume the same kernel-side conversation.
 */
export interface DshSessionManifest extends SessionManifest {
  kernel: 'dsh';
  dshSessionId?: string;
}

export interface SessionRecord {
  manifest: DshSessionManifest;
  messages: SessionMessage[];
  diffs: DiffChangeRecord[];
}

/**
 * JSON persistence for Harness-backed sessions.
 *
 * Layout (mirrors the DAC agent runtime layout so existing data directories stay readable):
 *   <storageDir>/sessions/<sessionId>/manifest.json
 *   <storageDir>/sessions/<sessionId>/messages.json
 *   <storageDir>/sessions/<sessionId>/diffs.json
 */
export class DshSessionStore {
  constructor(private readonly storageDir: string) {}

  get root(): string {
    return path.join(this.storageDir, 'sessions');
  }

  sessionDir(sessionId: string): string {
    return path.join(this.root, sessionId);
  }

  manifestPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'manifest.json');
  }

  private messagesPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'messages.json');
  }

  private diffsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'diffs.json');
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async readRecord(sessionId: string): Promise<SessionRecord | null> {
    const manifest = await this.readJson<DshSessionManifest>(this.manifestPath(sessionId));
    if (!manifest) return null;
    const messages = (await this.readJson<SessionMessage[]>(this.messagesPath(sessionId))) ?? [];
    const diffs = (await this.readJson<DiffChangeRecord[]>(this.diffsPath(sessionId))) ?? [];
    return { manifest, messages, diffs };
  }

  async writeManifest(manifest: DshSessionManifest): Promise<void> {
    await fs.mkdir(this.sessionDir(manifest.sessionId), { recursive: true });
    await this.writeJson(this.manifestPath(manifest.sessionId), manifest);
  }

  async writeMessages(sessionId: string, messages: SessionMessage[]): Promise<void> {
    await fs.mkdir(this.sessionDir(sessionId), { recursive: true });
    await this.writeJson(this.messagesPath(sessionId), messages);
  }

  async writeDiffs(sessionId: string, diffs: DiffChangeRecord[]): Promise<void> {
    await fs.mkdir(this.sessionDir(sessionId), { recursive: true });
    await this.writeJson(this.diffsPath(sessionId), diffs);
  }

  async listManifests(): Promise<DshSessionManifest[]> {
    await this.ensure();
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const manifests: DshSessionManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await this.readJson<DshSessionManifest>(
        this.manifestPath(entry.name)
      );
      if (manifest) manifests.push(manifest);
    }
    manifests.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return manifests;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }
}
