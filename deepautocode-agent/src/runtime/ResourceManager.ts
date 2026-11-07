export interface DisposableResource {
  id: string;
  category: 'subscription' | 'webview' | 'runtime' | 'connection' | 'process';
  dispose: () => void | Promise<void>;
}

/**
 * Section 4.2 & 5.6: Resource Manager
 * Unified lifecycle management for subscriptions, Webviews, Runtimes, AbortControllers, and connections.
 * Explicitly separates:
 *  1. Webview panel closed (UI subscription released; session & runtime remain alive)
 *  2. Window closed
 *  3. Extension Host restart
 *  4. Full IDE exit
 */
export class ResourceManager {
  private readonly resources = new Map<string, DisposableResource>();
  private readonly sessionAbortControllers = new Map<string, AbortController>();
  private readonly attachedWebviews = new Set<string>();

  register(resource: DisposableResource): () => Promise<void> {
    const existing = this.resources.get(resource.id);
    if (existing) {
      Promise.resolve(existing.dispose()).catch(() => {});
    }
    this.resources.set(resource.id, resource);
    return async () => {
      await this.disposeResource(resource.id);
    };
  }

  async disposeResource(id: string): Promise<boolean> {
    const res = this.resources.get(id);
    if (!res) return false;
    this.resources.delete(id);
    await Promise.resolve(res.dispose());
    return true;
  }

  /**
   * Create or replace an AbortController for a running session task.
   * Ensures cancel button triggers real AbortSignal propagation to tools & LLM streams.
   */
  createSessionTaskSignal(sessionId: string): AbortSignal {
    const prev = this.sessionAbortControllers.get(sessionId);
    if (prev && !prev.signal.aborted) {
      prev.abort(new Error('Superseded by new task'));
    }
    const controller = new AbortController();
    this.sessionAbortControllers.set(sessionId, controller);
    return controller.signal;
  }

  cancelSessionTask(sessionId: string, reason = 'Cancelled by user'): boolean {
    const controller = this.sessionAbortControllers.get(sessionId);
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort(new Error(reason));
    this.sessionAbortControllers.delete(sessionId);
    return true;
  }

  clearSessionTaskSignal(sessionId: string): void {
    this.sessionAbortControllers.delete(sessionId);
  }

  /**
   * Lifecycle Scenario 1: Webview Attached / Closed
   * Closing the Webview releases its UI subscription without terminating the Runtime or Session.
   */
  attachWebview(webviewId: string, unsubscribeFn: () => void): void {
    this.attachedWebviews.add(webviewId);
    this.register({
      id: `webview:${webviewId}`,
      category: 'webview',
      dispose: () => {
        this.attachedWebviews.delete(webviewId);
        unsubscribeFn();
      },
    });
  }

  async onWebviewClosed(webviewId: string): Promise<void> {
    await this.disposeResource(`webview:${webviewId}`);
  }

  /**
   * Lifecycle Scenario 2: IDE Window Closed
   */
  async onWindowClosed(): Promise<void> {
    const webviewIds = Array.from(this.resources.values())
      .filter((r) => r.category === 'webview')
      .map((r) => r.id);
    for (const id of webviewIds) {
      await this.disposeResource(id);
    }
  }

  /**
   * Lifecycle Scenario 3 & 4: Extension Host Restart / Full IDE Exit
   */
  async disposeAll(): Promise<void> {
    for (const controller of this.sessionAbortControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort(new Error('Runtime shutting down'));
      }
    }
    this.sessionAbortControllers.clear();
    this.attachedWebviews.clear();

    const entries = Array.from(this.resources.keys()).reverse();
    for (const id of entries) {
      await this.disposeResource(id);
    }
  }

  getStats(): {
    totalResources: number;
    byCategory: Record<string, number>;
    activeTaskCount: number;
    attachedWebviews: string[];
  } {
    const byCategory: Record<string, number> = {
      subscription: 0,
      webview: 0,
      runtime: 0,
      connection: 0,
      process: 0,
    };
    for (const res of this.resources.values()) {
      byCategory[res.category] = (byCategory[res.category] ?? 0) + 1;
    }
    return {
      totalResources: this.resources.size,
      byCategory,
      activeTaskCount: this.sessionAbortControllers.size,
      attachedWebviews: Array.from(this.attachedWebviews),
    };
  }
}

