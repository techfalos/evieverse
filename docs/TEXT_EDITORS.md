# Text editors

Posts, captions, comments and a profile's bio can be formatted: bold, italic, struck through, code, links, quotes and lists. The format is a small subset of Markdown, and there's no HTML in it: `<b>` is three characters, shown as any others are. Posts, captions and comments can also [mention](#mentions) users, with `@` and a username.

This document is for whoever builds the box a user writes in, or the screen a text is shown on. It says where the format is used, what it is, and how to write and show it. How the server itself uses it is in [APP.md](APP.md#text-formatting).

## Where it's used

Four texts are formatted. The first three are sent in a field named `text`, and a bio in `bio`:

| Text | Sent with | Longest |
| --- | --- | --- |
| A text post's text | [`POST /store`](API.md#post-store), `type: "text"` | 40,000 characters |
| An image's, video's or audio's caption | [`POST /store`](API.md#post-store), `type: "image"`, `"video"` or `"audio"` | 40,000 characters |
| A comment's text | [`POST /content/:contentId/comments`](API.md#post-contentcontentidcomments), and `PATCH` to edit it | 2,000 characters |
| A [profile](API.md#a-users-profile)'s bio | [`PATCH /users/:userId`](API.md#get-usersuserid-and-patch-usersuserid) | 500 characters |

The server stores each as it was sent and returns it so. There's no flag to set and no second field: the formatting is part of the text, like its punctuation, and its characters count towards the limit. No text is refused for its formatting. Whatever doesn't fit the rules below is the characters it's written with.

A client reads the formatting wherever one of these texts comes back:

| Field | Where | What it holds |
| --- | --- | --- |
| `text` | [`GET /content/:contentId`](API.md#get-contentcontentid) | The whole text or caption, as written. A text post's bytes (`contentUrl`) are the same text. |
| `preview.text` | Feeds, `GET /content/:contentId`, and the response of `POST /store` | The start of the text or caption, itself a formatted text ([below](#previews)). |
| `text` | A [comment](API.md#comments), in every list of them | The comment's text, as written. |
| `bio` | [`GET /users/:userId`](API.md#get-usersuserid-and-patch-usersuserid) | The bio, as written. `null` for a user who has none. |

Each comes with `mentions` where the text mentions users: the list a client reads the text with, to tell which of its `@` are mentions ([below](#mentions)). A feed record's `mentions` are the ones its `preview.text` names. A bio comes with none: it mentions nobody, and every `@` in it is the character.

Everything else is plain text, shown as written: a link post's URL, a profile's links, hashtags, usernames, direct messages, the instance's rules, ads, and a notice's `text` and `excerpt`. An `excerpt` quotes a post or comment with its formatting already taken out.

## The format

| Written | Shown as |
| --- | --- |
| `**bold**` or `__bold__` | bold |
| `*italic*` or `_italic_` | italic |
| `~~struck~~` | struck through |
| `` `code` `` | code, in which nothing else is read |
| `[label](https://example.com)` | a link with that label |
| `https://example.com` | a link, written out |
| `@alice` | a mention of the user alice, where the text's `mentions` name them: a link to their profile |
| `\*` | the character itself: a backslash before any ASCII punctuation |
| a blank line | the end of a paragraph |
| a new line | a line break |
| `> ` at the start of a line | a quote, of the lines in a row that start so |
| `- ` or `* ` at the start of a line | an item of a bulleted list |
| `1. ` at the start of a line (any number) | an item of a numbered list, which starts at its first item's number |

The rules behind the table, which a client follows to read a text exactly as the server does:

- **Bold, italic and struck through** open before something other than a space, and close after one: `2 * 3 * 4` has no italic in it, and neither has `** bold **` any bold.
  - A `_` inside a word is itself, so `snake_case` stays as it is. A `*` works inside a word: `un*believ*able`.
  - `***both***` is bold and italic. Four or more of `*` or `_` in a row are text, and so is `~` in any number but two.
  - They nest in each other and in a link's label, but not each in itself.
  - They close within their paragraph, quote or list item. What's opened and never closed is the characters it was written with. So is what was opened inside something that closed first: in `[a *b](https://example.com) c*` the link is a link, and neither `*` is anything.
- **Code** is between two backticks on one line, with something between them. Nothing in it is read: no backslash, no bold.
- **A link's address** starts with `http://` or `https://`, in either case. It has no space in it, nor any of `< > [ ] " \` or a backtick.
  - In `[label](address)` it's at most 2,048 characters, and its parentheses pair. Anything else between the parentheses, `javascript:` included, leaves the brackets and parentheses as text. So does an empty label, and a title after the address.
  - A label has no link in it: an address written out there is the label's text.
  - An address written out ends before the punctuation that follows it (`.,;:!?'*_~`, and a `)` that closes nothing in it), and isn't one in the middle of a word.
- **A mention** is an `@` followed by the name of one of the text's `mentions` ([below](#mentions)). Nothing is a mention in code, nor in the label of a link.
- **A backslash** before an ASCII punctuation character makes it that character: `\*`, and `\@`, which mentions nobody. Before anything else, a backslash is a backslash.
- **Blocks** are told by the very start of a line, with no spaces before it.
  - A paragraph is the lines in a row that start nothing else. A new line in it is a line break, where Markdown would join the two lines.
  - A quote is the lines in a row that start with `>`. Bold, links and the rest are read in it, and a new line is a line break, but it holds no lists and no other quotes.
  - A list item is one line: its mark, a space, and its text. Items in a row of the same kind are one list. A numbered item is up to nine digits and a `.`, so `1.5 litres` and `-5 degrees` are paragraphs.

Markdown that pairs its marks in the usual way reads the same here. The rest of Markdown (headings, images, tables, fenced code, lists inside lists) and all HTML are text, shown as written.

### Mentions

A text mentions a user with `@` and their username: `Thanks @alice`. The user gets a notice once the text is published, and the mention is shown as a link to their profile ([API.md](API.md#mentions)).

The text alone doesn't say which of its `@` are mentions. A username can hold any characters, spaces among them, so `@Ann Lee and Bob` could name `Ann`, `Ann Lee` or `Ann Lee and Bob`, and whose a name is can change after the text is written. So the server finds whom a text mentions when it's written, and returns them beside it: `mentions`, a list of `{ userId, username }`, each user with the name the text has them by. A client reads the text with that list:

- **An `@` followed by one of the list's names is a mention** of that user. The name is as the list has it, to the letter, capitals included.
- **The `@` doesn't follow a letter or a digit,** so `mail@alice.example` mentions nobody.
- **The name ends there:** what follows it isn't a letter or a digit, nor a `_` before one. `@ann_marie` doesn't mention `ann`.
- **Of several names that fit, the longest is the one:** `@Ann Lee` is Ann Lee where both she and Ann are in the list.
- **The name is read as the text reads.** A character the text escapes is the character, so `@snake\_case` names `snake_case`.
- **A mention is on one line,** and can be inside bold, italic or struck-through text, a quote or a list item. It isn't one in code, nor in the label of a link, which leads where the link does.
- **`\@` is an `@` that mentions nobody.**
- **A text read without its `mentions` has none:** every `@` is the character. A name that isn't in the list isn't a mention, even if a user has it by now. That's how a bio is read, which mentions nobody and notifies nobody.

A mention is shown as `@` and the name, and links to the profile of its `userId` ([`GET /users/:userId`](API.md#get-usersuserid-and-patch-usersuserid)): by the id, since the user may have changed their name since.

A text mentions 10 users at most, and the server looks at the first 50 `@` of a text: what a text names past those is text.

## Writing it

Use the following marks in plain text: 

- **Use `**` for bold and `*` for italic.** They work inside a word, which `__` and `_` don't.
- **Put the marks against the text.** Take the spaces at the ends of a selection out of it before wrapping it: `**bold** ` and not `**bold **`.
- **Wrap each block on its own.** A selection that runs over a blank line or over several list items gets its marks once per paragraph or item.
- **Percent-encode what an address can't hold**: a space as `%20`, and a parenthesis that has no pair as `%28` or `%29`.
- **To mention a user, write `@` and their username as it is,** capitals and spaces included. An editor that offers users to pick from inserts the name it was given. Whom the text mentions is the server's to say: show the text with the `mentions` its answer came with, not with the ones the editor expected.

An editor that shows the text formatted while it's written (rather than its marks) has to keep what the user typed from being read as marks. When it turns its content into the text to send, it puts a backslash before:

| What the user typed | Sent as |
| --- | --- |
| Any of `\ * _ ~ [ ]` or a backtick, outside code | `\\`, `\*`, `\_`, and so on |
| `- ` or `> ` at the start of a line | `\- `, `\> ` |
| `1. ` at the start of a line | `1\. ` |
| An address that isn't meant as a link | `https\://example.com` |
| An `@` that isn't meant as a mention | `\@` |

Nothing is escaped inside code, so code can't hold a backtick or a new line.

The server trims the spaces at both ends of a text, and counts its characters as written, marks and backslashes included. Count the same way to tell a user how much room is left.

## Showing it

Read the text into its blocks, and build the screen's own elements from them. Never put the text, or anything made from it by replacing characters, into the page as HTML.

The server's parser is [`src/format.ts`](../src/format.ts), and [`testbed/web/format.js`](../testbed/web/format.js) is the same parser as a plain JavaScript module, with no dependencies, that a page can load. `parseFormatted(text, mentions)` returns the text's blocks, read with the `mentions` that came with the text (none, where it came with none):

```ts
type Block =
  | { type: 'paragraph' | 'quote'; children: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] };

type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'break' }
  | { type: 'bold' | 'italic' | 'strike'; children: Inline[] }
  | { type: 'link'; url: string; children: Inline[] }
  | { type: 'mention'; userId: string; username: string };
```

A page shows them like this:

```js
import { parseFormatted } from './format.js';

const TAGS = { bold: 'strong', italic: 'em', strike: 's', code: 'code', link: 'a' };

function inline(nodes, into) {
  for (const node of nodes) {
    if (node.type === 'text') into.append(node.text);
    else if (node.type === 'break') into.append(document.createElement('br'));
    else if (node.type === 'mention') {
      const el = into.appendChild(document.createElement('a'));
      el.textContent = `@${node.username}`;
      el.href = `/users/${encodeURIComponent(node.userId)}`; // wherever the client shows a profile
    } else {
      const el = into.appendChild(document.createElement(TAGS[node.type]));
      if (node.type === 'code') el.textContent = node.text;
      else inline(node.children, el);
      if (node.type === 'link') Object.assign(el, { href: node.url, target: '_blank', rel: 'noopener noreferrer nofollow' });
    }
  }
}

export function show(text, mentions, into) {
  for (const block of parseFormatted(text, mentions ?? [])) {
    if (block.type === 'list') {
      const list = into.appendChild(document.createElement(block.ordered ? 'ol' : 'ul'));
      if (block.ordered) list.start = block.start;
      for (const item of block.items) inline(item, list.appendChild(document.createElement('li')));
    } else {
      inline(block.children, into.appendChild(document.createElement(block.type === 'quote' ? 'blockquote' : 'p')));
    }
  }
}
```

- **A link's `url` is always `http` or `https`**: the parser makes a link.
- **A mention's link is the client's to build,** from its `userId`: to its own screen for a profile, which reads [`GET /users/:userId`](API.md#get-usersuserid-and-patch-usersuserid).
- **Pass the `mentions` that came with the text you show:** a post's with its `text`, a feed record's with its `preview.text`, a comment's with its `text`. Without them no `@` is a mention, which is how a bio is shown: `show(bio, [], into)`.
- **A client in another language** writes its own parser to the rules above.
- **For a text without its formatting** join the `text` of the blocks' `text` and `code` nodes, with `@` and the `username` for a mention.

## What moderation reads

Blocked words and [trust plugins](TRUST_PLUGINS.md) read a text as its readers do: without the characters that format it, and with each link's address after its label. `sp**am**` is the word "spam", and a link is read for where it leads as well as for what it says. A post, a comment or a bio that's refused gets `422`, as [API.md](API.md#moderation) describes, however it was formatted.
