/**
 * Detects repetitive tool-call / content loops (adapted from Cline loop detection).
 * Returns a short reason when a loop is suspected; otherwise undefined.
 */

export type LoopSignal =
  | { kind: 'tool_repeat'; reason: string; count: number }
  | { kind: 'content_repeat'; reason: string; count: number };

export interface LoopDetectionOptions {
  /** Same tool+args fingerprint N times in a row → loop. Default 4. */
  toolRepeatThreshold?: number;
  /** Same assistant content hash N times → loop. Default 3. */
  contentRepeatThreshold?: number;
  /** Sliding window for tool fingerprints. Default 12. */
  toolWindow?: number;
}

function stableStringify(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function hashText(text: string): string {
  // FNV-1a 32-bit — good enough for loop detection, no crypto dep
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export class LoopDetection {
  private readonly toolRepeatThreshold: number;
  private readonly contentRepeatThreshold: number;
  private readonly toolWindow: number;
  private readonly recentTools: string[] = [];
  private readonly recentContentHashes: string[] = [];
  private consecutiveSameTool = 0;
  private lastToolKey = '';
  private consecutiveSameContent = 0;
  private lastContentHash = '';

  constructor(options: LoopDetectionOptions = {}) {
    this.toolRepeatThreshold = Math.max(2, options.toolRepeatThreshold ?? 4);
    this.contentRepeatThreshold = Math.max(2, options.contentRepeatThreshold ?? 3);
    this.toolWindow = Math.max(4, options.toolWindow ?? 12);
  }

  observeToolCall(name: string, args?: unknown): LoopSignal | undefined {
    const key = `${name}|${stableStringify(args ?? {})}`;
    this.recentTools.push(key);
    if (this.recentTools.length > this.toolWindow) {
      this.recentTools.splice(0, this.recentTools.length - this.toolWindow);
    }

    if (key === this.lastToolKey) {
      this.consecutiveSameTool += 1;
    } else {
      this.lastToolKey = key;
      this.consecutiveSameTool = 1;
    }

    if (this.consecutiveSameTool >= this.toolRepeatThreshold) {
      return {
        kind: 'tool_repeat',
        count: this.consecutiveSameTool,
        reason: `same tool call repeated ${this.consecutiveSameTool} times (${name})`,
      };
    }

    // Alternating A-B-A-B pattern in recent window
    if (this.recentTools.length >= 6) {
      const a = this.recentTools[this.recentTools.length - 2];
      const b = this.recentTools[this.recentTools.length - 1];
      if (a !== b) {
        let alternating = true;
        for (let i = this.recentTools.length - 4; i >= this.recentTools.length - 6; i -= 2) {
          if (this.recentTools[i] !== a || this.recentTools[i + 1] !== b) {
            alternating = false;
            break;
          }
        }
        if (alternating) {
          return {
            kind: 'tool_repeat',
            count: 3,
            reason: `alternating tool calls detected (${name})`,
          };
        }
      }
    }

    return undefined;
  }

  observeAssistantContent(content: string): LoopSignal | undefined {
    const normalized = String(content || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 4000);
    if (!normalized) return undefined;
    const h = hashText(normalized);
    this.recentContentHashes.push(h);
    if (this.recentContentHashes.length > 8) {
      this.recentContentHashes.splice(0, this.recentContentHashes.length - 8);
    }

    if (h === this.lastContentHash) {
      this.consecutiveSameContent += 1;
    } else {
      this.lastContentHash = h;
      this.consecutiveSameContent = 1;
    }

    if (this.consecutiveSameContent >= this.contentRepeatThreshold) {
      return {
        kind: 'content_repeat',
        count: this.consecutiveSameContent,
        reason: `assistant content repeated ${this.consecutiveSameContent} turns`,
      };
    }
    return undefined;
  }

  reset(): void {
    this.recentTools.length = 0;
    this.recentContentHashes.length = 0;
    this.consecutiveSameTool = 0;
    this.lastToolKey = '';
    this.consecutiveSameContent = 0;
    this.lastContentHash = '';
  }
}
