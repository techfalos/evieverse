import { article, articleText, pick, picture, PUBLISHERS, topicOf, type Rng } from '../testbed/seed/corpus.js';

// What the benchmark's server holds, as the load generator knows it: the server's container makes
// it (server.ts) and the load generator's asks for it (serve.ts), so nothing here needs the server's code.

/** A registered user's credentials, as the fields of a request. */
export interface User {
  userId: string;
  apiKey: string;
}

/** A post as /store takes it, but for whose it is. With a title: the benchmark's server has its settings' defaults, and by default every post has one (POST_TITLES). */
export type PostBody = { tags: string[]; title: string } & (
  | { type: 'text'; text: string }
  | { type: 'link'; url: string }
  | { type: 'image'; content: string; contentEncoding: 'base64'; contentType: 'image/png'; filename: string }
);

export interface SeededPost {
  contentId: string;
  type: PostBody['type'];
  tags: string[];
}

/** What the server holds when the load starts. */
export interface Dataset {
  /** The users who post. */
  publishers: User[];
  /** The users who liked and commented on the posts. The first of them follows every publisher. */
  readers: User[];
  /** Users who have liked nothing yet: every like of theirs is a new one. */
  fans: User[];
  posts: SeededPost[];
  /** The posts that have comments, `commentsEach` of them each. */
  commented: string[];
  commentsEach: number;
  likes: number;
  /** Days the posts are spread over, the newest of them the most. */
  days: number;
}

/**
 * A post one of the publishers might write, of the testbed's corpus: a text of 90 to 200 words
 * mostly, sometimes a link or a picture, under its topic's hashtag and its subject's. A text's
 * title is its article's; a link's and a picture's are made of what they are, with no draw of
 * their own, so the data is what it was before posts had titles.
 */
export function newPost(r: Rng, n: number, publisher = Math.floor(r() * PUBLISHERS.length)): PostBody & { publisher: number } {
  const spec = PUBLISHERS[publisher]!;
  const beat = pick(r, spec.beats);
  const tags = [topicOf(beat), beat];
  if (spec.beats.length > 1 && r() < 0.35) tags.push(pick(r, spec.beats.filter((b) => b !== beat)));
  const kind = r();
  if (kind < (spec.images ?? 0.04)) {
    return { publisher, tags, title: `${spec.username}: ${beat} in pictures, no. ${n}`, type: 'image', content: picture(r, topicOf(beat)).toString('base64'), contentEncoding: 'base64', contentType: 'image/png', filename: `bench-${n}.png` };
  }
  if (kind > 0.92) return { publisher, tags, title: `${spec.username}: the latest on ${beat}, no. ${n}`, type: 'link', url: `https://${spec.host}.example.com/${beat}/${n}` };
  const a = article(r, beat, tags);
  return { publisher, tags, title: a.title, type: 'text', text: articleText(a) };
}
