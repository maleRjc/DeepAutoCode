/**
 * Stage U: durable cross-session memory digests for the workspace.
 * Stored at .deepautocode/agent-memory.json (not secrets; short summaries only).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface AgentMemoryEntry {
  id: string;
  createdAt: string;
  sessionId?: string;
  source: 'compact' | 'checkpoint' | 'manual' | 'research' | 'goal';
  title: string;
  summary: string;
}

export interface AgentMemoryStore {
  version: 1;
  updatedAt: string;
  entries: AgentMemoryEntry[];
}

function memoryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.deepautocode', 'agent-memory.json');
}

export async function loadAgentMemory(
  workspaceRoot: string
): Promise<AgentMemoryStore> {
  try {
    const raw = await fs.readFile(memoryPath(workspaceRoot), 'utf-8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return {
      version: 1,
      updatedAt: String(parsed?.updatedAt || new Date().toISOString()),
      entries: entries
        .filter((e: any) => e && e.summary)
        .map((e: any) => ({
          id: String(e.id || `mem_${Date.now()}`),
          createdAt: String(e.createdAt || new Date().toISOString()),
          sessionId: e.sessionId ? String(e.sessionId) : undefined,
          source: (e.source || 'manual') as AgentMemoryEntry['source'],
          title: String(e.title || 'Memory').slice(0, 120),
          summary: String(e.summary || '').slice(0, 4000),
        })),
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
  }
}

export async function appendAgentMemory(
  workspaceRoot: string,
  entry: Omit<AgentMemoryEntry, 'id' | 'createdAt'> & {
    id?: string;
    createdAt?: string;
  },
  maxEntries = 40
): Promise<AgentMemoryStore> {
  const store = await loadAgentMemory(workspaceRoot);
  const next: AgentMemoryEntry = {
    id: entry.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: entry.createdAt || new Date().toISOString(),
    sessionId: entry.sessionId,
    source: entry.source,
    title: String(entry.title || 'Memory').slice(0, 120),
    summary: String(entry.summary || '').trim().slice(0, 4000),
  };
  if (!next.summary) return store;
  store.entries = [next, ...store.entries.filter((e) => e.id !== next.id)].slice(
    0,
    maxEntries
  );
  store.updatedAt = new Date().toISOString();
  const dir = path.join(workspaceRoot, '.deepautocode');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(memoryPath(workspaceRoot), JSON.stringify(store, null, 2), 'utf-8');
  return store;
}

export function formatAgentMemoryForPrompt(
  store: AgentMemoryStore,
  limit = 6
): string {
  const items = (store.entries || []).slice(0, limit);
  if (items.length === 0) return '';
  return (
    `## Cross-session Agent Memory (recent digests)\n` +
    `Use only when relevant; do not invent details beyond these notes.\n` +
    items
      .map(
        (e) =>
          `### ${e.title} (${e.source}${e.sessionId ? ` · ${e.sessionId.slice(0, 10)}` : ''})\n${e.summary.slice(0, 1200)}`
      )
      .join('\n\n')
  );
}

/** Heuristic digest from a free-form assistant/user summary (e.g. /compact output). */
export function digestTextToMemorySummary(text: string, maxChars = 1800): string {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.slice(0, maxChars);
}
