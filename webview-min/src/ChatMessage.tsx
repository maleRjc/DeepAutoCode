import React from 'react';
import { Markdown } from './Markdown';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface ChatToolCall {
  toolCallId: string;
  toolName: string;
  status: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ChatMessageModel {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: ChatToolCall[];
  timestamp: string;
}

const TOOL_ICONS: Record<string, string> = {
  read: '📖',
  write: '✍️',
  edit: '✏️',
  str_replace_editor: '✏️',
  bash: '⌨️',
  pwsh: '⌨️',
  todo: '☑️',
  ask_user_question: '❓',
  present: '🖼️',
  web_search: '🌐',
  web_fetch: '🌐',
};

export function toolIcon(name: string): string {
  const key = Object.keys(TOOL_ICONS).find((candidate) => name.toLowerCase().includes(candidate));
  return key ? TOOL_ICONS[key] : '🔧';
}

export function ToolCallCard({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = React.useState(call.status === 'running');
  const failed = call.status === 'failed' || call.status === 'rejected';
  const done = call.status === 'completed';
  const args = call.args ? JSON.stringify(call.args, null, 2) : '';
  const result =
    call.result == null ? '' : typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2);

  return (
    <div className={`tool-card ${failed ? 'failed' : done ? 'done' : 'running'}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-icon">{toolIcon(call.toolName)}</span>
        <span className="tool-name">{call.toolName}</span>
        <span className={`tool-status ${failed ? 'failed' : done ? 'done' : 'running'}`}>
          {call.status}
        </span>
        {typeof call.durationMs === 'number' && (
          <span className="tool-duration">{call.durationMs}ms</span>
        )}
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-detail">
          {args && (
            <div className="tool-section">
              <div className="tool-section-title">arguments</div>
              <pre>{args}</pre>
            </div>
          )}
          {result && (
            <div className="tool-section">
              <div className="tool-section-title">result</div>
              <pre>{result.slice(0, 8000)}</pre>
            </div>
          )}
          {call.error && (
            <div className="tool-section">
              <div className="tool-section-title">error</div>
              <pre className="err">{call.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ChatMessage({
  message,
  t,
  streaming = false,
}: {
  message: ChatMessageModel;
  t: Translate;
  streaming?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const isUser = message.role === 'user';
  const isError = message.role === 'error';

  const copy = () => {
    void navigator.clipboard?.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={`chat-msg ${isUser ? 'user' : isError ? 'error' : 'assistant'} ${streaming ? 'streaming' : ''}`}>
      <div className="chat-msg-head">
        <span className="chat-avatar">{isUser ? '🙋' : isError ? '!' : '✦'}</span>
        <span className="chat-who">{isUser ? t('chat.you') : isError ? t('chat.error') : t('chat.ai')}</span>
        <span className="chat-time">{formatTime(message.timestamp)}</span>
        {!isUser && !isError && message.content && (
          <button className="chat-copy" onClick={copy}>
            {copied ? t('chat.copied') : t('chat.copyAnswer')}
          </button>
        )}
      </div>

      {message.thinking && (
        <details className="thinking" open={streaming}>
          <summary>{streaming ? t('chat.thinkingNow') : t('chat.thinking')}</summary>
          <div className="thinking-body">
            <Markdown text={message.thinking} t={t} />
          </div>
        </details>
      )}

      {isError ? (
        <div className="error-text">{message.content}</div>
      ) : (
        message.content && (
          <div className="chat-msg-body">
            <Markdown text={message.content} t={t} />
            {streaming && <span className="stream-caret" />}
          </div>
        )
      )}

      {message.toolCalls?.map((call) => (
        <ToolCallCard key={call.toolCallId} call={call} />
      ))}
    </div>
  );
}
