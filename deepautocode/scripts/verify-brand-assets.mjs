/**
 * Brand asset HTTP smoke test
 * ------------------------------------------------------------------
 * Boots the compiled Workbench Server on an ephemeral port and asserts that
 * every brand asset is served with the CORRECT Content-Type for its real
 * encoding (this is what used to break: a PNG payload shipped as
 * `logo-icon.jpg` was announced as `image/jpeg` and rejected by Chromium).
 *
 * Usage: node scripts/verify-brand-assets.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// NOTE: on Windows an absolute path must be converted to a file:// URL before
// dynamic import(), otherwise Node throws ERR_UNSUPPORTED_ESM_URL_SCHEME ('e:').
const { createWorkbenchServer } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'dist/src/workbench-server/server.js')).href
);

const CASES = [
  { url: '/assets/logo-icon.jpg', mime: 'image/jpeg', magic: 'ffd8ff' },
  { url: '/assets/logo-icon.png', mime: 'image/png', magic: '89504e47' },
  { url: '/assets/logo.svg', mime: 'image/svg+xml', magic: null },
  { url: '/assets/logo.ico', mime: 'image/x-icon', magic: '00000100' },
  { url: '/favicon.ico', mime: 'image/x-icon', magic: '00000100' },
];

const srv = await createWorkbenchServer({ port: 0, workspaceRoot: REPO_ROOT });
let failures = 0;

try {
  for (const c of CASES) {
    const res = await fetch(`${srv.url}${c.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') ?? '';
    const head = buf.subarray(0, 8).toString('hex');
    const mimeOk = type.startsWith(c.mime);
    const magicOk = c.magic ? head.startsWith(c.magic) : true;
    const ok = res.status === 200 && mimeOk && magicOk;
    if (!ok) failures++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${c.url.padEnd(24)} status=${res.status} type=${type.padEnd(26)}` +
        ` magic=${head.slice(0, 8)} bytes=${buf.length}`,
    );
  }
} finally {
  await srv.close();
}

console.log(failures === 0 ? '\nAll brand assets OK (0 failures)' : `\n${failures} brand asset check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
