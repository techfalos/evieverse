import type { Generated, Selectable } from 'kysely';

/**
 * All timestamps are UTC epoch milliseconds stored as BIGINT, which behaves identically across dialects.
 * The schema is defined by the portable SQL in ./migrations; keep these types in sync with it.
 */

export interface UsersTable {
  /** UUID; the only user identifier used in relations and lookups. */
  id: string;
  /** Unique display name; never used as a key. */
  username: string;
  /** The publisher's URL, shown as credit on everything they publish. */
  publisher_url: string | null;
  created_at: number;
  /** Last change to username or publisher_url. */
  updated_at: number;
  /** When the user last posted or was challenged to; a post soon after it must solve challenges. */
  last_post_at: number | null;
  /** Posts in a row the user made with challenges; it sets how many the next one needs. */
  post_streak: Generated<number>;
  /** When the user's posts in the last minute were: epoch ms separated by spaces, oldest first. */
  recent_posts: string | null;
}

export interface ApiKeysTable {
  id: string;
  user_id: string;
  key_prefix: string;
  key_hash: string;
  created_at: number;
  revoked_at: number | null;
}

export interface ContentTable {
  id: string;
  user_id: string;
  /** Current version; its bytes are at content/<id>/<version> in the content store. Older versions are erased. */
  version: number;
  /** Highest version number handed out, committed or not; each write gets its own, so numbers can skip. */
  reserved_version: number;
  filename: string | null;
  mime_type: string;
  size: number;
  sha256: string;
  /** 1 if the publisher declared the current version created with AI, else 0. */
  ai_generated: Generated<number>;
  like_count: Generated<number>;
  created_at: number;
  updated_at: number;
  /** Set by DELETE /content/:id; the compactor removes the content from the feed index, then deletes it. */
  delete_requested_at: number | null;
  /** Federated content: base URL of the server it was stored on, which keeps its bytes. Null for local content. */
  origin_server: string | null;
  /** Federated content: its id on the origin server. */
  origin_content_id: string | null;
  /** Federated content: the origin's version that the current version copies. */
  origin_version: number | null;
}

export interface TagsTable {
  /** A single hashtag word, e.g. "mumbai". */
  name: string;
  created_at: number;
  last_appended_at: number;
  /** Tail windows starting before this time have been merged into the tag's day indexes. */
  compacted_at: Generated<number>;
}

export interface LikesTable {
  user_id: string;
  content_id: string;
  created_at: number;
}

/** A committed content version whose tail appends haven't been confirmed; the compactor completes stale ones. */
export interface PendingAppendsTable {
  content_id: string;
  version: number;
  created_at: number;
}

/** A content version replaced by a newer one; the compactor removes it from the feed index, then erases it. */
export interface SupersededVersionsTable {
  content_id: string;
  version: number;
  created_at: number;
}

/** One row ('compactor'): which compactor run may publish heads and delete, and until when. */
export interface CompactorLeaseTable {
  id: string;
  /** Random id of the run holding the lease; null once released. */
  holder: string | null;
  expires_at: number;
}

export interface Database {
  users: UsersTable;
  api_keys: ApiKeysTable;
  content: ContentTable;
  tags: TagsTable;
  likes: LikesTable;
  pending_appends: PendingAppendsTable;
  superseded_versions: SupersededVersionsTable;
  compactor_lease: CompactorLeaseTable;
}

export type ContentRow = Selectable<ContentTable>;
