import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/feed/cursor.js';
import type { CursorState } from '../src/feed/cursor.types.js';
import { ENGAGED_TAGS, ENGAGED_USERS, type Engagement, engagementScores, engagementWeights, parseEngagement } from '../src/feed/engagement.js';
import { HttpError } from '../src/http/errors.js';
import { decodeCursorJson, encodeCursorJson } from '../src/http/listCursor.js';
import type { Candidate } from '../src/tagfeed/reader.types.js';

const ALICE = '0a6f1c9e-3b1d-4c55-9a0e-1f2d3c4b5a69';
const BOB = '7d2b8e4f-9c3a-4e1b-8f6d-5a4c3b2e1d0f';

/** An index entry of the content `contentId`. */
const entry = (contentId: string, repost = false): Candidate => ({ contentId, createdAt: 0, likes: 0, views: 0, dislikes: 0, aiGenerated: false, moderated: false, repost });

/** What `call` is refused with: its status, or undefined if it isn't refused. */
function refusal(call: () => unknown): number | undefined {
  try {
    call();
  } catch (err) {
    if (err instanceof HttpError) return err.statusCode;
    throw err;
  }
  return undefined;
}

describe('the engagement of an engaged feed', () => {
  it('reads the counts a client sends, each part of which can be left out', () => {
    const sent = { likedByTag: { news: 3 }, likedByUser: { [ALICE]: 1 }, viewedByTag: { '#News': 40, cats: 2 }, viewedByUser: { [ALICE]: 9, [BOB]: 0 } };
    expect(parseEngagement(JSON.stringify(sent))).toEqual(sent);
    expect(parseEngagement('{}')).toEqual({});
    expect(parseEngagement('{"viewedByTag":{}}')).toEqual({ viewedByTag: {} });
    // What it doesn't know of is left out.
    expect(parseEngagement('{"likedByTag":{"news":1},"sharedByTag":{"news":4}}')).toEqual({ likedByTag: { news: 1 } });
  });

  it("refuses what isn't JSON, and what isn't counts of posts by hashtag and by user id", () => {
    for (const raw of [
      '',
      'likedByTag',
      '{"likedByTag":',
      'null',
      '[]',
      '7',
      '{"likedByTag":[]}',
      '{"likedByTag":{"news":-1}}',
      '{"likedByTag":{"news":1.5}}',
      '{"likedByTag":{"news":"3"}}',
      '{"viewedByTag":{"news/india":3}}',
      '{"viewedByTag":{"":3}}',
      '{"likedByUser":{"alice":3}}',
      `{"viewedByUser":{"@${ALICE}":3}}`,
    ]) {
      expect(refusal(() => parseEngagement(raw)), raw).toBe(400);
    }
  });

  it('weighs each hashtag and each user by its share of what was liked and viewed, a like counting for three views', () => {
    // 30 views of one, and 10 likes of the other: as much.
    expect(engagementWeights({ viewedByTag: { news: 30 }, likedByTag: { sports: 10 } })).toEqual({ tags: [['news', 500], ['sports', 500]], users: [] });
    // The views and the likes of one are added up, however the hashtag is written.
    expect(engagementWeights({ viewedByTag: { news: 10, '#News': 20, cats: 10 }, likedByTag: { NEWS: 10 } })).toEqual({ tags: [['news', 857], ['cats', 143]], users: [] });
    // The hashtags and the users are weighed apart: each list adds up to the whole.
    expect(engagementWeights({ viewedByTag: { news: 900, cats: 100 }, viewedByUser: { [ALICE.toUpperCase()]: 3 }, likedByUser: { [BOB]: 3 } })).toEqual({
      tags: [['news', 900], ['cats', 100]],
      users: [[BOB, 750], [ALICE, 250]],
    });
    // The least of them still counts.
    expect(engagementWeights({ viewedByTag: { news: 1_000_000, cats: 1 } })).toEqual({ tags: [['news', 1000], ['cats', 1]], users: [] });
  });

  it('keeps the hashtags and the users liked and viewed most, and is no engagement where nothing was', () => {
    const tags = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`tag${i}`, i]));
    const users = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`${ALICE.slice(0, -2)}${String(i).padStart(2, '0')}`, 25 - i]));
    const weights = engagementWeights({ viewedByTag: tags, likedByUser: users })!;
    expect(weights.tags.map(([tag]) => tag)).toEqual(Array.from({ length: ENGAGED_TAGS }, (_, i) => `tag${24 - i}`));
    expect(weights.users.map(([userId]) => userId)).toEqual(Object.keys(users).slice(0, ENGAGED_USERS));
    for (const list of [weights.tags, weights.users]) {
      const total = list.reduce((sum, [, weight]) => sum + weight, 0);
      expect(Math.abs(total - 1000)).toBeLessThanOrEqual(list.length);
    }
    // One that was counted and came to nothing is left out, and with nothing left there is no engagement.
    expect(engagementWeights({ viewedByTag: { news: 0, cats: 4 } })).toEqual({ tags: [['cats', 1000]], users: [] });
    const nothings: Engagement[] = [{}, { likedByTag: {} }, { likedByTag: { news: 0 }, viewedByUser: { [ALICE]: 0 } }];
    for (const nothing of nothings) expect(engagementWeights(nothing)).toBeUndefined();
  });

  it('scores content by the hashtags it is under and by who published it, once for each', () => {
    const weights = { tags: [['news', 700], ['cats', 300]] as [string, number][], users: [[ALICE, 600], [BOB, 400]] as [string, number][] };
    const scores = engagementScores(
      weights,
      // Under #news, one post is there as itself and as a repost of it.
      [[entry('a'), entry('b'), entry('b', true)], [entry('b'), entry('c')]],
      // Alice published `a` and reposted `c`, which is Bob's.
      [[entry('a'), entry('c', true)], [entry('c'), entry('d')]],
    );
    expect(Object.fromEntries(scores)).toEqual({ a: 700 + 600, b: 700 + 300, c: 300 + 400, d: 400 });
    expect(engagementScores({ tags: [], users: [] }, [], []).size).toBe(0);
  });
});

describe("an engaged feed's cursor", () => {
  const state: CursorState = {
    anchor: Date.UTC(2026, 10, 6, 12),
    hours: 24,
    tags: ['news', 'sports'],
    algorithm: 'engaged',
    after: [{ likes: 4, createdAt: 1_700_000_000_000, contentId: 'c-1' }, null],
    seed: 77,
    freshAfter: [12345, null],
  };
  const engaged = {
    weights: { tags: [['news', 700], ['cats', 300]] as [string, number][], users: [[ALICE, 1000]] as [string, number][] },
    after: [{ score: 1700, key: 4_000_000_000, contentId: 'c-2' }, null],
    led: ['c-3', 'c-4'],
  };
  /** A cursor of `state` and `engaged`, with what it carries for the engagement changed. */
  const tampered = (change: (e: Record<string, unknown>) => void, more: Record<string, unknown> = {}) => {
    const raw = decodeCursorJson(encodeCursor({ ...state, engaged })) as Record<string, unknown> & { e: Record<string, unknown> };
    change(raw.e);
    return encodeCursorJson({ ...raw, ...more });
  };

  it('carries what the feed goes by, and is the cursor it always was for a feed that goes by none', () => {
    expect(decodeCursor(encodeCursor({ ...state, engaged }))).toEqual({ ...state, engaged });
    // An engaged feed that was told nothing of its reader, and every other feed.
    for (const algorithm of ['engaged', 'popular', 'chronological'] as const) {
      const cursor = encodeCursor({ ...state, algorithm });
      expect(decodeCursor(cursor)).toEqual({ ...state, algorithm });
      expect(decodeCursorJson(cursor)).not.toHaveProperty('e');
    }
  });

  it("refuses one that names more indexes than a first page reads, or what isn't an index, a weight or a place", () => {
    const refused: [string, string][] = [
      ['an engagement on a feed that is not engaged', tampered(() => {}, { al: 'popular' })],
      ['more hashtags', tampered((e) => (e.t = Array.from({ length: ENGAGED_TAGS + 1 }, (_, i) => [`tag${i}`, 5])))],
      ['more users', tampered((e) => (e.u = Array.from({ length: ENGAGED_USERS + 1 }, (_, i) => [`${ALICE.slice(0, -2)}${String(i).padStart(2, '0')}`, 5])))],
      ['a hashtag as it is not kept', tampered((e) => (e.t = [['#News', 5]]))],
      ['a user id that is none', tampered((e) => (e.u = [['head:news', 5]]))],
      ['a user id in upper case', tampered((e) => (e.u = [[ALICE.toUpperCase(), 5]]))],
      ['no hashtag and no user', tampered((e) => Object.assign(e, { t: [], u: [] }))],
      ['a weight of nothing', tampered((e) => (e.t = [['news', 0]]))],
      ['a weight past the whole', tampered((e) => (e.t = [['news', 1001]]))],
      ['a weight that is no number', tampered((e) => (e.t = [['news', '5']]))],
      ['a place that is none', tampered((e) => (e.p = [[1, 2], null]))],
      ['a place with a score that is no count', tampered((e) => (e.p = [[1.5, 2, 'c-2'], null]))],
      ['places that are no list', tampered((e) => (e.p = 'c-2'))],
      ['more leads than a feed has', tampered((e) => (e.l = ['c-1', 'c-2', 'c-3']))],
      ['a lead that is no id', tampered((e) => (e.l = [7]))],
      ['an engagement that is no object', tampered(() => {}, { e: 'news' })],
      ['an engagement that is nothing', tampered(() => {}, { e: null })],
    ];
    for (const [what, cursor] of refused) expect(refusal(() => decodeCursor(cursor)), what).toBe(400);
    // As it was given, it is read.
    expect(refusal(() => decodeCursor(tampered(() => {})))).toBeUndefined();
  });
});
