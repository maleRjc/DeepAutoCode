/**
 * Consecutive mistake / empty-response tracker (adapted from Cline MistakeTracker).
 * Used by AgentLoop circuit breaker and Trace.
 */

export type MistakeKind = 'tool_error' | 'empty_response' | 'wrong_tool' | 'verify_fail';

export interface MistakeEvent {
  kind: MistakeKind;
  at: number;
  detail?: string;
}

export interface MistakeTrackerSnapshot {
  consecutiveMistakes: number;
  consecutiveEmptyResponses: number;
  totalMistakes: number;
  lastKind?: MistakeKind;
  events: MistakeEvent[];
}

export class MistakeTracker {
  private consecutiveMistakes = 0;
  private consecutiveEmptyResponses = 0;
  private totalMistakes = 0;
  private lastKind?: MistakeKind;
  private readonly events: MistakeEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 40) {
    this.maxEvents = Math.max(8, maxEvents);
  }

  recordMistake(kind: MistakeKind, detail?: string): number {
    this.consecutiveMistakes += 1;
    this.totalMistakes += 1;
    this.lastKind = kind;
    if (kind === 'empty_response') {
      this.consecutiveEmptyResponses += 1;
    } else {
      this.consecutiveEmptyResponses = 0;
    }
    this.push({ kind, at: Date.now(), detail });
    return this.consecutiveMistakes;
  }

  recordSuccess(): void {
    this.consecutiveMistakes = 0;
    this.consecutiveEmptyResponses = 0;
    this.lastKind = undefined;
  }

  getConsecutiveMistakes(): number {
    return this.consecutiveMistakes;
  }

  getConsecutiveEmptyResponses(): number {
    return this.consecutiveEmptyResponses;
  }

  getTotalMistakes(): number {
    return this.totalMistakes;
  }

  snapshot(): MistakeTrackerSnapshot {
    return {
      consecutiveMistakes: this.consecutiveMistakes,
      consecutiveEmptyResponses: this.consecutiveEmptyResponses,
      totalMistakes: this.totalMistakes,
      lastKind: this.lastKind,
      events: this.events.slice(),
    };
  }

  private push(event: MistakeEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}
