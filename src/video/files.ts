/** The content types of a processed video's files, by what their names end with: its poster, its playlists, and the segments of its stream. */
const FILE_TYPES: Record<string, string> = { jpg: 'image/jpeg', m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t' };

/**
 * The content type of one of a processed video's files (see MEDIA_FILE), by its name: what the
 * video worker stores it with, and what the route that serves it says it is. Apart from the
 * worker, so that what only serves the files needs nothing of what makes them.
 */
export const videoFileType = (file: string) => FILE_TYPES[file.slice(file.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
