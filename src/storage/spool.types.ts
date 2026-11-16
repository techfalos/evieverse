/**
 * A local temp file that holds bytes on their way to the content store: a file a request sent, an
 * image without its metadata, or bytes the server made. spoolToTemp makes it, with its `size` in
 * bytes; whoever holds it reads it at `path`, and calls `cleanup` once done with it, which deletes
 * the file, and is no error for one that is gone already.
 */
export interface SpooledFile {
  path: string;
  size: number;
  cleanup: () => Promise<void>;
}
