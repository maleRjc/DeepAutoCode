/**
 * Session-scoped task checklist for long-horizon Agent goals.
 * Survives across tool turns within one session.run and can be
 * injected into self-heal / continuation prompts.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface SessionTodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  updatedAt: number;
}

export interface ManageTodoInput {
  action: 'list' | 'set' | 'add' | 'update' | 'complete' | 'cancel' | 'clear';
  /** Full replace for action=set */
  items?: Array<{ id?: string; content: string; status?: TodoStatus }>;
  id?: string;
  content?: string;
  status?: TodoStatus;
}

function newId(): string {
  return `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export class SessionTodoList {
  private items: SessionTodoItem[] = [];

  list(): SessionTodoItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  get incomplete(): SessionTodoItem[] {
    return this.items.filter((i) => i.status === 'pending' || i.status === 'in_progress');
  }

  get hasIncomplete(): boolean {
    return this.incomplete.length > 0;
  }

  manage(input: ManageTodoInput): {
    ok: boolean;
    items: SessionTodoItem[];
    notice?: string;
    error?: string;
  } {
    const action = input.action;
    if (action === 'list') {
      return { ok: true, items: this.list() };
    }
    if (action === 'clear') {
      this.items = [];
      return { ok: true, items: [], notice: 'Todo list cleared.' };
    }
    if (action === 'set') {
      const next = Array.isArray(input.items) ? input.items : [];
      this.items = next
        .filter((i) => String(i?.content || '').trim())
        .slice(0, 40)
        .map((i, idx) => ({
          id: String(i.id || `todo_${idx + 1}`),
          content: String(i.content).trim().slice(0, 240),
          status: (i.status as TodoStatus) || 'pending',
          updatedAt: Date.now(),
        }));
      return { ok: true, items: this.list(), notice: `Todo list set (${this.items.length} items).` };
    }
    if (action === 'add') {
      const content = String(input.content || '').trim();
      if (!content) return { ok: false, items: this.list(), error: 'content required for add' };
      const item: SessionTodoItem = {
        id: String(input.id || newId()),
        content: content.slice(0, 240),
        status: input.status || 'pending',
        updatedAt: Date.now(),
      };
      this.items.push(item);
      if (this.items.length > 40) this.items = this.items.slice(-40);
      return { ok: true, items: this.list(), notice: `Added ${item.id}` };
    }
    if (action === 'update' || action === 'complete' || action === 'cancel') {
      const id = String(input.id || '').trim();
      if (!id) return { ok: false, items: this.list(), error: 'id required' };
      const item = this.items.find((i) => i.id === id);
      if (!item) return { ok: false, items: this.list(), error: `unknown todo id: ${id}` };
      if (action === 'complete') item.status = 'completed';
      else if (action === 'cancel') item.status = 'cancelled';
      else {
        if (input.content) item.content = String(input.content).trim().slice(0, 240);
        if (input.status) item.status = input.status;
      }
      item.updatedAt = Date.now();
      return { ok: true, items: this.list(), notice: `Updated ${id} → ${item.status}` };
    }
    return { ok: false, items: this.list(), error: `unknown action: ${action}` };
  }

  /** Mark first matching incomplete item completed (best-effort for verify success). */
  completeMatching(predicate: (content: string) => boolean): SessionTodoItem | null {
    const item = this.incomplete.find((i) => predicate(i.content));
    if (!item) return null;
    item.status = 'completed';
    item.updatedAt = Date.now();
    return { ...item };
  }

  /** Ensure a verify-related todo exists while healing. */
  ensureVerifyTodo(verifyCommand: string): void {
    const needle = /verify|test|build|编译|测试|验证/i;
    if (this.items.some((i) => needle.test(i.content) && i.status !== 'cancelled')) return;
    this.items.push({
      id: newId(),
      content: `Run verify: ${verifyCommand}`.slice(0, 240),
      status: 'pending',
      updatedAt: Date.now(),
    });
  }

  formatForPrompt(limit = 20): string {
    if (this.items.length === 0) return '(no session todos)';
    return this.items
      .slice(0, limit)
      .map((i) => {
        const mark =
          i.status === 'completed' ? '[x]' : i.status === 'in_progress' ? '[~]' : i.status === 'cancelled' ? '[-]' : '[ ]';
        return `${mark} ${i.id}: ${i.content}`;
      })
      .join('\n');
  }
}
