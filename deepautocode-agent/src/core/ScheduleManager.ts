import { globalSubagentOrchestrator } from './SubagentOrchestrator.js';

export interface ScheduleTaskSnapshot {
  scheduleId: string;
  sessionId: string;
  kind: 'timer' | 'cron';
  prompt: string;
  durationSeconds?: number;
  cronExpression?: string;
  timerCondition?: string;
  isDaemon?: boolean;
  exactTiming?: boolean;
  maxIterations?: number;
  iterationsFired: number;
  status: 'active' | 'fired' | 'cancelled' | 'completed';
  createdAt: string;
  nextFireAt?: string;
}

interface ActiveScheduleInternal {
  snapshot: ScheduleTaskSnapshot;
  timer?: ReturnType<typeof setTimeout>;
  interval?: ReturnType<typeof setInterval>;
  unsubscribeWakeup?: () => void;
}

/**
 * Antigravity-style `schedule` Manager:
 * - One-shot timer (`DurationSeconds` + `TimerCondition`: `'never'` | `'any'` | `<senderId>`)
 * - Recurring 5-field cron job (`CronExpression` + `IsDaemon` + `ExactTiming` + `MaxIterations`)
 * - Fires high-priority `<SYSTEM_MESSAGE>` notifications via `globalSubagentOrchestrator.enqueueWakeup`.
 */
export class ScheduleManager {
  private readonly schedules = new Map<string, ActiveScheduleInternal>();
  private counter = 0;

  public schedule(params: {
    sessionId: string;
    prompt: string;
    durationSeconds?: number;
    cronExpression?: string;
    timerCondition?: string;
    isDaemon?: boolean;
    exactTiming?: boolean;
    maxIterations?: number;
  }): ScheduleTaskSnapshot {
    const scheduleId = `sched_${Date.now().toString(36)}_${++this.counter}`;
    const isCron = Boolean(params.cronExpression && params.cronExpression.trim());
    const now = new Date();

    const snapshot: ScheduleTaskSnapshot = {
      scheduleId,
      sessionId: params.sessionId,
      kind: isCron ? 'cron' : 'timer',
      prompt: String(params.prompt || '').trim() || 'Scheduled reminder triggered.',
      durationSeconds: params.durationSeconds,
      cronExpression: params.cronExpression?.trim(),
      timerCondition: params.timerCondition || 'never',
      isDaemon: Boolean(params.isDaemon),
      exactTiming: Boolean(params.exactTiming),
      maxIterations: params.maxIterations,
      iterationsFired: 0,
      status: 'active',
      createdAt: now.toISOString(),
    };

    const internal: ActiveScheduleInternal = { snapshot };
    this.schedules.set(scheduleId, internal);

    if (!isCron) {
      const delayMs = Math.max(1, Number(params.durationSeconds ?? 10)) * 1000;
      snapshot.nextFireAt = new Date(Date.now() + delayMs).toISOString();

      const cond = String(params.timerCondition || 'never').trim();
      if (cond && cond !== 'never') {
        internal.unsubscribeWakeup = globalSubagentOrchestrator.onWakeup((notif) => {
          if (notif.sessionId !== params.sessionId || notif.sender === scheduleId) return;
          if (cond === 'any' || notif.sender === cond) {
            this.cancel(scheduleId);
          }
        });
      }

      internal.timer = setTimeout(() => {
        if (snapshot.status !== 'active') return;
        snapshot.iterationsFired += 1;
        snapshot.status = 'fired';
        internal.unsubscribeWakeup?.();
        globalSubagentOrchestrator.enqueueWakeup({
          sessionId: params.sessionId,
          sender: scheduleId,
          priority: 'HIGH',
          content: `[Scheduled Timer Fired (${scheduleId})]: ${snapshot.prompt}`,
        });
      }, delayMs);
    } else {
      const intervalMs = this.estimateCronIntervalMs(
        params.cronExpression!,
        Boolean(params.exactTiming)
      );
      snapshot.nextFireAt = new Date(Date.now() + intervalMs).toISOString();
      const maxIter =
        typeof params.maxIterations === 'number' && params.maxIterations > 0
          ? params.maxIterations
          : Infinity;

      internal.interval = setInterval(() => {
        if (snapshot.status !== 'active') return;
        snapshot.iterationsFired += 1;
        snapshot.nextFireAt = new Date(Date.now() + intervalMs).toISOString();
        globalSubagentOrchestrator.enqueueWakeup({
          sessionId: params.sessionId,
          sender: scheduleId,
          priority: 'HIGH',
          content: `[Scheduled Cron Trigger #${snapshot.iterationsFired} (${scheduleId} · ${snapshot.cronExpression})]: ${snapshot.prompt}`,
        });
        if (snapshot.iterationsFired >= maxIter) {
          snapshot.status = 'completed';
          if (internal.interval) clearInterval(internal.interval);
        }
      }, intervalMs);
    }

    return { ...snapshot };
  }

  private estimateCronIntervalMs(cronExpr: string, exactTiming: boolean): number {
    const parts = cronExpr.trim().split(/\s+/);
    const minField = parts[0] || '*';
    let baseMs = 60_000;
    const stepMatch = minField.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      baseMs = Math.max(1, Number(stepMatch[1])) * 60_000;
    } else if (/^\d+$/.test(minField)) {
      baseMs = 3600_000;
    }
    if (!exactTiming) {
      const jitter = Math.floor((Math.random() - 0.5) * Math.min(5_000, baseMs * 0.1));
      return Math.max(5_000, baseMs + jitter);
    }
    return Math.max(5_000, baseMs);
  }

  public cancel(scheduleId: string): boolean {
    const internal = this.schedules.get(scheduleId);
    if (!internal || internal.snapshot.status !== 'active') return false;
    internal.snapshot.status = 'cancelled';
    if (internal.timer) clearTimeout(internal.timer);
    if (internal.interval) clearInterval(internal.interval);
    internal.unsubscribeWakeup?.();
    return true;
  }

  public list(sessionId?: string): ScheduleTaskSnapshot[] {
    const out: ScheduleTaskSnapshot[] = [];
    for (const internal of this.schedules.values()) {
      if (!sessionId || internal.snapshot.sessionId === sessionId) {
        out.push({ ...internal.snapshot });
      }
    }
    return out;
  }
}

export const globalScheduleManager = new ScheduleManager();

