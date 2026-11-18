/**
 * One thing a user's export holds: `type` says what it is (`post`, `like`, `follower`, ...), and
 * the rest is what the server has of it, named as the endpoint that otherwise gives it names it.
 */
export interface ExportRecord {
  type: string;
  [field: string]: unknown;
}

/**
 * Where a walk of one section of an export has got to: the values of the columns the section is
 * read in the order of, as its last record has them. The next read starts after it.
 */
export type ExportPosition = (string | number)[];

/**
 * A record as a section gives it: with its place in the section, which is where a page that ends
 * with it is taken up again. Null for a place that turned out to hold nothing (a comment that
 * was removed as it was read): the walk goes past it, and the page has no record of it.
 */
export interface ExportRead {
  record: ExportRecord | null;
  at: ExportPosition;
}

/** A page of an export: its records, and the cursor of the page after it, or null after the last. */
export interface ExportPage {
  records: ExportRecord[];
  nextCursor: string | null;
}

/** Which page of an export a request asks for: the one a cursor names, or the first, of `limit` records at most. */
export interface ExportPageQuery {
  limit: number;
  cursor?: string;
}
