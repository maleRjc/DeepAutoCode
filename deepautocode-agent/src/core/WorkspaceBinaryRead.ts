import path from 'node:path';

const BLOCKED_TEXT_READ_EXT = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.mp4',
  '.wav',
  '.avi',
  '.mov',
  '.sqlite',
  '.db',
  '.bin',
]);

export function isBlockedBinaryReadPath(filePath: string): boolean {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return BLOCKED_TEXT_READ_EXT.has(ext);
}

/** Returned as read-file content so the LLM gets a short directive instead of megabytes of garbage. */
export function buildBlockedBinaryReadMessage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const mdGuess = filePath.replace(/\.pdf$/i, '.md');
    return (
      `[BINARY_READ_BLOCKED] "${filePath}" is a PDF. Do NOT read_file on PDFs (UTF-8 decode corrupts context and can cause 180s+ LLM timeouts).\n` +
      `Instead:\n` +
      `1) read_file on the Markdown source if it exists (e.g. \`${mdGuess}\`).\n` +
      `2) Or run_command: pandoc "${mdGuess}" -o "${filePath}" (requires PDF engine for PDF; HTML works without LaTeX).\n` +
      `3) For existing PDF text extraction: run_command with a dedicated tool (pdftotext), not read_file.`
    );
  }
  return (
    `[BINARY_READ_BLOCKED] "${filePath}" looks like a binary file (${ext || 'unknown'}). ` +
    `Use a specialized tool/command instead of read_file.`
  );
}
