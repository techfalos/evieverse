# Trust plugins

A trust plugin is an algorithm that looks at a post and may lower its trust score, which [decides where the post goes](API.md#moderation). Each folder of `src/plugins/trust` is one plugin, named after the folder, and every new post, update and comment goes through all of them. The server comes with `src/plugins/trust/blocked_words`.

To add one, add a folder with an `index.ts` whose default export has an `assess` function, and build and restart the server:

```ts
// src/plugins/trust/links/index.ts
import type { TrustAlgorithm } from '../../../moderation/trust.js';

export default {
  assess({ texts }) {
    const links = texts.join(' ').match(/https?:\/\//g)?.length ?? 0;
    if (links > 3) return { reduce: 40, reason: "the post has too many links, so it wasn't published" };
  },
} satisfies TrustAlgorithm;
```

- `assess(post, ctx)` gets the post (`userId`, `tags`, `texts`, which are its text, caption or link and its filename, and `contentId` if it's an update) and a context (`db`, `config`, `now`, and `score`, the score so far). It can be async.
- **Comments go through the same plugins.** For a comment, `commentOn` is the id of the post it's on, `userId` is its author, `texts` holds its text, and `tags` is empty. A plugin that leaves `commentOn` alone treats comments as it treats posts; one that should only look at posts returns nothing when `commentOn` is set. The example above would tell a commenter that "the post" has too many links, so a plugin that words a `reason` can go by `commentOn` there too.
- It returns `{ set: <score> }` or `{ reduce: <points> }`, or nothing to leave the score alone.
- **The score only goes down.** A plugin that sets a score higher than the current one changes nothing, so where plugins disagree, the lower score wins. A reduction always applies. The score never goes below 0 and is kept as a whole number, rounded down.
- Plugins run one after another in the order of their folder names, and all of them run, whatever the score. The order only matters when sets and reductions mix: set to 50 and then reduce by 20 gives 30, the other way round gives 50.
- `reason` is optional. If the post is refused, the publisher gets the reason of the plugin that last lowered the score, or a general message if it gave none. Words written here are sent as they are, in every language. To have a reason translated, add it to the [language files](LANGUAGES.md) and return its key instead: `reason: msg('moderation.blocked_word')`, with `msg` from `src/language.ts`.
- A folder without a plugin in it stops the server from starting. A plugin that throws fails the post with `500`, and nothing is stored: no post is published without every plugin having looked at it.

Plugins are part of the server: they run with its access to the database and its configuration, so install only code you'd run as the server itself.
