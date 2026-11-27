import type { Text } from '../language.js';
import type { RemovedTag } from './policy.types.js';

/**
 * An image of a post or of a comment, for a trust plugin that looks at pictures. Nothing of it is
 * read unless a plugin the server runs reads images: where none does, it costs a post nothing.
 */
export interface TrustImage {
  /** Which image its bytes are (image/jpeg, image/png, image/gif or image/webp), read from the bytes themselves. */
  mimeType: string;
  /** The name it was sent with, if it had one. */
  filename: string | null;
  /**
   * The path of a file on this machine that holds the image as it would be stored: without its
   * metadata. It is the request's, which deletes it when it is over: a plugin reads it, and
   * neither changes nor keeps it. An image sent with an upload link is fetched from the content
   * store when this is first asked for.
   */
  file(): Promise<string>;
  /** The SHA-256 of that file, in hex: what the post's meta file would keep of it. */
  sha256(): Promise<string>;
}

/** An image as the trust plugins are given it, once it is read: where its file is, and the file's hash. */
export interface ReadImage {
  mimeType: string;
  filename: string | null;
  file: string;
  sha256: string;
}

/** Who sent a request, as far as the server can tell. */
export interface TrustClient {
  /** The address the request came from, as the server counts it (see TRUST_PROXY). */
  ip: string;
  /** Its User-Agent header, if it sent one. */
  userAgent: string | null;
}

/** What a plugin is told of a new post, of an update, of a comment, or of what a user puts on their profile. */
export interface TrustPost {
  /** Its publisher, a comment's author, or the user whose profile it is. */
  userId: string;
  /** The content an update writes over; absent for a new post, for a comment, and for a profile. */
  contentId?: string;
  /** For a comment: the post it is on. Absent for a post, and for a profile. */
  commentOn?: string;
  /**
   * True for what a user puts on their profile (see moderateProfile): a bio, links, an avatar, or
   * a splash image, whichever the request sets. It is neither a post nor a comment, and has no
   * moderation queue to wait in: a score that doesn't publish it refuses it. Absent for a post,
   * and for a comment.
   */
  profile?: true;
  /** True for a profile whose image (`images`) is its splash image. Absent for anything else: the image of any other profile is its avatar. */
  splash?: true;
  /**
   * True for a post or a comment that is declared as created with AI: by whoever sent it, an
   * update's being the declaration the post will have, and for a repost of a post on another
   * server, by the original's publisher. It is what was said, and nothing checked it. Absent
   * for one that isn't, and for a profile, which has no such declaration.
   */
  aiGenerated?: true;
  /** The hashtags it was sent with, normalised, before moderation drops any. A comment has none, and neither has a profile. */
  tags: string[];
  /**
   * What there is of it to read: its text or caption or link, and its filename. A comment's text, and the name of its image or video.
   * A profile's bio and links, and the name of its avatar or its splash image. A text, a caption, a comment's text and a bio are as their readers read
   * them: without their formatting, and with each link's address after its label, with a space after it where the text goes on
   * (plainText in format.ts).
   */
  texts: string[];
  /**
   * Its images: those of an image post, in their order, the one a comment comes with, and a
   * profile's avatar or its splash image (see `splash`). Absent for anything else: a post of
   * another type, a comment with a video or with no file, the edit of a comment (which keeps its
   * file), a profile neither of whose images is what is set, a repost of a post on another
   * server, whose image isn't here, and on a server none of whose plugins reads images.
   */
  images?: ReadImage[];
}

/**
 * Why something that was sent is refused, with nothing of it stored: what its sender is told,
 * which is a message of the language files or a plugin's own words.
 */
export interface Refusal {
  message: Text;
  /** For a post left with no hashtag: the ones it was sent with, and why it got none. */
  removedTags?: RemovedTag[];
}

/**
 * Where a score sends a post, by the server's `trust` settings. delete (less than `deleteBelow`):
 * it is refused, and nothing of it is kept. queue (less than `allowFrom`): it is stored but not
 * published until an admin accepts it. allow: it is published.
 */
export type TrustRoute = 'delete' | 'queue' | 'allow';

/** What moderation came to: its answer, or what the sender is told of what it refuses. */
export type Moderation<T> = { ok: T } | { refused: Refusal };

/**
 * One thing a test's trust plugin does (compactor/crates/trust/src/testing.rs). It applies to a
 * post that has `includes` in one of its texts, and to every post if it names none. Of the rules
 * that apply, the first that sets or fails is the plugin's answer; without one, the reductions
 * add up.
 */
export interface TestRule {
  includes?: string;
  /** Whether that is found whatever its case. */
  ignoreCase?: boolean;
  /** Whether the rule applies to comments only. */
  comments?: boolean;
  set?: number;
  reduce?: number;
  /** Fails the plugin, with these words. */
  fails?: string;
  /** What the sender is told, if this is what has the post refused. */
  reason?: Text;
}

/** A trust plugin a test describes, which only an addon built for tests has. */
export interface TestPlugin {
  name: string;
  rules?: TestRule[];
  /** Whether it keeps what it is shown, for the test to read (see TrustEngine.seen). */
  record?: boolean;
  /** Whether it reads a post's images, so that they are read for it. */
  readsImages?: boolean;
}

/** What a test's plugin that records was shown. */
export interface Shown {
  /** The plugin's name. */
  plugin: string;
  /** The post's score as the plugins before it left it. */
  score: number;
  post: TrustPost;
}

/** What a server's trust is opened with beside its settings: only a test gives any. */
export interface TrustOptions {
  /** Plugins a test describes, which run after the server's own. */
  testPlugins?: TestPlugin[];
  /** Whether they run in place of the server's own. */
  onlyTestPlugins?: boolean;
}
