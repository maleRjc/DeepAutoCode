import React from 'react';
import { BrandMark } from './BrandMark';
import { APP_LOCALES } from '../i18n/index.js';
import {
  formatCompactTokens,
  IMAGE_FILE_EXT_PATTERN,
  getImageMimeType,
  wordAtCursor,
  buildCheckpointContentDiff,
  formatToolStepLabel,
  parseDiffToSplitRows,
  parseSourceReferenceToken,
  findBestLineMatchInContent,
  formatLatexMathText,
  extractLatestSourceRefFromText,
  extractCompactExecutiveSummary,
  getFileVisualMeta,
  renderSyntaxHighlightedLine,
} from '../utils/workbenchUtils';

export function createMarkdownRenderer(ctx: any) {
  const {
    workspaceRoot,
    files,
    expandedMessageIds,
    setExpandedMessageIds,
    carouselSlideIndices,
    setCarouselSlideIndices,
    installedCatalogPlugins,
    setInstalledCatalogPlugins,
    setAiTab,
    setShowRightAiDock,
    setShowLeftSidebar,
    setActiveActivity,
    setShowBottomPanel,
    setActiveBottomTab,
    openSettingsCenter,
    openWebPreviewTab,
    setStatusNotice,
    bridge,
    activeSessionId,
    navigateToSourceLocation,
    navigateToAiCodeSnippet,
    navigateToInlineCodeOrSymbol,
    parseSourceReferenceToken: parseRef,
    extractLatestSourceRefFromText: extractRef,
    extractCompactExecutiveSummary: extractSummary,
  } = ctx;

  function renderPlainTextWithSourceLinks(
    text: string,
    keyPrefix: string,
    _contextRef?: { filePath?: string; startLine?: number; endLine?: number }
  ): React.ReactNode[] {
    // Linear-time O(N) token split by Markdown links or word/punctuation delimiters (zero backtracking)
    const tokens = text.split(/(\[[^\]]+\]\([^)]+\)|[\s,;()[\]{}<>"'，；。（）【】「」|]+)/g);
    return tokens.map((token, idx) => {
      if (!token) return null;
      if (token.startsWith('[')) {
        const mdLink = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (mdLink) {
          const label = mdLink[1];
          const href = mdLink[2].trim();
          if (/^https?:\/\//i.test(href)) {
            return (
              <a
                key={`${keyPrefix}_a_${idx}`}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="md-source-link"
              >
                {label} ↗
              </a>
            );
          }
          if (/^conversation:\/\//i.test(href)) {
            const convId = href.replace(/^conversation:\/\/\/?/i, '');
            return (
              <code
                key={`${keyPrefix}_conv_${idx}`}
                className="md-inline-code md-source-link"
                style={{
                  color: '#a78bfa',
                  borderColor: 'rgba(167, 139, 250, 0.45)',
                  background: 'rgba(167, 139, 250, 0.12)',
                }}
                title={`Click to inspect subagent conversation: ${convId}`}
                onClick={() => {
                  setAiTab('trace');
                  setShowRightAiDock(true);
                  setStatusNotice(`Inspecting Subagent Conversation: ${convId}`);
                }}
              >
                🤖 {label} ({convId.slice(0, 12)})
              </code>
            );
          }
          const lineHashMatch = href.match(/^(.*?)#L?(\d+)(?:-L?(\d+))?$/i);
          const rawTargetPath = (lineHashMatch ? lineHashMatch[1] : href)
            .replace(/^file:\/\/\/?/i, '')
            .replace(/\\/g, '/');
          const linkStartLine = lineHashMatch ? Number(lineHashMatch[2]) : undefined;
          const linkEndLine =
            lineHashMatch && lineHashMatch[3] ? Number(lineHashMatch[3]) : undefined;
          const normWsRoot = (workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
          const relTargetPath =
            normWsRoot && rawTargetPath.toLowerCase().startsWith(normWsRoot.toLowerCase() + '/')
              ? rawTargetPath.slice(normWsRoot.length + 1)
              : rawTargetPath;
          return (
            <code
              key={`${keyPrefix}_l_${idx}`}
              className="md-inline-code md-source-link"
              title={`Click to open in editor: ${relTargetPath}${linkStartLine ? `:${linkStartLine}` : ''}`}
              onClick={() =>
                void navigateToSourceLocation(relTargetPath, linkStartLine, linkEndLine)
              }
            >
              📄 {label}
              {linkStartLine
                ? `:${linkStartLine}${linkEndLine && linkEndLine > linkStartLine ? `-${linkEndLine}` : ''}`
                : ''}
            </code>
          );
        }
      }
      const parsed = parseSourceReferenceToken(token);
      if (parsed) {
        return (
          <code
            key={`${keyPrefix}_s_${idx}`}
            className="md-inline-code md-source-link"
            title={`Click to jump to source: ${parsed.display}`}
            onClick={() =>
              void navigateToSourceLocation(
                parsed.filePath,
                parsed.startLine,
                parsed.endLine
              )
            }
          >
            📍 {parsed.display}
          </code>
        );
      }
      return <React.Fragment key={`${keyPrefix}_t_${idx}`}>{token}</React.Fragment>;
    });
  }

  function renderInlineFormatted(
    text: string,
    contextRef?: { filePath?: string; startLine?: number; endLine?: number }
  ): React.ReactNode[] {
    const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g);
    return tokens.map((tok, idx) => {
      if (
        (tok.startsWith('$') && tok.endsWith('$') && tok.length > 2 && !/^\$\d/.test(tok)) ||
        (tok.startsWith('\\(') && tok.endsWith('\\)'))
      ) {
        const rawMath = tok.startsWith('\\(') ? tok.slice(2, -2) : tok.slice(1, -1);
        return (
          <span
            key={idx}
            style={{
              fontFamily: ' Cambria, "Times New Roman", serif',
              fontStyle: 'italic',
              padding: '0 4px',
              borderRadius: 4,
              background: 'rgba(56, 189, 248, 0.1)',
              color: '#7dd3fc',
            }}
            title={`LaTeX: ${rawMath}`}
          >
            {formatLatexMathText(rawMath)}
          </span>
        );
      }
      if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
        const inner = tok.slice(1, -1);
        const parsedRef = parseSourceReferenceToken(inner);
        const isClickableSymbol =
          Boolean(parsedRef) ||
          Boolean(contextRef?.filePath) ||
          /^[a-zA-Z_][a-zA-Z0-9_:.-]{2,80}(\(\))?$/.test(inner.trim());
        return (
          <code
            key={idx}
            className={`md-inline-code ${
              parsedRef
                ? 'md-source-link'
                : isClickableSymbol
                  ? 'md-symbol-link'
                  : ''
            }`}
            title={
              parsedRef
                ? `Click to jump to source location: ${parsedRef.display}`
                : isClickableSymbol
                  ? `Click to locate in editor: ${inner}`
                  : undefined
            }
            onClick={
              isClickableSymbol
                ? () => void navigateToInlineCodeOrSymbol(inner, contextRef)
                : undefined
            }
          >
            {parsedRef ? `📍 ${inner}` : inner}
          </code>
        );
      }
      if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
        return (
          <strong key={idx}>
            {renderPlainTextWithSourceLinks(tok.slice(2, -2), `b_${idx}`, contextRef)}
          </strong>
        );
      }
      return (
        <React.Fragment key={idx}>
          {renderPlainTextWithSourceLinks(tok, `p_${idx}`, contextRef)}
        </React.Fragment>
      );
    });
  }

  function extractLatestSourceRefFromText(
    textChunk: string,
    prevRef?: { filePath?: string; startLine?: number; endLine?: number }
  ): { filePath?: string; startLine?: number; endLine?: number } | undefined {
    const words = String(textChunk ?? '').split(/[\s,;()[\]{}<>"'`，；。（）【】「」|]+/);
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (!w || !w.includes('.')) continue;
      const parsed = parseSourceReferenceToken(w);
      if (parsed) {
        return {
          filePath: parsed.filePath,
          startLine: parsed.startLine,
          endLine: parsed.endLine,
        };
      }
    }
    return prevRef;
  }

  function extractCompactExecutiveSummary(cleaned: string): {
    conclusionLines: string[];
    sourceRefs: Array<{
      filePath: string;
      startLine?: number;
      endLine?: number;
      display: string;
    }>;
    primaryCodeBlock?: {
      lang: string;
      codeBody: string;
      context?: { filePath?: string; startLine?: number; endLine?: number };
    };
  } {
    const rawLines = cleaned.split('\n');
    const conclusionLines: string[] = [];

    // 1. Prioritize lines under "结论", "根因定位", "核心原因", "决定性因素", or "修改内容"
    let inConclusionSection = false;
    for (const rawLine of rawLines) {
      const t = rawLine.trim();
      if (!t || t === '---' || t.startsWith('```') || t.startsWith('|')) {
        if (inConclusionSection && conclusionLines.length >= 2) break;
        continue;
      }
      if (/^(?:#+\s*)?(?:🎯\s*)?(?:结论|核心原因|根因定位|核心结论|总结)\b/.test(t)) {
        inConclusionSection = true;
        const inlineAfterColon = t.replace(
          /^(?:#+\s*)?(?:🎯\s*)?(?:结论|核心原因|根因定位|核心结论|总结)\s*[:：]?\s*/,
          ''
        );
        if (inlineAfterColon.length >= 8) {
          conclusionLines.push(inlineAfterColon);
        }
        continue;
      }
      if (/^(?:\*\*|[-*•]\s*)?(?:决定性因素|核心修复|修改内容|验证结果)\s*[:：]/.test(t)) {
        conclusionLines.push(t.replace(/^[-*•]\s*/, ''));
        if (conclusionLines.length >= 3) break;
        continue;
      }
      if (inConclusionSection && !t.startsWith('#')) {
        conclusionLines.push(t.replace(/^[-*•]\s*/, ''));
        if (conclusionLines.length >= 3) break;
      }
    }

    // Fallback: pick first 2 meaningful prose lines (not headings, tables, or code fences)
    if (conclusionLines.length === 0) {
      let insideFence = false;
      for (const rawLine of rawLines) {
        const t = rawLine.trim();
        if (t.startsWith('```')) {
          insideFence = !insideFence;
          continue;
        }
        if (insideFence || !t || t.startsWith('#') || t.startsWith('|') || t === '---') {
          continue;
        }
        if (t.length >= 10) {
          conclusionLines.push(t.replace(/^[-*•]\s*/, ''));
          if (conclusionLines.length >= 2) break;
        }
      }
    }

    // 2. Collect unique file:line references across the entire message using linear-time word splitting
    const sourceRefs: Array<{
      filePath: string;
      startLine?: number;
      endLine?: number;
      display: string;
    }> = [];
    const seenRefKeys = new Set<string>();
    const allTokens = cleaned.split(/[\s,;()[\]{}<>"'`，；。（）【】「」|]+/);
    for (const tok of allTokens) {
      if (!tok || !tok.includes('.')) continue;
      const parsed = parseSourceReferenceToken(tok);
      if (!parsed) continue;
      const key = `${parsed.filePath}:${parsed.startLine || 0}`;
      if (seenRefKeys.has(key)) continue;
      seenRefKeys.add(key);
      sourceRefs.push(parsed);
      if (sourceRefs.length >= 6) break;
    }

    // 3. Pick the primary source code block (preferring C/C++/TS/Py/JS over bash/log blocks)
    const segments = cleaned.split(/(```[\s\S]*?```)/g);
    let runningCtx: { filePath?: string; startLine?: number; endLine?: number } | undefined;
    let primaryCodeBlock:
      | {
          lang: string;
          codeBody: string;
          context?: { filePath?: string; startLine?: number; endLine?: number };
        }
      | undefined;

    for (const seg of segments) {
      if (seg.startsWith('```') && seg.endsWith('```')) {
        const lines = seg.slice(3, -3).split('\n');
        const firstLine = (lines[0] || '').trim();
        const hasLang = /^[a-zA-Z0-9_+-]+$/.test(firstLine);
        const lang = hasLang ? firstLine.toLowerCase() : 'code';
        const codeBody = (hasLang ? lines.slice(1) : lines).join('\n').trim();
        if (!codeBody) continue;
        const isSourceCodeLang = /^(c|cpp|cc|cxx|cu|h|hpp|ts|tsx|js|jsx|py|python|go|rust|java)$/.test(
          lang
        );
        if (!primaryCodeBlock || (isSourceCodeLang && primaryCodeBlock.lang === 'code')) {
          const isShellLang = /^(bash|sh|zsh|shell|cmd|powershell|ps1)$/i.test(lang);
          primaryCodeBlock = {
            lang: lang.toUpperCase(),
            codeBody,
            context: isShellLang ? undefined : runningCtx ? { ...runningCtx } : sourceRefs[0],
          };
          if (isSourceCodeLang) break;
        }
      } else {
        for (const l of seg.split('\n')) {
          runningCtx = extractLatestSourceRefFromText(l.trim(), runningCtx);
        }
      }
    }

    return { conclusionLines, sourceRefs, primaryCodeBlock };
  }

  function renderFormattedMarkdown(
    rawContent: string,
    messageId?: string,
    role: string = 'assistant'
  ): React.ReactNode {
    try {
      return renderFormattedMarkdownInner(rawContent, messageId, role);
    } catch {
      return <pre className="md-code-pre">{String(rawContent ?? '')}</pre>;
    }
  }

  function renderFormattedMarkdownInner(
    rawContent: string,
    messageId?: string,
    role: string = 'assistant'
  ): React.ReactNode {
    const cleaned = String(rawContent ?? '')
      .replace(/^\[Context Active File:[^\]]+\]\s*/i, '')
      .trim();
    if (!cleaned) return null;

    const totalLines = cleaned.split('\n').length;
    const isLongAssistantReply =
      role === 'assistant' && Boolean(messageId) && (totalLines > 16 || cleaned.length > 520);
    const isExpanded = messageId ? expandedMessageIds[messageId] !== false : true;
    const compactSummary = isLongAssistantReply
      ? extractCompactExecutiveSummary(cleaned)
      : null;

    // Split by fenced code blocks ```lang ... ```
    const segments = cleaned.split(/(```[\s\S]*?```)/g);
    let activeSourceContext:
      | { filePath?: string; startLine?: number; endLine?: number }
      | undefined;

    return (
      <div className="md-body">
        {isLongAssistantReply && compactSummary && (
          <div className="md-glance-card">
            <div className="md-glance-header">
              <span style={{ fontWeight: 700, color: 'var(--accent-bright)' }}>
                ⚡ Executive Summary
              </span>
              <button
                type="button"
                className="btn"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={() =>
                  messageId &&
                  setExpandedMessageIds((prev) => ({
                    ...prev,
                    [messageId]: prev[messageId] === false ? true : false,
                  }))
                }
              >
                {isExpanded
                  ? '▴ Collapse Details (Summary Only)'
                  : `▾ Expand Full Analysis (${totalLines} lines)`}
              </button>
            </div>

            {compactSummary.conclusionLines.length > 0 && (
              <div className="md-glance-conclusion">
                {compactSummary.conclusionLines.map((cLine, idx) => (
                  <div key={idx} className="md-glance-line">
                    {renderInlineFormatted(cLine, compactSummary.sourceRefs[0])}
                  </div>
                ))}
              </div>
            )}

            {compactSummary.sourceRefs.length > 0 && (
              <div className="md-glance-refs">
                <span className="md-glance-refs-label">Source References:</span>
                {compactSummary.sourceRefs.map((ref, idx) => (
                  <code
                    key={idx}
                    className="md-inline-code md-source-link"
                    title={`Click to open and locate ${ref.display} in editor`}
                    onClick={() =>
                      void navigateToSourceLocation(
                        ref.filePath,
                        ref.startLine,
                        ref.endLine
                      )
                    }
                  >
                    📍 {ref.display}
                  </code>
                ))}
              </div>
            )}

            {!isExpanded && compactSummary.primaryCodeBlock && (
              <div className="md-code-block" style={{ marginTop: 4 }}>
                <div className="md-code-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>Key Code ({compactSummary.primaryCodeBlock.lang})</span>
                    {compactSummary.primaryCodeBlock.context?.filePath && (
                      <span
                        className="md-code-file-badge"
                        onClick={() =>
                          void navigateToAiCodeSnippet(
                            compactSummary.primaryCodeBlock!.codeBody,
                            compactSummary.primaryCodeBlock!.lang,
                            undefined,
                            compactSummary.primaryCodeBlock!.context
                          )
                        }
                      >
                        📍 {compactSummary.primaryCodeBlock.context.filePath}
                        {compactSummary.primaryCodeBlock.context.startLine
                          ? `:${compactSummary.primaryCodeBlock.context.startLine}`
                          : ''}
                      </span>
                    )}
                  </div>
                  <button
                    className="btn"
                    style={{ padding: '1px 6px', fontSize: 10 }}
                    onClick={() =>
                      void navigateToAiCodeSnippet(
                        compactSummary.primaryCodeBlock!.codeBody,
                        compactSummary.primaryCodeBlock!.lang,
                        undefined,
                        compactSummary.primaryCodeBlock!.context
                      )
                    }
                  >
                    🔍 Open in Editor
                  </button>
                </div>
                <pre className="md-code-pre">
                  <code>
                    {compactSummary.primaryCodeBlock.codeBody
                      .split('\n')
                      .slice(0, 10)
                      .map((cLine, cIdx) => (
                        <div
                          key={cIdx}
                          className="md-code-line"
                          title="双击此行可在编辑器中定位；拖选可复制"
                          onDoubleClick={() =>
                            void navigateToAiCodeSnippet(
                              compactSummary.primaryCodeBlock!.codeBody,
                              compactSummary.primaryCodeBlock!.lang,
                              cLine,
                              compactSummary.primaryCodeBlock!.context
                            )
                          }
                        >
                          <span className="md-code-line-num">
                            {(compactSummary.primaryCodeBlock?.context?.startLine ?? 1) +
                              cIdx}
                          </span>
                          <span className="md-code-line-text">{cLine || ' '}</span>
                        </div>
                      ))}
                  </code>
                </pre>
              </div>
            )}
          </div>
        )}

        {(!isLongAssistantReply || isExpanded) &&
          segments.map((segment, segIdx) => {
          if (segment.startsWith('```') && segment.endsWith('```')) {
            const lines = segment.slice(3, -3).split('\n');
            const firstLine = (lines[0] || '').trim();
            const hasLang = /^[a-zA-Z0-9_+-]+$/.test(firstLine);
            const lang = hasLang ? firstLine : 'code';
            const codeBody = (hasLang ? lines.slice(1) : lines).join('\n').trim();
            const codeLinesArr = codeBody.split('\n');
            const capturedContext = activeSourceContext
              ? { ...activeSourceContext }
              : undefined;
            const contextBadgeLabel = capturedContext?.filePath
              ? `${capturedContext.filePath}${
                  capturedContext.startLine
                    ? `:${capturedContext.startLine}${
                        capturedContext.endLine &&
                        capturedContext.endLine > capturedContext.startLine
                          ? `-${capturedContext.endLine}`
                          : ''
                      }`
                    : ''
                }`
              : null;

            const isMermaid = lang.toLowerCase() === 'mermaid';
            const isCarousel =
              lang.toLowerCase() === 'carousel' || codeBody.includes('<!-- slide -->');
            const isHtmlWidget =
              lang.toLowerCase() === 'html' &&
              (codeBody.includes('<style') ||
                codeBody.includes('<script') ||
                codeBody.includes('<svg') ||
                codeBody.includes('<div'));

            if (isCarousel) {
              const slides = codeBody
                .split(/<!--\s*slide\s*-->/i)
                .map((s) => s.trim())
                .filter(Boolean);
              const carouselKey = `${messageId || 'msg'}_car_${segIdx}`;
              const currentSlide = Math.min(
                Math.max(0, carouselSlideIndices[carouselKey] || 0),
                Math.max(0, slides.length - 1)
              );
              return (
                <div
                  key={segIdx}
                  className="md-code-block"
                  style={{
                    border: '1px solid rgba(167, 139, 250, 0.4)',
                    background: 'rgba(30, 27, 75, 0.35)',
                  }}
                >
                  <div className="md-code-header">
                    <span style={{ color: '#a78bfa', fontWeight: 700 }}>
                      🎠 CAROUSEL ({currentSlide + 1} / {slides.length || 1})
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn"
                        disabled={currentSlide <= 0}
                        style={{ padding: '1px 7px', fontSize: 10 }}
                        onClick={() =>
                          setCarouselSlideIndices((prev) => ({
                            ...prev,
                            [carouselKey]: Math.max(0, currentSlide - 1),
                          }))
                        }
                      >
                        ◀ Prev
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={currentSlide >= slides.length - 1}
                        style={{ padding: '1px 7px', fontSize: 10 }}
                        onClick={() =>
                          setCarouselSlideIndices((prev) => ({
                            ...prev,
                            [carouselKey]: Math.min(slides.length - 1, currentSlide + 1),
                          }))
                        }
                      >
                        Next ▶
                      </button>
                    </div>
                  </div>
                  <div style={{ padding: '10px 12px', fontSize: 12 }}>
                    <pre className="md-code-pre" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                      {slides[currentSlide] || codeBody}
                    </pre>
                  </div>
                </div>
              );
            }

            if (isMermaid) {
              const flowEdges = codeLinesArr
                .map((l) => l.trim())
                .filter(
                  (l) =>
                    l &&
                    !/^(?:flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram)\b/i.test(
                      l
                    ) &&
                    !l.startsWith('%%')
                );
              return (
                <div
                  key={segIdx}
                  className="md-code-block"
                  style={{
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    background: 'rgba(15, 23, 42, 0.45)',
                  }}
                >
                  <div className="md-code-header">
                    <span style={{ color: '#38bdf8', fontWeight: 700 }}>
                      📊 MERMAID DIAGRAM
                    </span>
                    <button
                      className="btn"
                      style={{ padding: '1px 6px', fontSize: 10 }}
                      onClick={() => {
                        void navigator.clipboard.writeText(codeBody);
                        setStatusNotice('Copied Mermaid diagram source');
                      }}
                    >
                      📋 Copy Mermaid
                    </button>
                  </div>
                  <div
                    style={{
                      padding: '10px 12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    {flowEdges.map((edge, eIdx) => {
                      const parts = edge
                        .split(/\s*(?:-->|==>|-\.->|-->>|->>|->|---)\s*/)
                        .map((p) =>
                          p
                            .replace(/^[A-Za-z0-9_]+\s*[\[\(\{]+/, '')
                            .replace(/[\]\)\}]+$/, '')
                            .replace(/^["']|["']$/g, '')
                            .trim()
                        )
                        .filter(Boolean);
                      if (parts.length >= 2) {
                        return (
                          <div
                            key={eIdx}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              flexWrap: 'wrap',
                              gap: 6,
                              fontSize: 11.5,
                            }}
                          >
                            {parts.map((nodeLabel, nIdx) => (
                              <React.Fragment key={nIdx}>
                                <span
                                  style={{
                                    padding: '3px 9px',
                                    borderRadius: 6,
                                    background: 'rgba(56, 189, 248, 0.14)',
                                    border: '1px solid rgba(56, 189, 248, 0.35)',
                                    color: 'var(--text-primary)',
                                    fontWeight: 600,
                                  }}
                                >
                                  {nodeLabel}
                                </span>
                                {nIdx < parts.length - 1 && (
                                  <span style={{ color: '#38bdf8', fontWeight: 700 }}>→</span>
                                )}
                              </React.Fragment>
                            ))}
                          </div>
                        );
                      }
                      return (
                        <div
                          key={eIdx}
                          style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}
                        >
                          {edge}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }

            return (
              <div key={segIdx} className="md-code-block">
                <div className="md-code-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{lang.toUpperCase()}</span>
                    {contextBadgeLabel && (
                      <span
                        className="md-code-file-badge"
                        title={`Click to open ${contextBadgeLabel} in editor`}
                        onClick={() =>
                          void navigateToAiCodeSnippet(
                            codeBody,
                            lang,
                            undefined,
                            capturedContext
                          )
                        }
                      >
                        📍 {contextBadgeLabel}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      className="btn"
                      style={{ padding: '1px 6px', fontSize: 10 }}
                      title="Open and locate this code snippet in editor"
                      onClick={() =>
                        void navigateToAiCodeSnippet(
                          codeBody,
                          lang,
                          undefined,
                          capturedContext
                        )
                      }
                    >
                      🔍 View in Editor
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '1px 6px', fontSize: 10 }}
                      onClick={() => {
                        void navigator.clipboard.writeText(codeBody);
                        setStatusNotice('Copied code snippet to clipboard');
                      }}
                    >
                      📋 Copy Code
                    </button>
                  </div>
                </div>
                {isHtmlWidget && (
                  <div
                    style={{
                      borderBottom: '1px solid var(--border)',
                      background: '#ffffff',
                      borderRadius: 4,
                      margin: '6px 8px',
                      overflow: 'hidden',
                    }}
                  >
                    <iframe
                      title={`widget-${segIdx}`}
                      sandbox="allow-scripts"
                      srcDoc={codeBody}
                      style={{ width: '100%', height: 180, border: 'none', display: 'block' }}
                    />
                  </div>
                )}
                <pre className="md-code-pre">
                  <code>
                    {codeLinesArr.map((cLine, cIdx) => (
                      <div
                        key={cIdx}
                        className="md-code-line"
                        title="双击此行可在编辑器中定位；拖选可复制"
                        onDoubleClick={() =>
                          void navigateToAiCodeSnippet(
                            codeBody,
                            lang,
                            cLine,
                            capturedContext
                          )
                        }
                      >
                        <span className="md-code-line-num">
                          {(capturedContext?.startLine ?? 1) + cIdx}
                        </span>
                        <span className="md-code-line-text">{cLine || ' '}</span>
                      </div>
                    ))}
                  </code>
                </pre>
              </div>
            );
          }

          const lines = segment.split('\n');
          const elements: React.ReactNode[] = [];
          let listBuffer: { ordered: boolean; items: string[] } | null = null;
          let tableBuffer: string[][] | null = null;

          const flushList = (keyPrefix: string) => {
            if (!listBuffer) return;
            const ListTag = listBuffer.ordered ? 'ol' : 'ul';
            const ctxSnap = activeSourceContext ? { ...activeSourceContext } : undefined;
            elements.push(
              <ListTag key={keyPrefix} className="md-list">
                {listBuffer.items.map((item, i) => (
                  <li key={i} className="md-li">
                    {renderInlineFormatted(item, ctxSnap)}
                  </li>
                ))}
              </ListTag>
            );
            listBuffer = null;
          };

          const flushTable = (keyPrefix: string) => {
            if (!tableBuffer || tableBuffer.length === 0) return;
            const rows = tableBuffer.filter(
              (r) => !r.every((cell) => /^[:\-\s]+$/.test(cell))
            );
            tableBuffer = null;
            if (rows.length === 0) return;

            const headerRow = rows[0];
            const bodyRows = rows.slice(1);

            elements.push(
              <div key={keyPrefix} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>
                      {headerRow.map((hCell, cIdx) => (
                        <th key={cIdx}>{renderInlineFormatted(hCell, activeSourceContext)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bodyRows.map((row, rIdx) => {
                      // Check if this row has a file column and a separate line-range column (e.g. | src/init.cc | 1663-1687 |)
                      let rowFileRef: string | undefined;
                      let rowStartLine: number | undefined;
                      let rowEndLine: number | undefined;

                      for (const cell of row) {
                        const cleanCell = cell.replace(/`/g, '').trim();
                        const parsed = parseSourceReferenceToken(cleanCell);
                        if (parsed) {
                          rowFileRef = parsed.filePath;
                          if (parsed.startLine) rowStartLine = parsed.startLine;
                          if (parsed.endLine) rowEndLine = parsed.endLine;
                        } else if (/^\d+(?:\s*[-~]\s*\d+)?$/.test(cleanCell) && !rowStartLine) {
                          const parts = cleanCell.split(/[-~]/).map((s) => Number(s.trim()));
                          rowStartLine = parts[0];
                          if (parts[1]) rowEndLine = parts[1];
                        }
                      }

                      const rowCtx = rowFileRef
                        ? {
                            filePath: rowFileRef,
                            startLine: rowStartLine,
                            endLine: rowEndLine,
                          }
                        : activeSourceContext;

                      return (
                        <tr key={rIdx}>
                          {row.map((cell, cIdx) => {
                            const cleanCell = cell.replace(/`/g, '').trim();
                            const isPureLineRange =
                              Boolean(rowFileRef) && /^\d+(?:\s*[-~]\s*\d+)?$/.test(cleanCell);
                            const cellParsed = parseSourceReferenceToken(cleanCell);

                            if (cellParsed && rowStartLine && !cellParsed.startLine) {
                              return (
                                <td key={cIdx}>
                                  <code
                                    className="md-inline-code md-source-link"
                                    title={`Click to open ${cellParsed.filePath}:${rowStartLine}`}
                                    onClick={() =>
                                      void navigateToSourceLocation(
                                        cellParsed.filePath,
                                        rowStartLine,
                                        rowEndLine
                                      )
                                    }
                                  >
                                    📍 {cleanCell}
                                  </code>
                                </td>
                              );
                            }

                            if (isPureLineRange && rowFileRef && rowStartLine) {
                              return (
                                <td key={cIdx}>
                                  <code
                                    className="md-inline-code md-source-link"
                                    title={`Click to jump to ${rowFileRef}:${cleanCell}`}
                                    onClick={() =>
                                      void navigateToSourceLocation(
                                        rowFileRef!,
                                        rowStartLine,
                                        rowEndLine
                                      )
                                    }
                                  >
                                    L{cleanCell} ↗
                                  </code>
                                </td>
                              );
                            }

                            return <td key={cIdx}>{renderInlineFormatted(cell, rowCtx)}</td>;
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          };

          lines.forEach((line, lineIdx) => {
            const trimmed = line.trim();
            activeSourceContext = extractLatestSourceRefFromText(
              trimmed,
              activeSourceContext
            );

            if (!trimmed) {
              flushList(`list_${segIdx}_${lineIdx}`);
              flushTable(`tbl_${segIdx}_${lineIdx}`);
              return;
            }

            // Detect Markdown table rows: | col1 | col2 |
            if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
              flushList(`list_${segIdx}_${lineIdx}`);
              const cells = trimmed
                .slice(1, -1)
                .split('|')
                .map((c) => c.trim());
              if (!tableBuffer) tableBuffer = [];
              tableBuffer.push(cells);
              return;
            } else if (tableBuffer) {
              flushTable(`tbl_${segIdx}_${lineIdx}`);
            }

            const ctxSnap = activeSourceContext ? { ...activeSourceContext } : undefined;

            if (trimmed.startsWith('### ')) {
              flushList(`list_${segIdx}_${lineIdx}`);
              elements.push(
                <h4 key={`h3_${lineIdx}`} className="md-h3">
                  {renderInlineFormatted(trimmed.slice(4), ctxSnap)}
                </h4>
              );
            } else if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
              flushList(`list_${segIdx}_${lineIdx}`);
              const titleText = trimmed.replace(/^#+\s*/, '');
              elements.push(
                <h3 key={`h2_${lineIdx}`} className="md-h2">
                  {renderInlineFormatted(titleText, ctxSnap)}
                </h3>
              );
            } else if (/^[-*•]\s+/.test(trimmed)) {
              const itemText = trimmed.replace(/^[-*•]\s+/, '');
              if (!listBuffer || listBuffer.ordered) {
                flushList(`list_${segIdx}_${lineIdx}`);
                listBuffer = { ordered: false, items: [] };
              }
              listBuffer.items.push(itemText);
            } else if (/^\d+\.\s+/.test(trimmed)) {
              const itemText = trimmed.replace(/^\d+\.\s+/, '');
              if (!listBuffer || !listBuffer.ordered) {
                flushList(`list_${segIdx}_${lineIdx}`);
                listBuffer = { ordered: true, items: [] };
              }
              listBuffer.items.push(itemText);
            } else if (trimmed.startsWith('> ')) {
              flushList(`list_${segIdx}_${lineIdx}`);
              const quoteBody = trimmed.slice(2).trim();
              const alertMatch = quoteBody.match(
                /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i
              );
              if (alertMatch) {
                const kind = alertMatch[1].toUpperCase();
                const restText = alertMatch[2] || '';
                const colorMap: Record<string, { border: string; bg: string; icon: string }> = {
                  NOTE: { border: '#38bdf8', bg: 'rgba(56, 189, 248, 0.1)', icon: 'ℹ️ NOTE' },
                  TIP: { border: '#34d399', bg: 'rgba(52, 211, 153, 0.1)', icon: '💡 TIP' },
                  IMPORTANT: {
                    border: '#a78bfa',
                    bg: 'rgba(167, 139, 250, 0.12)',
                    icon: '📌 IMPORTANT',
                  },
                  WARNING: {
                    border: '#fbbf24',
                    bg: 'rgba(251, 191, 36, 0.12)',
                    icon: '⚠️ WARNING',
                  },
                  CAUTION: {
                    border: '#f87171',
                    bg: 'rgba(248, 113, 113, 0.12)',
                    icon: '🚨 CAUTION',
                  },
                };
                const styleMeta = colorMap[kind] || colorMap.NOTE;
                elements.push(
                  <div
                    key={`alert_${lineIdx}`}
                    style={{
                      borderLeft: `3px solid ${styleMeta.border}`,
                      background: styleMeta.bg,
                      padding: '7px 10px',
                      borderRadius: 6,
                      margin: '6px 0',
                      fontSize: 12,
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        color: styleMeta.border,
                        fontSize: 11,
                        marginBottom: restText ? 3 : 0,
                      }}
                    >
                      {styleMeta.icon}
                    </div>
                    {restText && <div>{renderInlineFormatted(restText, ctxSnap)}</div>}
                  </div>
                );
              } else {
                elements.push(
                  <blockquote key={`q_${lineIdx}`} className="md-quote">
                    {renderInlineFormatted(quoteBody, ctxSnap)}
                  </blockquote>
                );
              }
            } else if (/<plugin-card\s+catalog-id=["']([^"']+)["']\s*><\/plugin-card>/i.test(trimmed)) {
              flushList(`list_${segIdx}_${lineIdx}`);
              const m = trimmed.match(/<plugin-card\s+catalog-id=["']([^"']+)["']\s*><\/plugin-card>/i);
              const catalogId = m?.[1] || 'plugin';
              const shortName = catalogId.split('/').pop() || catalogId;
              const isAdded = Boolean(installedCatalogPlugins[catalogId]);
              elements.push(
                <div
                  key={`pcard_${lineIdx}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 12px',
                    margin: '8px 0',
                    borderRadius: 8,
                    border: '1px solid rgba(52, 211, 153, 0.4)',
                    background: 'rgba(6, 78, 59, 0.25)',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 12.5, color: '#34d399' }}>
                      🧩 Antigravity Plugin · {shortName}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      Catalog ID: <code>{catalogId}</code>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`btn ${isAdded ? '' : 'primary'}`}
                    disabled={isAdded}
                    style={{ padding: '4px 10px', fontSize: 11 }}
                    onClick={() => {
                      setInstalledCatalogPlugins((prev) => ({ ...prev, [catalogId]: true }));
                      setStatusNotice(`Installing Marketplace plugin: ${catalogId}...`);
                      void handleSendPrompt(
                        `Please install the marketplace plugin "${catalogId}" into this workspace using search_marketplace({ queries: ["${shortName}"], installCatalogId: "${catalogId}" }).`,
                        'auto'
                      );
                    }}
                  >
                    {isAdded ? '✓ Added to Workspace' : '+ Add Plugin'}
                  </button>
                </div>
              );
            } else if (/<ui-plugin-pill\s+[^>]*><\/ui-plugin-pill>/i.test(trimmed)) {
              flushList(`list_${segIdx}_${lineIdx}`);
              const panelMatch = trimmed.match(/panel=["']([^"']+)["']/i);
              const labelMatch = trimmed.match(/label=["']([^"']+)["']/i);
              const panelName = (panelMatch?.[1] || 'extensions').toLowerCase();
              const pillLabel = labelMatch?.[1] || `Open ${panelName.toUpperCase()} Panel`;
              elements.push(
                <div key={`upill_${lineIdx}`} style={{ margin: '6px 0' }}>
                  <button
                    type="button"
                    className="btn primary"
                    style={{
                      borderRadius: 999,
                      padding: '4px 12px',
                      fontSize: 11.5,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    onClick={() => {
                      if (panelName === 'artifacts' || panelName === 'trace' || panelName === 'changes') {
                        setAiTab(panelName);
                        setShowRightAiDock(true);
                      } else if (panelName === 'mcp' || panelName === 'rules' || panelName === 'extensions') {
                        openSettingsCenter(panelName as SettingsCategory);
                      } else {
                        setActiveActivity('extensions');
                        setShowLeftSidebar(true);
                      }
                      setStatusNotice(`Opened UI Plugin Panel: ${panelName}`);
                    }}
                  >
                    <span>🧭</span>
                    <span>{pillLabel}</span>
                  </button>
                </div>
              );
            } else if (
              (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) ||
              (trimmed.startsWith('\\[') && trimmed.endsWith('\\]') && trimmed.length > 4)
            ) {
              flushList(`list_${segIdx}_${lineIdx}`);
              const rawEq = trimmed.slice(2, -2).trim();
              elements.push(
                <div
                  key={`math_${lineIdx}`}
                  style={{
                    padding: '8px 12px',
                    margin: '6px 0',
                    borderRadius: 6,
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    background: 'rgba(15, 23, 42, 0.5)',
                    fontFamily: 'Cambria, "Times New Roman", serif',
                    fontSize: 13.5,
                    fontStyle: 'italic',
                    color: '#bae6fd',
                    textAlign: 'center',
                  }}
                  title={`LaTeX Equation: ${rawEq}`}
                >
                  {formatLatexMathText(rawEq)}
                </div>
              );
            } else {
              flushList(`list_${segIdx}_${lineIdx}`);
              elements.push(
                <p key={`p_${lineIdx}`} className="md-p">
                  {renderInlineFormatted(trimmed, ctxSnap)}
                </p>
              );
            }
          });

          flushList(`list_end_${segIdx}`);
          flushTable(`tbl_end_${segIdx}`);
          return <React.Fragment key={segIdx}>{elements}</React.Fragment>;
        })}
      </div>
    );
  }

  return {
    renderPlainTextWithSourceLinks,
    renderInlineFormatted,
    renderFormattedMarkdown,
    renderFormattedMarkdownInner,
  };
}
