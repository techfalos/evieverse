# Trust plugins

A trust plugin is an algorithm that looks at a post and may lower its trust score, which [decides where the post goes](API.md#moderation). Each folder of `src/plugins/trust` is one plugin, named after the folder. New posts and comments pass through all trust algorithms the server runs: every plugin installed, except the [optional ones](#optional-plugins) it didn't turn on.

The base instance comes with two:

| Plugin | Runs | What it does |
| --- | --- | --- |
| `src/plugins/trust/blocked_words` | Always | Gives a post or a comment with a word or phrase on the server's list of blocked words a score of 0. |
| `src/plugins/trust/urlhaus` | Only if turned on: it's [optional](#optional-plugins) | Gives a post or a comment with a link on [URLhaus](https://urlhaus.abuse.ch)'s list of malware URLs a score of 0. See [Links that spread malware](#links-that-spread-malware). |

To add one, add a folder with an `index.ts` whose default export has an `assess` function. Use the examples below to guide you. Then build and restart the server:

```ts
// src/plugins/trust/links/index.ts
import type { TrustAlgorithm } from '../../../moderation/trust.types.js';

export default {
  assess({ texts, commentOn }) {
    const links = texts.join(' ').match(/https?:\/\//g)?.length ?? 0;
    if (links <= 3) return;
    const what = commentOn ? 'comment' : 'post';
    return { reduce: 40, reason: `the ${what} has too many links, so it wasn't published` };
  },
} satisfies TrustAlgorithm;
```

```ts
// src/plugins/trust/new_accounts/index.ts
import type { TrustAlgorithm } from '../../../moderation/trust.types.js';

const DAY = 24 * 60 * 60 * 1000;

export default {
  async assess({ userId, commentOn }, { db, config, now }) {
    if (commentOn) return; // posts only
    const user = await db.selectFrom('users').select('created_at').where('id', '=', userId).executeTakeFirst();
    if (user && now() - user.created_at < DAY) return { set: config.trust.allowFrom - 1 };
  },
} satisfies TrustAlgorithm;
```

## Optional plugins

A plugin runs on every server that has its folder, unless it says it's optional. An optional plugin runs only on a server that names it in `TRUST_OPTIONAL_PLUGINS` ([configuration](CONFIG.md)), so a plugin can ship with the server, or with your fork, without every instance running it.

To make a plugin optional, add `optional: true` to what it exports:

```ts
// src/plugins/trust/new_accounts/index.ts
export default {
  optional: true,
  async assess({ userId, commentOn }, { db, config, now }) {
    // ...
  },
} satisfies TrustAlgorithm;
```

To turn optional plugins on, name their folders, separated by commas or spaces, and restart the server:

```sh
TRUST_OPTIONAL_PLUGINS=urlhaus,new_accounts
```

- With `TRUST_OPTIONAL_PLUGINS` empty, which is the default, no optional plugin runs.
- A plugin that isn't optional runs whatever `TRUST_OPTIONAL_PLUGINS` says. Naming it there changes nothing.
- A name that isn't a folder of `src/plugins/trust` stops the server from starting, so a misspelt name can't leave a plugin off unnoticed.
- An optional plugin that is off is never called, but its folder is still loaded when the server starts, so it must still hold a plugin.
- The server logs the plugins it runs when it starts (`trust plugins loaded`).

## Links that spread malware

`urlhaus` is the optional plugin the server comes with. It checks every link of a post or a comment (a link post's URL, and the links written in a text, a caption or a comment) against the list of malware URLs that [URLhaus](https://urlhaus.abuse.ch) publishes, and gives a post with a listed link a score of 0. With the default thresholds that post is refused with `422`.

To turn it on:

1. Get the Auth-Key of an abuse.ch account, which is free: [auth.abuse.ch](https://auth.abuse.ch).
2. Set `TRUST_OPTIONAL_PLUGINS=urlhaus` and `URLHAUS_AUTH_KEY` to the key. A server that names `urlhaus` without a key doesn't start.
3. Make sure the server can reach `urlhaus-api.abuse.ch` over HTTPS.

What to know about it:

- **The server never follows a link.** Each process downloads the list, keeps it in memory, and looks links up there, so checking a link takes no request. The list is downloaded again every `URLHAUS_REFRESH_MINUTES` (15), in the background.
- **When URLhaus can't be reached**, the list the process has stays in use. Only a process that never got a list refuses posts: one with an `http` or `https` link fails with `500` until a download succeeds, which is tried again every minute. Posts without links aren't affected.
- **What matches** is a listed URL, however it's written: with either scheme, with a query or a fragment added, or with more path after it. Other pages of the same host don't match, since URLhaus lists files on hosts that many people share.
- **What it doesn't catch:** a URL that URLhaus lists after the post was sent, a URL that redirects to a listed one, as a link shortener does, and what URLhaus doesn't collect, such as phishing pages.
- By default the list is the URLs added in the last 30 days (`URLHAUS_LIST_URL`).

## Parameters of `assess`

`assess(post, ctx)` is called with two objects. The examples above destructure the fields they need from each.

`post` is what is being assessed: a new post, an update of a post, or a comment.

| Field | Type | What it is |
| --- | --- | --- |
| `userId` | `string` | The id of the user who sent it: a post's publisher, or a comment's author. |
| `contentId` | `string`, or absent | Only there for an update: the id of the post being updated. Absent for a new post and for a comment. |
| `commentOn` | `string`, or absent | Only there for a comment: the id of the post the comment is on. Absent for a post, so it tells the two apart. |
| `tags` | `string[]` | The hashtags the post was sent with, normalised, before moderation drops any. Always empty for a comment. |
| `texts` | `string[]` | Everything there is to read. For a post: its text, caption or link, and its filename. For a comment: its text, and the name of its image or video. Parts that are missing are left out. A text, a caption and a comment's text are as their readers read them: without their [formatting](TEXT_EDITORS.md), and with each link's address after its label, so `[here](https://example.com)` is `here https://example.com`. |

`ctx` is what the plugin has to work with.

| Field | Type | What it is |
| --- | --- | --- |
| `db` | `Db` | The server's database, as a [Kysely](https://kysely.dev) query builder. |
| `config` | `Config` | The server's [configuration](CONFIG.md). `config.trust.deleteBelow` and `config.trust.allowFrom` are the scores below which a post is refused, and from which it is published. |
| `now` | `() => number` | The current time in milliseconds. Call it instead of `Date.now()`. |
| `log` | `FastifyBaseLogger`, or absent | The log of the request that sent the post, for what the server's operator should know. Absent where a post is scored outside a request, so call it as `log?.warn(...)`. |
| `score` | `number` | The score so far, from 0 to 100: 100 for the first plugin, then whatever the plugins before this one left. |

Things to consider:

- `reason` is optional. If the post is refused, the publisher gets the reason of the plugin that last lowered the score, or a general message if it gave none. Words written here are sent as they are, in every language. To have a reason translated, add it to the [language files](LANGUAGES.md) and return its key instead: `reason: msg('moderation.blocked_word')`, with `msg` from `src/language.ts`.

- A folder without a plugin in it stops the server from starting, even if its plugin would be optional and off. A plugin that throws fails the post with `500`, and nothing is stored.

- A plugin that needs a setting of its own can read it from `config`, as `urlhaus` reads `config.urlhaus`. Making the plugin optional keeps a server that hasn't set it from running the plugin.

Plugins are part of the server: they run with its access to the database and its configuration, so install only code you'd run as the server itself.