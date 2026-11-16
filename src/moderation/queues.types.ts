/**
 * What the server's two queues hold, the moderation queue and the report queue: posts and comments,
 * in one order. Each queue is a UNION ALL of the posts' table and the comments' (moderation_queue
 * and comment_queue, reports and comment_reports), paged as one list, and this is what the two
 * have in common: what an item of either is, and how a page of rows becomes items.
 */
export type QueueKind = 'post' | 'comment';

/** A row of a queue: a post (`id` is its content id) or a comment (`id` is the comment's, `content_id` its post's). */
export interface QueueRow {
  kind: QueueKind;
  id: string;
  content_id: string;
}
