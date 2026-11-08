import fs from 'node:fs/promises';
import path from 'node:path';

export interface CheckpointFileSnapshot {
  filePath: string;
  content: string;
  existed: boolean;
}

export interface SessionCheckpoint {
  checkpointId: string;
  sessionId: string;
  label: string;
  createdAt: string;
  messageSequence?: number;
  files: CheckpointFileSnapshot[];
  pendingDiffIds?: string[];
}

export async function listSessionCheckpoints(sessionDir: string): Promise<SessionCheckpoint[]> {
  const dir = path.join(sessionDir, 'checkpoints');
  try {
    const entries = await fs.readdir(dir);
    const items: SessionCheckpoint[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf-8');
        items.push(JSON.parse(raw) as SessionCheckpoint);
      } catch {
        // skip bad file
      }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function saveSessionCheckpoint(
  sessionDir: string,
  checkpoint: SessionCheckpoint
): Promise<SessionCheckpoint> {
  const dir = path.join(sessionDir, 'checkpoints');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${checkpoint.checkpointId}.json`);
  await fs.writeFile(file, JSON.stringify(checkpoint, null, 2), 'utf-8');
  return checkpoint;
}

export async function readSessionCheckpoint(
  sessionDir: string,
  checkpointId: string
): Promise<SessionCheckpoint | null> {
  try {
    const raw = await fs.readFile(
      path.join(sessionDir, 'checkpoints', `${checkpointId}.json`),
      'utf-8'
    );
    return JSON.parse(raw) as SessionCheckpoint;
  } catch {
    return null;
  }
}

/**
 * Capture current on-disk content for the given relative paths.
 */
export async function captureWorkspaceFiles(
  workspaceRoot: string,
  filePaths: string[]
): Promise<CheckpointFileSnapshot[]> {
  const out: CheckpointFileSnapshot[] = [];
  const seen = new Set<string>();
  for (const raw of filePaths) {
    const rel = String(raw || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.resolve(workspaceRoot, rel);
    if (!abs.startsWith(path.resolve(workspaceRoot))) continue;
    try {
      const content = await fs.readFile(abs, 'utf-8');
      out.push({ filePath: rel, content, existed: true });
    } catch {
      out.push({ filePath: rel, content: '', existed: false });
    }
  }
  return out;
}

/**
 * Restore files from a checkpoint onto disk.
 */
export async function restoreWorkspaceFiles(
  workspaceRoot: string,
  files: CheckpointFileSnapshot[]
): Promise<{ restored: number; deleted: number }> {
  let restored = 0;
  let deleted = 0;
  for (const f of files) {
    const abs = path.resolve(workspaceRoot, f.filePath);
    if (!abs.startsWith(path.resolve(workspaceRoot))) continue;
    if (!f.existed) {
      await fs.rm(abs, { force: true }).catch(() => undefined);
      deleted += 1;
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.content, 'utf-8');
    restored += 1;
  }
  return { restored, deleted };
}
