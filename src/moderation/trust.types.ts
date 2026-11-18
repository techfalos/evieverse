import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Text } from '../language.js';

/**
 * An image of a post or of a comment, for a plugin that looks at pictures. Nothing of it is read
 * unless a plugin asks: one that doesn't costs a post nothing.
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
   * True for what a user puts on their profile (see moderateProfile): a bio, links, or an avatar,
   * whichever the request sets. It is neither a post nor a comment, and has no moderation queue to
   * wait in: a score that doesn't publish it refuses it. Absent for a post, and for a comment.
   */
  profile?: true;
  /** The hashtags it was sent with, normalised, before moderation drops any. A comment has none, and neither has a profile. */
  tags: string[];
  /**
   * What there is of it to read: its text or caption or link, and its filename. A comment's text, and the name of its image or video.
   * A profile's bio and links, and the name of its avatar. A text, a caption, a comment's text and a bio are as their readers read
   * them: without their formatting, and with each link's address after its label, with a space after it where the text goes on
   * (plainText in format.ts).
   */
  texts: string[];
  /**
   * Its images: those of an image post, in their order, the one a comment comes with, and a
   * profile's avatar. Absent for anything else: a post of another type, a comment with a video or
   * with no file, the edit of a comment (which keeps its file), a profile whose avatar isn't
   * what is set, and a repost of a post on another server, whose image isn't here.
   */
  images?: TrustImage[];
}

/** What a plugin works with. */
export interface TrustContext {
  db: Db;
  config: Config;
  now: () => number;
  /** The log of the request that sent the post, for what its operator should know. Absent where a post is scored outside a request. */
  log?: FastifyBaseLogger;
  /** Who sent the request the post came in. Absent where a post is scored outside a request. */
  client?: TrustClient;
  /** The post's score as the plugins before this one left it. */
  score: number;
}

/**
 * What a plugin does to a post's score: sets it, or reduces it by so much. Either way the score
 * only goes down: a plugin that sets it higher than it is changes nothing.
 *
 * `reason` is what the publisher is told if this change is what has the post refused: a message of
 * the language files (`msg`, src/language.ts), which they are told in their language, or the
 * plugin's own words, which they are told as written.
 */
export type TrustChange = ({ set: number; reduce?: never } | { reduce: number; set?: never }) & { reason?: Text };

/** What a plugin's index file exports as its default. */
export interface TrustAlgorithm {
  /**
   * Whether the plugin is optional: one that runs only on a server that turns it on, by naming it
   * in `trust.optionalPlugins` (TRUST_OPTIONAL_PLUGINS). A plugin that doesn't say runs on every server.
   */
  optional?: boolean;
  /** Looks at a post, and says what to do to its score. null, or nothing, leaves it as it is. */
  assess(post: TrustPost, ctx: TrustContext): TrustChange | null | undefined | void | Promise<TrustChange | null | undefined | void>;
}

/** A plugin as loaded: its algorithm, named after its folder. */
export interface TrustPlugin extends TrustAlgorithm {
  name: string;
}

/**
 * The trust score of a post or a comment as `trustOf` works it out. `moderatePost` and
 * `moderateComment` read it: one whose score has it deleted is refused with `reason`, if it has
 * one.
 */
export interface Trust {
  score: number;
  /** The reason given with the change that brought the score to what it is, if it gave one. */
  reason?: Text;
}
