import React from 'react';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Triple-backtick inline usage (models sometimes write ```` ```ts ```` inside a sentence)
  // is rendered as inline code, not as a block fence.
  const pattern =
    /(```[^`\n]+```|`[^`\n]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}_i${index++}`;
    if (token.startsWith('```')) {
      nodes.push(<code key={key} className="md-inline-code">{token.slice(3, -3)}</code>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key} className="md-inline-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      nodes.push(
        linkMatch ? (
          <a key={key} href={linkMatch[2]} target="_blank" rel="noreferrer">
            {linkMatch[1]}
          </a>
        ) : (
          token
        )
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function CodeBlock({ language, code, t }: { language: string; code: string; t: Translate }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{language || 'text'}</span>
        <button
          className="md-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? t('chat.copied') : t('chat.copy')}
        </button>
      </div>
      <pre>
        <code>{code.replace(/\n$/, '')}</code>
      </pre>
    </div>
  );
}

/** Small dependency-free Markdown renderer tuned for agent replies. */
export function Markdown({ text, t }: { text: string; t: Translate }) {
  const blocks = React.useMemo(() => {
    const lines = text.split(/\r?\n/);
    const out: React.ReactNode[] = [];
    let key = 0;

    const renderText = (chunk: string) => {
      const chunkLines = chunk.split('\n');
      let paragraph: string[] = [];
      let i = 0;

      const flush = () => {
        if (paragraph.length === 0) return;
        out.push(<p key={`p${key++}`}>{renderInline(paragraph.join(' '), `p${key}`)}</p>);
        paragraph = [];
      };

      while (i < chunkLines.length) {
        const line = chunkLines[i].trimEnd();
        if (!line.trim()) {
          flush();
          i += 1;
          continue;
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
          flush();
          const level = heading[1].length;
          const content = renderInline(heading[2], `h${key}`);
          if (level === 1) out.push(<h2 key={`h${key++}`}>{content}</h2>);
          else if (level === 2) out.push(<h3 key={`h${key++}`}>{content}</h3>);
          else out.push(<h4 key={`h${key++}`}>{content}</h4>);
          i += 1;
          continue;
        }
        if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
          flush();
          out.push(<hr key={`hr${key++}`} />);
          i += 1;
          continue;
        }
        if (/^>\s?/.test(line)) {
          flush();
          const quote: string[] = [];
          while (i < chunkLines.length && /^>\s?/.test(chunkLines[i])) {
            quote.push(chunkLines[i].replace(/^>\s?/, ''));
            i += 1;
          }
          out.push(<blockquote key={`q${key++}`}>{renderInline(quote.join(' '), `q${key}`)}</blockquote>);
          continue;
        }
        const isBullet = /^\s*[-*+]\s+/.test(line);
        const isOrdered = /^\s*\d+[.)]\s+/.test(line);
        if (isBullet || isOrdered) {
          flush();
          const items: string[] = [];
          const matcher = isBullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
          while (i < chunkLines.length) {
            const item = matcher.exec(chunkLines[i]);
            if (!item) break;
            items.push(item[1]);
            i += 1;
          }
          const listItems = items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `li${key}_${idx}`)}</li>
          ));
          out.push(isBullet ? <ul key={`u${key++}`}>{listItems}</ul> : <ol key={`o${key++}`}>{listItems}</ol>);
          continue;
        }
        paragraph.push(line);
        i += 1;
      }
      flush();
    };

    let textBuffer: string[] = [];
    const flushText = () => {
      if (textBuffer.length === 0) return;
      renderText(textBuffer.join('\n'));
      textBuffer = [];
    };

    let i = 0;
    while (i < lines.length) {
      const open = /^```([a-zA-Z0-9+#._-]*)\s*$/.exec(lines[i]);
      if (open) {
        flushText();
        const code: string[] = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1; // closing fence
        out.push(<CodeBlock key={`c${key++}`} language={open[1]} code={code.join('\n')} t={t} />);
        continue;
      }
      textBuffer.push(lines[i]);
      i += 1;
    }
    flushText();
    return out;
  }, [text, t]);

  return <div className="md">{blocks}</div>;
}
