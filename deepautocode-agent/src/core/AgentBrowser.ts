/**
 * Stage W: Agent browser — CDP when Chrome remote debugging is available,
 * otherwise structured HTTP HTML snapshot (better than raw scrape).
 */
import http from 'node:http';
import https from 'node:https';

export type BrowserAction =
  | 'navigate'
  | 'get_html'
  | 'inspect_elements'
  | 'get_console_logs'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'screenshot';

export interface BrowserActionResult {
  ok: boolean;
  action: string;
  targetUrl: string;
  mode: 'cdp' | 'http';
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

function httpGetJson(urlStr: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(urlStr, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function fetchText(
  urlStr: string,
  timeoutMs = 8000
): Promise<{ ok: boolean; status: number; statusText: string; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'DeepAutoCode-AgentBrowser/1.0', Accept: 'text/html,*/*' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          resolve({
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 400,
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            contentType: String(res.headers['content-type'] || ''),
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function buildHtmlSnapshot(html: string, selector?: string) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].trim() : 'Untitled Document';
  const headings = Array.from(html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))
    .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const buttons = Array.from(html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi))
    .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .slice(0, 20);
  const inputs = Array.from(
    html.matchAll(/<(input|textarea|select)[^>]*(?:name|id|placeholder)=["']([^"']+)["'][^>]*>/gi)
  )
    .map((m) => `${m[1]}:${m[2]}`)
    .slice(0, 20);
  const links = Array.from(
    html.matchAll(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)
  )
    .map((m) => ({ href: m[1], label: m[2].replace(/<[^>]+>/g, '').trim() }))
    .filter((l) => Boolean(l.label))
    .slice(0, 20);

  // Accessibility-ish role tree (heuristic)
  const roles: string[] = [];
  for (const m of html.matchAll(
    /<(button|a|input|textarea|select|h[1-6]|nav|main|header|footer|form)(\s[^>]*)?>/gi
  )) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const id = /id=["']([^"']+)/i.exec(attrs)?.[1];
    const name =
      /(?:aria-label|name|placeholder)=["']([^"']+)/i.exec(attrs)?.[1] ||
      /type=["']([^"']+)/i.exec(attrs)?.[1] ||
      '';
    roles.push(`[${tag}]${id ? `#${id}` : ''}${name ? ` "${name}"` : ''}`);
    if (roles.length >= 40) break;
  }

  let selectorMatches: string[] = [];
  if (selector) {
    const cleaned = selector.replace(/[.#]/g, '');
    const regex = new RegExp(
      `<[^>]+(?:id|class|name|aria-label)=["'][^"']*${cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*["'][^>]*>[\\s\\S]{0,120}`,
      'gi'
    );
    selectorMatches = Array.from(html.matchAll(regex))
      .map((m) => m[0].slice(0, 200))
      .slice(0, 8);
  }

  return {
    pageTitle,
    headings,
    interactiveElements: { buttonCount: buttons.length, buttons, links, inputs },
    accessibilityTree: roles,
    ...(selector ? { selector, selectorMatches } : {}),
  };
}

async function resolveCdpWsUrl(cdpHttpBase: string): Promise<string | null> {
  try {
    const list = await httpGetJson(`${cdpHttpBase.replace(/\/$/, '')}/json/list`);
    if (Array.isArray(list)) {
      const page =
        list.find((t: any) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string') ||
        list.find((t: any) => typeof t.webSocketDebuggerUrl === 'string');
      if (page?.webSocketDebuggerUrl) return String(page.webSocketDebuggerUrl);
    }
  } catch {
    // ignore
  }
  try {
    const ver = await httpGetJson(`${cdpHttpBase.replace(/\/$/, '')}/json/version`);
    if (ver?.webSocketDebuggerUrl) return String(ver.webSocketDebuggerUrl);
  } catch {
    // ignore
  }
  return null;
}

/** Minimal CDP client over WebSocket (dynamic import of `ws`). */
async function runCdpActions(params: {
  wsUrl: string;
  action: BrowserAction;
  url: string;
  selector?: string;
  text?: string;
}): Promise<BrowserActionResult | null> {
  let WebSocketCtor: any;
  try {
    const mod = await import('ws');
    WebSocketCtor = (mod as any).default || mod;
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: BrowserActionResult | null) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const ws = new WebSocketCtor(params.wsUrl);
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const consoleLogs: string[] = [];

    const send = (method: string, methodParams?: Record<string, unknown>) =>
      new Promise<any>((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params: methodParams || {} }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`CDP ${method} timeout`));
          }
        }, 10_000);
      });

    const timer = setTimeout(() => finish(null), 15_000);

    ws.on('message', (data: any) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.method === 'Runtime.consoleAPICalled') {
          const args = (msg.params?.args || [])
            .map((a: any) => a.value ?? a.description ?? '')
            .join(' ');
          consoleLogs.push(`[${msg.params?.type || 'log'}] ${args}`.slice(0, 300));
        }
        if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } catch {
        // ignore
      }
    });

    ws.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    ws.on('open', () => {
      void (async () => {
        try {
          await send('Runtime.enable');
          await send('Page.enable').catch(() => undefined);
          await send('Console.enable').catch(() => undefined);

          if (params.action === 'navigate' || params.action === 'get_html' || params.action === 'snapshot' || params.action === 'inspect_elements' || params.action === 'screenshot') {
            await send('Page.navigate', { url: params.url });
            await new Promise((r) => setTimeout(r, 800));
          }

          if (params.action === 'get_console_logs') {
            clearTimeout(timer);
            finish({
              ok: true,
              action: params.action,
              targetUrl: params.url,
              mode: 'cdp',
              consoleLogs: consoleLogs.slice(-40),
            });
            return;
          }

          if (params.action === 'screenshot') {
            const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
            clearTimeout(timer);
            finish({
              ok: true,
              action: params.action,
              targetUrl: params.url,
              mode: 'cdp',
              screenshotBase64Length: String(shot?.data || '').length,
              screenshotBase64Prefix: String(shot?.data || '').slice(0, 80),
              note: 'PNG base64 captured via CDP (prefix only returned to keep context small)',
            });
            return;
          }

          if (params.action === 'click' && params.selector) {
            const expr = `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) return { ok:false, error:'not found' }; el.click(); return { ok:true, tag: el.tagName }; })()`;
            const ev = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
            clearTimeout(timer);
            finish({
              ok: Boolean(ev?.result?.value?.ok),
              action: params.action,
              targetUrl: params.url,
              mode: 'cdp',
              result: ev?.result?.value,
            });
            return;
          }

          if (params.action === 'type' && params.selector) {
            const expr = `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) return { ok:false, error:'not found' }; el.focus(); el.value = ${JSON.stringify(params.text || '')}; el.dispatchEvent(new Event('input', { bubbles: true })); return { ok:true }; })()`;
            const ev = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
            clearTimeout(timer);
            finish({
              ok: Boolean(ev?.result?.value?.ok),
              action: params.action,
              targetUrl: params.url,
              mode: 'cdp',
              result: ev?.result?.value,
            });
            return;
          }

          const htmlEv = await send('Runtime.evaluate', {
            expression: 'document.documentElement.outerHTML',
            returnByValue: true,
          });
          const html = String(htmlEv?.result?.value || '');
          const snap = buildHtmlSnapshot(html, params.selector);
          clearTimeout(timer);
          finish({
            ok: true,
            action: params.action,
            targetUrl: params.url,
            mode: 'cdp',
            ...snap,
            contentLength: html.length,
            htmlSnippet:
              params.action === 'get_html' ? html.slice(0, 4000) : html.slice(0, 1200),
            consoleLogs: consoleLogs.slice(-20),
          });
        } catch (err) {
          clearTimeout(timer);
          finish({
            ok: false,
            action: params.action,
            targetUrl: params.url,
            mode: 'cdp',
            error: (err as Error).message,
          });
        }
      })();
    });
  });
}

export async function runBrowserAction(params: {
  action: BrowserAction | string;
  url?: string;
  selector?: string;
  text?: string;
  /** Override CDP discovery base, default http://127.0.0.1:9222 */
  cdpBase?: string;
}): Promise<BrowserActionResult> {
  const action = String(params.action || 'navigate') as BrowserAction;
  const targetUrl = String(params.url || 'http://localhost:3000/').trim();
  const cdpBase =
    params.cdpBase ||
    process.env.DEEPAUTOCODE_CDP_URL ||
    process.env.CHROME_REMOTE_DEBUGGING_URL ||
    'http://127.0.0.1:9222';

  // Prefer CDP when available
  try {
    const wsUrl = await resolveCdpWsUrl(cdpBase);
    if (wsUrl) {
      const cdp = await runCdpActions({
        wsUrl,
        action,
        url: targetUrl,
        selector: params.selector,
        text: params.text,
      });
      if (cdp) return cdp;
    }
  } catch {
    // fall through to HTTP
  }

  if (action === 'click' || action === 'type' || action === 'screenshot') {
    return {
      ok: false,
      action,
      targetUrl,
      mode: 'http',
      error: `${action} requires Chrome CDP (start Chrome with --remote-debugging-port=9222 or set DEEPAUTOCODE_CDP_URL).`,
      hint: 'HTTP fallback only supports navigate / get_html / snapshot / inspect_elements / get_console_logs.',
    };
  }

  try {
    const resp = await fetchText(targetUrl);
    const snap = buildHtmlSnapshot(resp.body, params.selector);
    return {
      ok: resp.ok,
      action,
      targetUrl,
      mode: 'http',
      httpStatus: `${resp.status} ${resp.statusText}`,
      contentType: resp.contentType,
      ...snap,
      contentLength: resp.body.length,
      htmlSnippet:
        action === 'get_html' ? resp.body.slice(0, 4000) : resp.body.slice(0, 1200),
      consoleLogs:
        action === 'get_console_logs'
          ? ['(HTTP mode cannot capture runtime console; use CDP for live logs)']
          : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      action,
      targetUrl,
      mode: 'http',
      error: `Browser navigation/inspection failed: ${(err as Error).message}`,
      hint: 'Verify the local web server is running, or enable Chrome CDP on port 9222.',
    };
  }
}
