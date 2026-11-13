import crypto from 'node:crypto';

/**
 * Section 6.1 & 6.4: Content-Security-Policy (CSP) Nonce & Header Generator
 * Enforces strict Webview CSP:
 * - No remote scripts or uncontrolled resources
 * - Scripts require cryptographic nonce (`nonce-<base64>`)
 * - `default-src 'none'` baseline
 */
export function generateCspNonce(): string {
  return crypto.randomBytes(18).toString('base64');
}

export function buildWebviewCspHeader(options: {
  cspSource: string;
  nonce: string;
  allowLocalWebSocket?: boolean;
}): string {
  const connectSrc = options.allowLocalWebSocket
    ? `'self' ws://127.0.0.1:* http://127.0.0.1:* ${options.cspSource}`
    : `'self' ${options.cspSource}`;

  const directives = [
    `default-src 'none'`,
    `img-src ${options.cspSource} blob: data: https:`,
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `font-src ${options.cspSource} data:`,
    `script-src 'nonce-${options.nonce}'`,
    `connect-src ${connectSrc}`,
    `frame-src 'self' blob: data: http://localhost:* http://127.0.0.1:*`,
    `object-src 'self' blob: data:`,
    `frame-ancestors 'self'`,
    `base-uri 'none'`,
  ];

  return directives.join('; ');
}

export function validateWebviewHtmlCsp(html: string): {
  valid: boolean;
  hasMetaCsp: boolean;
  hasDefaultSrcNone: boolean;
  hasScriptNonce: boolean;
  hasRemoteScriptTags: boolean;
} {
  const hasMetaCsp = /http-equiv=["']Content-Security-Policy["']/i.test(html);
  const hasDefaultSrcNone = /default-src\s+'none'/i.test(html);
  const hasScriptNonce = /script-src\s+'nonce-[A-Za-z0-9+/=]+'/.test(html);
  const hasRemoteScriptTags = /<script[^>]+src=["']https?:\/\//i.test(html);

  return {
    valid: hasMetaCsp && hasDefaultSrcNone && hasScriptNonce && !hasRemoteScriptTags,
    hasMetaCsp,
    hasDefaultSrcNone,
    hasScriptNonce,
    hasRemoteScriptTags,
  };
}

