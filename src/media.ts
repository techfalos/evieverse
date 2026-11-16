import { open, readFile } from 'node:fs/promises';

const PDF_MAX_BYTES = 200 * 1024 * 1024;
/** Text kept from a document for its preview, which bounds the preview of text without spaces. */
const MAX_TEXT_CHARS = 60_000;

/** Text-like content (text, HTML, JSON, XML, PDF), which is previewed by its first words; anything else by a link. */
export function isDocument(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/pdf' ||
    /^application\/(json|xml|xhtml\+xml|javascript|x-yaml|yaml|ld\+json|rss\+xml|atom\+xml)$/.test(mimeType)
  );
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The text of a stored document, from its start; empty for a PDF too large to read. */
export async function documentText(filePath: string, mimeType: string, size: number): Promise<string> {
  if (mimeType === 'application/pdf') {
    if (size > PDF_MAX_BYTES) return '';
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(filePath)));
    return (await extractText(pdf, { mergePages: true })).text.slice(0, MAX_TEXT_CHARS);
  }
  // Read a bit more than needed in case of multi-byte characters or HTML markup.
  const raw = (await readHead(filePath, MAX_TEXT_CHARS * 4)).toString('utf8');
  return (mimeType.includes('html') ? htmlToText(raw) : raw).slice(0, MAX_TEXT_CHARS);
}
