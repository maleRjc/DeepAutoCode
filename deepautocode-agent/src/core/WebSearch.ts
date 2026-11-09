import https from 'node:https';

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  ok: boolean;
  query: string;
  domain?: string;
  results: WebSearchResultItem[];
  source: 'duckduckgo' | 'wikipedia' | 'fallback';
  error?: string;
}

function httpsGetText(urlStr: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/json,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf-8'));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Web search request timed out'));
    });
    req.end();
  });
}

function stripHtmlTags(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDuckDuckGoRedirect(rawHref: string): string {
  try {
    if (rawHref.includes('uddg=')) {
      const m = rawHref.match(/[?&]uddg=([^&]+)/);
      if (m?.[1]) return decodeURIComponent(m[1]);
    }
    if (rawHref.startsWith('//')) return `https:${rawHref}`;
    return rawHref;
  } catch {
    return rawHref;
  }
}

/**
 * Built-in Web Search tool (`search_web`) with domain filtering and automatic fallback.
 */
export async function performWebSearch(params: {
  query: string;
  domain?: string;
  maxResults?: number;
}): Promise<WebSearchResponse> {
  const rawQuery = String(params.query || '').trim();
  if (!rawQuery) {
    return { ok: false, query: '', results: [], source: 'fallback', error: 'query is required' };
  }
  const domain = params.domain ? String(params.domain).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '') : undefined;
  const effectiveQuery = domain ? `site:${domain} ${rawQuery}` : rawQuery;
  const maxResults = Math.max(1, Math.min(10, Number(params.maxResults ?? 6)));

  // 1. Try DuckDuckGo HTML endpoint
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(effectiveQuery)}`;
    const html = await httpsGetText(ddgUrl, 7500);
    const results: WebSearchResultItem[] = [];

    const blockRegex =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(html)) !== null && results.length < maxResults) {
      const url = decodeDuckDuckGoRedirect(match[1]);
      const title = stripHtmlTags(match[2]);
      const snippet = stripHtmlTags(match[3] || match[4] || '');
      if (title && url && /^https?:\/\//i.test(url)) {
        results.push({ title, url, snippet });
      }
    }

    if (results.length > 0) {
      return {
        ok: true,
        query: rawQuery,
        domain,
        results,
        source: 'duckduckgo',
      };
    }
  } catch {
    // fall through to Wikipedia / Instant Answer API
  }

  // 2. Fallback: Wikipedia OpenSearch / MediaWiki API for technical concepts
  try {
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      rawQuery
    )}&utf8=&format=json&srlimit=${maxResults}`;
    const rawJson = await httpsGetText(wikiUrl, 6000);
    const parsed = JSON.parse(rawJson);
    const items = Array.isArray(parsed?.query?.search) ? parsed.query.search : [];
    const results: WebSearchResultItem[] = items.slice(0, maxResults).map((it: any) => ({
      title: String(it.title || ''),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(it.title || '').replace(/\s+/g, '_'))}`,
      snippet: stripHtmlTags(String(it.snippet || '')),
    }));
    return {
      ok: true,
      query: rawQuery,
      domain,
      results,
      source: 'wikipedia',
    };
  } catch (err) {
    return {
      ok: false,
      query: rawQuery,
      domain,
      results: [],
      source: 'fallback',
      error: (err as Error).message || 'Web search failed',
    };
  }
}

