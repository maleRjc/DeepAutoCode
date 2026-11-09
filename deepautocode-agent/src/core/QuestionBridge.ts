export interface AskQuestionOptionItem {
  question: string;
  options: string[];
  isMultiSelect?: boolean;
}

export interface PendingQuestionPrompt {
  questionId: string;
  sessionId: string;
  questions: AskQuestionOptionItem[];
  createdAt: string;
}

export interface QuestionResponsePayload {
  questionId: string;
  answers: Record<string, string | string[]>;
  skipped?: boolean;
}

interface PendingQuestionInternal {
  prompt: PendingQuestionPrompt;
  resolve: (res: QuestionResponsePayload) => void;
}

/**
 * Antigravity-style interactive clarification bridge (`ask_question` tool).
 * Suspends the tool call until the user selects options or enters custom answers in the IDE Composer.
 */
export class QuestionBridge {
  private readonly pending = new Map<string, PendingQuestionInternal>();
  private counter = 0;

  public ask(params: {
    sessionId: string;
    questions: AskQuestionOptionItem[];
    timeoutMs?: number;
    signal?: AbortSignal;
    onPromptCreated?: (prompt: PendingQuestionPrompt) => void;
  }): Promise<QuestionResponsePayload> {
    const questionId = `q_${Date.now().toString(36)}_${++this.counter}`;
    const prompt: PendingQuestionPrompt = {
      questionId,
      sessionId: params.sessionId,
      questions: params.questions.map((q) => ({
        question: String(q.question || '').trim(),
        options: Array.isArray(q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [],
        isMultiSelect: Boolean(q.isMultiSelect),
      })),
      createdAt: new Date().toISOString(),
    };

    const timeoutMs = Math.max(5_000, Number(params.timeoutMs ?? 180_000));

    return new Promise<QuestionResponsePayload>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(questionId);
        // Auto-select recommended (first) option if user does not respond within timeout
        const defaultAnswers: Record<string, string | string[]> = {};
        for (const q of prompt.questions) {
          const first = q.options[0] || 'Proceed with default';
          defaultAnswers[q.question] = q.isMultiSelect ? [first] : first;
        }
        resolve({
          questionId,
          answers: defaultAnswers,
          skipped: true,
        });
      }, timeoutMs);

      const finish = (res: QuestionResponsePayload) => {
        clearTimeout(timer);
        this.pending.delete(questionId);
        resolve(res);
      };

      if (params.signal) {
        params.signal.addEventListener(
          'abort',
          () => {
            finish({ questionId, answers: {}, skipped: true });
          },
          { once: true }
        );
      }

      this.pending.set(questionId, { prompt, resolve: finish });
      params.onPromptCreated?.(prompt);
    });
  }

  public respond(payload: QuestionResponsePayload): boolean {
    const entry = this.pending.get(payload.questionId);
    if (!entry) return false;
    entry.resolve(payload);
    return true;
  }

  public getPendingForSession(sessionId: string): PendingQuestionPrompt[] {
    const out: PendingQuestionPrompt[] = [];
    for (const entry of this.pending.values()) {
      if (entry.prompt.sessionId === sessionId) {
        out.push(entry.prompt);
      }
    }
    return out;
  }

  public cancelSessionQuestions(sessionId: string): number {
    let count = 0;
    for (const [id, entry] of this.pending.entries()) {
      if (entry.prompt.sessionId === sessionId) {
        this.pending.delete(id);
        entry.resolve({ questionId: id, answers: {}, skipped: true });
        count += 1;
      }
    }
    return count;
  }
}

export const globalQuestionBridge = new QuestionBridge();

