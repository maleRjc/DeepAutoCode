import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DiffChangeRecord,
  SessionManifest,
  SessionMessage,
} from '../../types.js';
import type { CapabilityRegistry } from '../../capabilities/CapabilityRegistry.js';
import {
  captureWorkspaceFiles,
  listSessionCheckpoints,
  readSessionCheckpoint,
  restoreWorkspaceFiles,
  saveSessionCheckpoint,
  type SessionCheckpoint,
} from '../../core/SessionCheckpoint.js';
import { createUnifiedDiff } from '../tools/FileEditEngine.js';
import type { ClineRuntimeEvent } from '../RuntimeFactory.js';

export interface CheckpointRuntimeContext {
  capabilityRegistry: CapabilityRegistry;
  readDiffs: (sessionId: string) => Promise<DiffChangeRecord[]>;
  readMessages: (sessionId: string) => Promise<SessionMessage[]>;
  list: () => Promise<SessionManifest[]>;
  get: (sessionId: string) => Promise<SessionManifest | null>;
  getDiffsPath: (sessionId: string) => string;
  getSessionDir: (sessionId: string) => string;
  emit: (event: ClineRuntimeEvent) => void;
}

export async function updateDiffProposedService(
  ctx: CheckpointRuntimeContext,
  sessionId: string,
  diffId: string,
  proposedContent: string,
  options?: { writeToDisk?: boolean; finalize?: 'accept' | 'reject' | 'keep' }
): Promise<DiffChangeRecord | null> {
    let ownerSessionId = sessionId;
    let diffs = await ctx.readDiffs(ownerSessionId);
    let target = diffs.find((d) => d.diffId === diffId);
    if (!target) {
      const allSessions = await ctx.list();
      for (const s of allSessions) {
        const candidateDiffs = await ctx.readDiffs(s.sessionId);
        const found = candidateDiffs.find((d) => d.diffId === diffId);
        if (found) {
          ownerSessionId = s.sessionId;
          diffs = candidateDiffs;
          target = found;
          break;
        }
      }
    }
    if (!target || target.status !== 'pending') return null;

    target.proposedContent = String(proposedContent ?? '');
    target.unifiedDiff = createUnifiedDiff(
      target.filePath,
      target.originalContent || '',
      target.proposedContent
    );
    target.updatedAt = new Date().toISOString();

    const finalize = options?.finalize || 'keep';
    const writeToDisk = options?.writeToDisk !== false;
    const manifest = await ctx.get(ownerSessionId);

    if (finalize === 'accept') {
      return updateDiffStatusService(ctx, ownerSessionId, diffId, 'accepted');
    }
    if (finalize === 'reject') {
      return updateDiffStatusService(ctx, ownerSessionId, diffId, 'rejected');
    }

    if (writeToDisk && manifest && target.appliedToDisk !== false) {
      await ctx.capabilityRegistry.invoke(
        'write-file',
        { filePath: target.filePath, content: target.proposedContent },
        {
          sessionId: ownerSessionId,
          workspaceRoot: manifest.workspaceRoot,
          executionMode: 'auto',
        }
      );
      target.appliedToDisk = true;
    }

    await fs.writeFile(ctx.getDiffsPath(ownerSessionId), JSON.stringify(diffs, null, 2), 'utf-8');
    ctx.emit({
      type: 'diff_updated',
      sessionId: ownerSessionId,
      payload: { ...target },
    });
    return target;
  }

export async function updateDiffStatusService(
  ctx: CheckpointRuntimeContext,
  sessionId: string,
  diffId: string,
  status: DiffChangeRecord['status'],
  feedback?: string
): Promise<DiffChangeRecord | null> {
    let ownerSessionId = sessionId;
    let diffs = await ctx.readDiffs(ownerSessionId);
    let target = diffs.find((d) => d.diffId === diffId);

    // Fallback: if diffId was not found under the passed sessionId, locate its owning session
    if (!target) {
      const allSessions = await ctx.list();
      for (const s of allSessions) {
        const candidateDiffs = await ctx.readDiffs(s.sessionId);
        const found = candidateDiffs.find((d) => d.diffId === diffId);
        if (found) {
          ownerSessionId = s.sessionId;
          diffs = candidateDiffs;
          target = found;
          break;
        }
      }
    }

    if (!target) return null;

    target.status = status;
    target.feedback = feedback;
    target.updatedAt = new Date().toISOString();

    const manifest = await ctx.get(ownerSessionId);
    if (manifest) {
      if (status === 'accepted') {
        // Always materialize proposed content (covers review-before-write Manual diffs
        // and re-applies after a prior Reject in Auto mode).
        await ctx.capabilityRegistry.invoke(
          'write-file',
          {
            filePath: target.filePath,
            content: target.proposedContent,
          },
          {
            sessionId: ownerSessionId,
            workspaceRoot: manifest.workspaceRoot,
            executionMode: 'auto',
          }
        );
        target.appliedToDisk = true;
      } else if (status === 'rejected') {
        // Roll back only when content was already on disk.
        // appliedToDisk === false → Manual review-before-write (nothing to undo).
        // appliedToDisk === undefined → legacy records (assume already written).
        if (target.appliedToDisk !== false) {
          if (target.operation === 'modify') {
            await ctx.capabilityRegistry.invoke(
              'write-file',
              {
                filePath: target.filePath,
                content: target.originalContent,
              },
              {
                sessionId: ownerSessionId,
                workspaceRoot: manifest.workspaceRoot,
                executionMode: 'auto',
              }
            );
          } else if (target.operation === 'create') {
            const absCreated = path.resolve(manifest.workspaceRoot, target.filePath);
            if (absCreated.startsWith(path.resolve(manifest.workspaceRoot))) {
              await fs.rm(absCreated, { force: true }).catch(() => undefined);
            }
          }
          target.appliedToDisk = false;
        }
      }
    }

    await fs.writeFile(ctx.getDiffsPath(ownerSessionId), JSON.stringify(diffs, null, 2), 'utf-8');

    ctx.emit({
      type: status === 'pending' ? 'diff_proposed' : 'diff_updated',
      sessionId: ownerSessionId,
      payload: { ...target },
    });

    return target;
  }

export async function reviewAllPendingDiffsService(
  ctx: CheckpointRuntimeContext,
  sessionId: string,
  action: 'accept' | 'reject'
): Promise<DiffChangeRecord[]> {
    const diffs = await ctx.readDiffs(sessionId);
    const pending = diffs.filter((d) => d.status === 'pending');
    const updated: DiffChangeRecord[] = [];
    for (const d of pending) {
      const next = await updateDiffStatusService(ctx, 
        sessionId,
        d.diffId,
        action === 'accept' ? 'accepted' : 'rejected'
      );
      if (next) updated.push(next);
    }
    return updated;
  }

export async function createCheckpointService(
  ctx: CheckpointRuntimeContext,
  sessionId: string,
  label?: string
): Promise<SessionCheckpoint | null> {
    const manifest = await ctx.get(sessionId);
    if (!manifest) return null;
    const diffs = await ctx.readDiffs(sessionId);
    const messages = await ctx.readMessages(sessionId);
    const paths = Array.from(
      new Set([
        ...diffs.map((d) => d.filePath),
        ...diffs
          .filter((d) => d.status === 'pending' || d.status === 'accepted')
          .map((d) => d.filePath),
      ])
    );
    const files = await captureWorkspaceFiles(manifest.workspaceRoot, paths);
    // Prefer originalContent from pending/accepted diffs as the pre-edit baseline when available
    for (const d of diffs) {
      if (d.status !== 'pending' && d.status !== 'accepted') continue;
      const idx = files.findIndex((f) => f.filePath === d.filePath);
      if (idx >= 0 && d.originalContent != null) {
        files[idx] = {
          filePath: d.filePath,
          content: d.originalContent,
          existed: d.operation !== 'create',
        };
      }
    }
    const checkpoint: SessionCheckpoint = {
      checkpointId: `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sessionId,
      label: label || `Checkpoint @ ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(),
      messageSequence: messages.length,
      files,
      pendingDiffIds: diffs.filter((d) => d.status === 'pending').map((d) => d.diffId),
    };
    await saveSessionCheckpoint(ctx.getSessionDir(sessionId), checkpoint);
    // Stage U: checkpoint → short cross-session memory note
    try {
      const { appendAgentMemory } = await import('../../core/index.js');
      await appendAgentMemory(manifest.workspaceRoot, {
        sessionId,
        source: 'checkpoint',
        title: checkpoint.label.slice(0, 80),
        summary: `Checkpoint ${checkpoint.checkpointId}: ${checkpoint.files
          .map((f) => f.filePath)
          .slice(0, 12)
          .join(', ')}${checkpoint.files.length > 12 ? '…' : ''} (${checkpoint.files.length} files).`,
      });
    } catch {
      // non-fatal
    }
    ctx.emit({
      type: 'checkpoint_created',
      sessionId,
      payload: {
        checkpointId: checkpoint.checkpointId,
        label: checkpoint.label,
        fileCount: checkpoint.files.length,
        pendingDiffCount: checkpoint.pendingDiffIds?.length ?? 0,
      },
    });
    return checkpoint;
  }

export async function listCheckpointsService(
  ctx: CheckpointRuntimeContext,
  sessionId: string
): Promise<SessionCheckpoint[]> {
  return listSessionCheckpoints(ctx.getSessionDir(sessionId));
}

export async function restoreCheckpointService(
  ctx: CheckpointRuntimeContext,
  sessionId: string,
  checkpointId: string
): Promise<{ ok: boolean; restored: number; deleted: number; checkpointId: string }> {
    const manifest = await ctx.get(sessionId);
    if (!manifest) {
      return { ok: false, restored: 0, deleted: 0, checkpointId };
    }
    const checkpoint = await readSessionCheckpoint(ctx.getSessionDir(sessionId), checkpointId);
    if (!checkpoint) {
      return { ok: false, restored: 0, deleted: 0, checkpointId };
    }
    const result = await restoreWorkspaceFiles(manifest.workspaceRoot, checkpoint.files);
    // Mark pending diffs linked to this checkpoint as rejected without rewriting originals again
    const diffs = await ctx.readDiffs(sessionId);
    let dirty = false;
    for (const d of diffs) {
      if (d.status === 'pending') {
        d.status = 'rejected';
        d.appliedToDisk = false;
        d.updatedAt = new Date().toISOString();
        d.feedback = `Restored checkpoint ${checkpointId}`;
        dirty = true;
      }
    }
    if (dirty) {
      await fs.writeFile(ctx.getDiffsPath(sessionId), JSON.stringify(diffs, null, 2), 'utf-8');
    }
    ctx.emit({
      type: 'session_state',
      sessionId,
      payload: {
        status: 'idle',
        restoredCheckpointId: checkpointId,
        ...result,
      },
    });
    return { ok: true, ...result, checkpointId };
  }
