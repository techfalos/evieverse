import { msg } from '../../../language.js';
import { MIN_TRUST_SCORE, type TrustAlgorithm } from '../../../moderation/trust.js';
import { SERVER_LIST, WordScanner } from '../../../moderation/words.js';

/**
 * The server's blocked words: a post that has a word or phrase of the list its admins keep isn't
 * trusted at all, and neither is a comment. Its text or caption or link, its filename and its
 * hashtags are read, as whole words and phrases (see WordScanner).
 *
 * Each hashtag's own list, which its moderators keep, isn't a matter of trust: a post with one of
 * its words only loses that hashtag (see moderatePost), and a comment has no hashtags.
 */
export default {
  async assess({ texts, tags, commentOn }, { db }) {
    const rows = await db.selectFrom('blocked_words').select('word').where('tag', '=', SERVER_LIST).execute();
    // With nothing blocked, nothing needs reading.
    if (!rows.length) return null;
    const scanner = new WordScanner(new Map([[SERVER_LIST, rows.map((r) => r.word)]]));
    for (const text of [...texts, ...tags]) scanner.scan(text);
    if (!scanner.matched.has(SERVER_LIST)) return null;
    return { set: MIN_TRUST_SCORE, reason: msg(commentOn === undefined ? 'moderation.blocked_word' : 'comment.blocked_word') };
  },
} satisfies TrustAlgorithm;
