import { msg } from '../../../language.js';
import { MIN_TRUST_SCORE, type TrustAlgorithm } from '../../../moderation/trust.js';
import { findLinks } from './links.js';
import { isListed, MalwareList, type Listed } from './list.js';

/**
 * Links that spread malware: a post with a link that is on URLhaus's list (https://urlhaus.abuse.ch)
 * isn't trusted at all, and neither is a comment. Every link in what there is of it to read is
 * checked: a link post's URL, and the links written in a text, a caption or a comment, with a
 * scheme or without one (see findLinks).
 *
 * The server never follows a link. It looks each up in the copy of the list this process keeps
 * (see MalwareList), so a link is checked for what URLhaus knew of it when the post was sent: one
 * that is listed later stays, and so does one that leads to a listed URL without naming it, as a
 * shortened link does.
 *
 * The plugin is optional: it runs on a server that names it in TRUST_OPTIONAL_PLUGINS, which then
 * needs an Auth-Key to download the list with (`urlhaus.authKey`, URLHAUS_AUTH_KEY), and on no
 * other. Where it runs, a post that has a link isn't published unchecked: while the process has
 * no list, because its first download failed, a post with an http or https link fails (500), as a
 * plugin that fails has it. What only may be a link (example.com/file, which a filename is read
 * as too) is let through then, so posts without links are stored whatever URLhaus does.
 *
 * `fetcher` is what downloads the list: fetch, unless a test gives its own.
 */
export function urlhaus(fetcher?: typeof fetch): TrustAlgorithm {
  const list = new MalwareList(fetcher);
  return {
    optional: true,
    async assess({ texts, commentOn }, ctx) {
      const links = texts.flatMap(findLinks);
      if (!links.length) {
        // Nothing to check, but the list is kept current for the post that has.
        list.refresh(ctx);
        return null;
      }
      let listed: Listed;
      try {
        listed = await list.get(ctx);
      } catch (err) {
        if (links.some((link) => link.schemed)) throw err;
        return null;
      }
      if (!links.some((link) => isListed(listed, link))) return null;
      return { set: MIN_TRUST_SCORE, reason: msg(commentOn === undefined ? 'moderation.malware_link' : 'comment.malware_link') };
    },
  };
}

export default urlhaus();
