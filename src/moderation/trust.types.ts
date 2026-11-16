import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Text } from '../language.js';

/** What a plugin is told of a new post, of an update, or of a comment. */
export interface TrustPost {
  /** Its publisher, or a comment's author. */
  userId: string;
  /** The content an update writes over; absent for a new post, and for a comment. */
  contentId?: string;
  /** For a comment: the post it is on. Absent for a post. */
  commentOn?: string;
  /** The hashtags it was sent with, normalised, before moderation drops any. A comment has none. */
  tags: string[];
  /**
   * What there is of it to read: its text or caption or link, and its filename. A comment's text, and the name of its image or video.
   * A text, a caption and a comment's text are as their readers read them: without their formatting, and with each link's address
   * after its label, with a space after it where the text goes on (plainText in format.ts).
   */
  texts: string[];
}

/** What a plugin works with. */
export interface TrustContext {
  db: Db;
  config: Config;
  now: () => number;
  /** The log of the request that sent the post, for what its operator should know. Absent where a post is scored outside a request. */
  log?: FastifyBaseLogger;
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
