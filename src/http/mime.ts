import { extname } from 'node:path';

/**
 * The mime type a filename's extension stands for, by the extension in lowercase with its dot.
 * `resolveMimeType` falls back to it when the client names no type, or only
 * application/octet-stream.
 */
const BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

/** Prefers an explicit client mime type, falling back to the file extension. */
export function resolveMimeType(clientType: string | undefined, filename: string | null | undefined): string {
  const declared = clientType?.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  return (filename ? BY_EXTENSION[extname(filename).toLowerCase()] : undefined) ?? declared ?? 'application/octet-stream';
}
