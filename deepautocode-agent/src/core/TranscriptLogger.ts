import fs from 'node:fs/promises';
import path from 'node:path';

export interface TranscriptStepInput {
  stepIndex?: number;
  source: 'USER_EXPLICIT' | 'MODEL' | 'SYSTEM';
  type: 'USER_INPUT' | 'PLANNER_RESPONSE' | 'TOOL_RESULT' | 'SYSTEM_WAKEUP';
  status: 'DONE' | 'ERROR';
  content?: string;
  thinking?: string;
  toolCalls?: Array<Record<string, unknown>>;
  media?: Array<{ mime_type: string; uri: string }>;
}

export interface TranscriptStepRecord {
  step_index: number;
  source: 'USER_EXPLICIT' | 'MODEL' | 'SYSTEM';
  type: 'USER_INPUT' | 'PLANNER_RESPONSE' | 'TOOL_RESULT' | 'SYSTEM_WAKEUP';
  status: 'DONE' | 'ERROR';
  created_at: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<Record<string, unknown>>;
  media?: Array<{ mime_type: string; uri: string }>;
  truncated_fields?: string[];
}

const COMPACT_FIELD_CHAR_LIMIT = 1200;

/**
 * Antigravity-style Dual-Layer JSONL Conversation Transcript Logger.
 * Persists every step to:
 * - `<sessionDir>/logs/transcript.jsonl` (compact view with `truncated_fields` markers)
 * - `<sessionDir>/logs/transcript_full.jsonl` (complete untruncated output & thinking chains)
 */
export class TranscriptLogger {
  private readonly stepCounters = new Map<string, number>();

  public async appendStep(
    sessionDir: string,
    input: TranscriptStepInput
  ): Promise<{ stepIndex: number; compactPath: string; fullPath: string }> {
    const logsDir = path.join(sessionDir, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    const compactPath = path.join(logsDir, 'transcript.jsonl');
    const fullPath = path.join(logsDir, 'transcript_full.jsonl');

    const nextIdx =
      typeof input.stepIndex === 'number'
        ? input.stepIndex
        : (this.stepCounters.get(sessionDir) ?? 0) + 1;
    this.stepCounters.set(sessionDir, nextIdx);

    const createdAt = new Date().toISOString();
    const fullRecord: TranscriptStepRecord = {
      step_index: nextIdx,
      source: input.source,
      type: input.type,
      status: input.status,
      created_at: createdAt,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.toolCalls !== undefined ? { tool_calls: input.toolCalls } : {}),
      ...(input.media !== undefined ? { media: input.media } : {}),
    };

    const truncatedFields: string[] = [];
    const compactRecord: TranscriptStepRecord = { ...fullRecord };

    if (
      typeof compactRecord.content === 'string' &&
      compactRecord.content.length > COMPACT_FIELD_CHAR_LIMIT
    ) {
      compactRecord.content = `${compactRecord.content.slice(0, COMPACT_FIELD_CHAR_LIMIT)}...[truncated]`;
      truncatedFields.push('content');
    }
    if (
      typeof compactRecord.thinking === 'string' &&
      compactRecord.thinking.length > COMPACT_FIELD_CHAR_LIMIT
    ) {
      compactRecord.thinking = `${compactRecord.thinking.slice(0, COMPACT_FIELD_CHAR_LIMIT)}...[truncated]`;
      truncatedFields.push('thinking');
    }
    if (Array.isArray(compactRecord.tool_calls)) {
      const serialized = JSON.stringify(compactRecord.tool_calls);
      if (serialized.length > COMPACT_FIELD_CHAR_LIMIT) {
        compactRecord.tool_calls = compactRecord.tool_calls.map((tc) => ({
          toolName: tc.toolName || tc.name,
          status: tc.status,
          truncated: true,
        }));
        truncatedFields.push('tool_calls');
      }
    }
    if (truncatedFields.length > 0) {
      compactRecord.truncated_fields = truncatedFields;
    }

    await Promise.all([
      fs.appendFile(compactPath, `${JSON.stringify(compactRecord)}\n`, 'utf-8'),
      fs.appendFile(fullPath, `${JSON.stringify(fullRecord)}\n`, 'utf-8'),
    ]);

    return { stepIndex: nextIdx, compactPath, fullPath };
  }

  public async readTranscript(
    sessionDir: string,
    options?: {
      full?: boolean;
      startLine?: number;
      endLine?: number;
      grep?: string;
    }
  ): Promise<{
    file: string;
    totalLines: number;
    entries: TranscriptStepRecord[];
  }> {
    const file = path.join(
      sessionDir,
      'logs',
      options?.full ? 'transcript_full.jsonl' : 'transcript.jsonl'
    );
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const start = Math.max(1, Number(options?.startLine ?? 1));
      const end = Math.min(lines.length, Number(options?.endLine ?? lines.length));
      const sliced = lines.slice(start - 1, end);
      const needle = options?.grep ? options.grep.toLowerCase() : '';
      const entries = sliced
        .filter((line) => (!needle ? true : line.toLowerCase().includes(needle)))
        .map((line) => {
          try {
            return JSON.parse(line) as TranscriptStepRecord;
          } catch {
            return null;
          }
        })
        .filter((item): item is TranscriptStepRecord => item !== null);
      return {
        file,
        totalLines: lines.length,
        entries,
      };
    } catch {
      return { file, totalLines: 0, entries: [] };
    }
  }
}

export const globalTranscriptLogger = new TranscriptLogger();

