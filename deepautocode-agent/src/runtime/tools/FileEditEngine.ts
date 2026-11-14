import path from 'node:path';
import type {
  CapabilityName,
  DiffChangeRecord,
  SessionManifest,
  ToolCallRecord,
} from '../../types.js';
import type { CapabilityRegistry } from '../../capabilities/CapabilityRegistry.js';
import type { ClineRuntimeEvent } from '../RuntimeFactory.js';

export function createUnifiedDiff(filePath: string, original: string, proposed: string): string {
  const origLines = original ? original.split(/\r?\n/) : [];
  const propLines = proposed ? proposed.split(/\r?\n/) : [];
  const lines: string[] = [
    `--- a/${filePath.replace(/\\/g, '/')}`,
    `+++ b/${filePath.replace(/\\/g, '/')}`,
    `@@ -1,${origLines.length} +1,${propLines.length} @@`,
  ];
  const maxLen = Math.max(origLines.length, propLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i];
    const p = propLines[i];
    if (o === p && o !== undefined) {
      lines.push(` ${o}`);
    } else {
      if (o !== undefined) lines.push(`-${o}`);
      if (p !== undefined) lines.push(`+${p}`);
    }
  }
  return lines.join('\n');
}

export function normalizeWorkspaceRelativePath(rawPath: string, workspaceRoot: string): string {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) return '';
    const resolvedRoot = path.resolve(workspaceRoot);
    const rootBase = path.basename(resolvedRoot);

    // 1. If rawPath is already inside resolvedRoot on the local OS
    if (path.isAbsolute(trimmed)) {
      const resolvedTarget = path.resolve(trimmed);
      const rel = path.relative(resolvedRoot, resolvedTarget);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return (rel || '.').replace(/\\/g, '/');
      }
    }

    // 2. If rawPath is a remote POSIX path on Windows (e.g. "/home/renjc01/Bug/fhccl/nccl-test/src/sendrecv.cc")
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && rootBase) {
      const marker = `/${rootBase}/`;
      const idx = trimmed.lastIndexOf(marker);
      if (idx >= 0) {
        return trimmed.slice(idx + marker.length).replace(/\\/g, '/');
      }
      if (trimmed.endsWith(`/${rootBase}`)) {
        return '.';
      }
    }

    // 3. Clean relative path and strip redundant workspace folder prefix if present
    let cleanRel = trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (rootBase && cleanRel.startsWith(`${rootBase}/`)) {
      const withoutPrefix = cleanRel.slice(rootBase.length + 1);
      if (withoutPrefix) {
        cleanRel = withoutPrefix;
      }
    }
    return cleanRel || '.';
  }

function cleanEditSnippet(raw: string): string {
  let s = String(raw || '').replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (s.startsWith('```') && s.endsWith('```')) {
    s = s.replace(/^```[a-zA-Z0-9_-]*\r?\n/, '').replace(/\r?\n```\s*$/, '');
  }
  return s;
}

function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

export function applySmartTextReplacement(
  currentContent: string,
  rawOldText: string,
  rawNewText: string,
  filePath: string
): string {
    if (!currentContent) {
      return rawNewText;
    }

    const oldText = cleanEditSnippet(rawOldText);
    const newText = cleanEditSnippet(rawNewText);

    // 1. Exact substring match (using function replacer so '$&' / '$$' in C/bash code are never mangled)
    if (currentContent.includes(oldText)) {
      return currentContent.replace(oldText, () => newText);
    }

    // 2. CRLF / LF normalized match
    const hasCrLf = currentContent.includes('\r\n');
    const normCurrent = currentContent.replace(/\r\n/g, '\n');
    const normOld = oldText.replace(/\r\n/g, '\n');
    const normNew = newText.replace(/\r\n/g, '\n');

    if (normCurrent.includes(normOld)) {
      const replaced = normCurrent.replace(normOld, () => normNew);
      return hasCrLf ? replaced.replace(/\n/g, '\r\n') : replaced;
    }

    // 3. Tab / space indentation-tolerant line-by-line block match
    const contentLines = normCurrent.split('\n');
    const oldLines = normOld.split('\n');
    // Trim leading/trailing empty lines from oldLines if needed
    while (oldLines.length > 0 && oldLines[0].trim() === '') oldLines.shift();
    while (oldLines.length > 0 && oldLines[oldLines.length - 1].trim() === '') oldLines.pop();

    if (oldLines.length > 0 && oldLines.length <= contentLines.length) {
      for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
        let allMatch = true;
        for (let j = 0; j < oldLines.length; j++) {
          if (contentLines[i + j].trim() !== oldLines[j].trim()) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          const before = contentLines.slice(0, i);
          const after = contentLines.slice(i + oldLines.length);
          const joined = [...before, normNew, ...after].join('\n');
          return hasCrLf ? joined.replace(/\n/g, '\r\n') : joined;
        }
      }
    }

    // 4. Quote normalization match (curly vs straight quotes)
    const quoteNormContent = normalizeQuotes(normCurrent);
    const quoteNormOld = normalizeQuotes(normOld);
    if (quoteNormContent.includes(quoteNormOld)) {
      // Find actual index in normCurrent
      const idx = quoteNormContent.indexOf(quoteNormOld);
      if (idx >= 0) {
        const before = normCurrent.slice(0, idx);
        const after = normCurrent.slice(idx + quoteNormOld.length);
        const joined = `${before}${normNew}${after}`;
        return hasCrLf ? joined.replace(/\n/g, '\r\n') : joined;
      }
    }

    throw new Error(
      `OLD_TEXT_NOT_FOUND: Could not find matching 'oldText' block in "${filePath}". Please call read_file on "${filePath}" to inspect the exact lines, or call write_file with the complete file content.`
    );
  }

export async function proposeAndApplyFileEdit(
  runtimeCtx: {
    capabilityRegistry: CapabilityRegistry;
    saveDiff: (sessionId: string, diff: DiffChangeRecord) => Promise<void>;
    emit: (event: ClineRuntimeEvent) => void;
  },
  params: {
    sessionId: string;
    manifest: SessionManifest;
    targetFile: string;
    proposedContent: string;
    signal: AbortSignal;
    runCapabilityTool: (
      capability: CapabilityName,
      args: Record<string, unknown>,
      risk?: ToolCallRecord['risk']
    ) => Promise<unknown>;
    diffIds: string[];
    applyImmediately?: boolean;
    onBeforeFirstMutation?: () => Promise<void>;
    trackOriginal?: (filePath: string, originalContent: string, operation: 'create' | 'modify') => void;
  }
): Promise<{ diffId: string; bytesWritten: number; operation: string; appliedToDisk: boolean }> {
    const { sessionId, manifest, proposedContent, signal, runCapabilityTool, diffIds } = params;
    const targetFile = normalizeWorkspaceRelativePath(
      params.targetFile,
      manifest.workspaceRoot
    );
    // Auto: write immediately (Reject can roll back).
    // Manual: write-file goes through ApprovalBridge first (human-in-the-loop), then disk.
    const applyImmediately =
      params.applyImmediately ?? true;

    let originalContent = '';
    try {
      const readRes = (await runtimeCtx.capabilityRegistry.invoke(
        'read-file',
        { filePath: targetFile },
        {
          sessionId,
          workspaceRoot: manifest.workspaceRoot,
          executionMode: 'plan',
          signal,
        }
      )) as { content: string };
      originalContent = readRes.content;
    } catch {
      originalContent = '';
    }

    const operation: 'create' | 'modify' = originalContent ? 'modify' : 'create';
    params.trackOriginal?.(targetFile, originalContent, operation);

    if (applyImmediately && params.onBeforeFirstMutation) {
      await params.onBeforeFirstMutation();
    }

    const diffId = `diff_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const unifiedDiff = createUnifiedDiff(targetFile, originalContent, proposedContent);
    const diffRecord: DiffChangeRecord = {
      diffId,
      sessionId,
      filePath: targetFile,
      operation,
      originalContent,
      proposedContent,
      unifiedDiff,
      status: 'pending',
      appliedToDisk: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await runtimeCtx.saveDiff(sessionId, diffRecord);
    diffIds.push(diffId);

    // P0-2: emit Diff proposal before any disk write so UI can show pending change first.
    runtimeCtx.emit({
      type: 'diff_proposed',
      sessionId,
      payload: { ...diffRecord },
    });

    await runCapabilityTool(
      'reveal-diff',
      {
        diffId,
        filePath: targetFile,
        originalContent,
        proposedContent,
        title:
          manifest.executionMode === 'manual'
            ? `DeepAutoCode Diff (awaiting approval): ${targetFile}`
            : `DeepAutoCode Diff: ${targetFile}`,
      },
      'low'
    );

    let bytesWritten = Buffer.byteLength(proposedContent, 'utf-8');
    let writeOperation = operation;

    if (applyImmediately) {
      try {
        // Manual → ApprovalBridge gates write-file; Auto writes immediately.
        const writeOut = (await runCapabilityTool(
          'write-file',
          {
            filePath: targetFile,
            content: proposedContent,
            createDirectories: true,
          },
          'medium'
        )) as { bytesWritten: number; operation: string };
        bytesWritten = writeOut?.bytesWritten ?? bytesWritten;
        writeOperation = (writeOut?.operation as 'create' | 'modify') ?? operation;
        diffRecord.appliedToDisk = true;
        diffRecord.status = 'pending';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('USER_REJECTED')) {
          diffRecord.status = 'rejected';
          diffRecord.appliedToDisk = false;
          diffRecord.feedback = msg;
          diffRecord.updatedAt = new Date().toISOString();
          await runtimeCtx.saveDiff(sessionId, diffRecord);
          runtimeCtx.emit({
            type: 'diff_proposed',
            sessionId,
            payload: { ...diffRecord },
          });
        }
        throw err;
      }
    }

    diffRecord.updatedAt = new Date().toISOString();
    await runtimeCtx.saveDiff(sessionId, diffRecord);

    if (diffRecord.appliedToDisk) {
      runtimeCtx.emit({
        type: 'diff_proposed',
        sessionId,
        payload: { ...diffRecord },
      });
    }

    return {
      diffId,
      bytesWritten,
      operation: writeOperation,
      appliedToDisk: Boolean(diffRecord.appliedToDisk),
    };
  }
