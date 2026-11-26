import { z } from 'zod';
import { badRequest } from '../http/errors.js';
import { HASHTAG } from '../http/schemas.js';
import { msg } from '../language.js';
import { normalizeTag } from '../tags.js';
import type { Candidate } from '../tagfeed/reader.types.js';
import type { EngagementWeights } from './engagement.types.js';

/**
 * What an engaged feed (GET /feed, `algorithm=engaged`) is told of its reader, and what it makes
 * of it. The client sends it with the request, as `engagement`: how many posts the user has liked
 * and viewed, by hashtag and by the user who published them. The server keeps none of it. It has
 * no such counts of its own, and a hashtag feed doesn't know who reads it.
 *
 * A post matches the engagement when it is under one of the hashtags, or was published by one of
 * the users, that the reader has liked and viewed most. That is read from the indexes in Redis,
 * as everything a hashtag feed plans from is: a hashtag's index lists the posts under it, and a
 * user's own index the posts they published (src/tagfeed/layout.ts).
 */

/** The most hashtags of an engagement a feed goes by: those the reader has liked and viewed most. The feed reads the index of each. */
export const ENGAGED_TAGS = 10;
/** The same for the users of an engagement, whose own indexes the feed reads. */
export const ENGAGED_USERS = 10;
/** How many views a like counts for, where the two are added up: liking a post says more than having seen it. */
const LIKE_WEIGHT = 3;
/** What the weights of an engagement's hashtags add up to, about, and so do those of its users: each is a share of this. */
export const WEIGHT_SCALE = 1000;
/** A user's id as an engagement names it, and as a user's own index is named after it: a UUID, in lower case. */
export const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How many posts: a whole number, zero or more. */
const Count = z.number().int().min(0);
/** Counts of posts by hashtag, each written as a feed's `tags` are. */
const ByTag = z.record(z.string().regex(HASHTAG), Count);
/** Counts of posts by the id of the user who published them. */
const ByUser = z.record(z.string().uuid(), Count);

/**
 * The engagement a client sends an engaged feed, as JSON: the posts its user has liked and the
 * posts they have viewed, counted by hashtag and by publisher. Each part can be left out, and so
 * can all of them.
 */
export const Engagement = z.object({
  /** How many posts the user has liked under each hashtag. */
  likedByTag: ByTag.optional(),
  /** How many posts the user has liked of each user they follow. */
  likedByUser: ByUser.optional(),
  /** How many posts the user has viewed under each hashtag: opened, not passed in a feed. */
  viewedByTag: ByTag.optional(),
  /** How many posts the user has viewed of each user they follow. */
  viewedByUser: ByUser.optional(),
});
export type Engagement = z.infer<typeof Engagement>;

/** The `engagement` of a feed request as what it says; 400 if it isn't JSON, or isn't an engagement. */
export function parseEngagement(raw: string): Engagement {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw badRequest(msg('feed.engagement_invalid'));
  }
  const parsed = Engagement.safeParse(value);
  if (!parsed.success) throw badRequest(msg('feed.engagement_invalid'), parsed.error.issues);
  return parsed.data;
}

/**
 * The `most` names with the highest counts, the highest first (names with the same count in their
 * own order), each with its share of their total out of WEIGHT_SCALE, and never less than 1. A
 * name with a count of zero is left out.
 */
function shares(counts: Map<string, number>, most: number): [string, number][] {
  const top = [...counts]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, most);
  const total = top.reduce((sum, [, count]) => sum + count, 0);
  return top.map(([name, count]) => [name, Math.max(1, Math.round((count * WEIGHT_SCALE) / total))]);
}

/** Views and likes as one count by name, a like counting for LIKE_WEIGHT views. `named` is the name the server knows each by. */
function counted(viewed: Record<string, number> = {}, liked: Record<string, number> = {}, named: (name: string) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [by, weight] of [[viewed, 1], [liked, LIKE_WEIGHT]] as const) {
    for (const [name, count] of Object.entries(by)) counts.set(named(name), (counts.get(named(name)) ?? 0) + count * weight);
  }
  return counts;
}

/**
 * What a feed goes by of an engagement: the ENGAGED_TAGS hashtags and the ENGAGED_USERS users
 * liked and viewed most, each weighted by its share of those. The hashtags and the users are
 * weighted apart, so a reader's most viewed hashtag counts as much as the user they view most,
 * though a post has several hashtags and one publisher. Undefined for an engagement that counts
 * nothing, which is no engagement.
 */
export function engagementWeights(engagement: Engagement): EngagementWeights | undefined {
  const tags = shares(counted(engagement.viewedByTag, engagement.likedByTag, (tag) => normalizeTag(tag)!), ENGAGED_TAGS);
  const users = shares(counted(engagement.viewedByUser, engagement.likedByUser, (userId) => userId.toLowerCase()), ENGAGED_USERS);
  return tags.length + users.length > 0 ? { tags, users } : undefined;
}

/**
 * How much each piece of content matches an engagement, by content id: the weights of the
 * engagement's hashtags it is under, and of its publisher if that is one of the engagement's
 * users, added up. `tagIndexes` is the index of each of the weights' hashtags, in their order, and
 * `userIndexes` the own index of each of their users. Content in none of them isn't in the result.
 *
 * A user's own index lists what they reposted too, which someone else published, so those entries
 * aren't counted.
 */
export function engagementScores(weights: EngagementWeights, tagIndexes: Candidate[][], userIndexes: Candidate[][]): Map<string, number> {
  const scores = new Map<string, number>();
  // Once for each index, however many entries of it the content has: its own, and a repost's.
  const add = (index: Candidate[], weight: number) => {
    for (const contentId of new Set(index.map((c) => c.contentId))) scores.set(contentId, (scores.get(contentId) ?? 0) + weight);
  };
  weights.tags.forEach(([, weight], i) => add(tagIndexes[i]!, weight));
  weights.users.forEach(([, weight], i) => add(userIndexes[i]!.filter((c) => !c.repost), weight));
  return scores;
}
