import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ApiError, apiClient, BUILD, CliError, serverUrl, VERSION } from './client.js';
import type { Args, Command, Context, Io, Role, WhoAmI } from './commands.types.js';
import { DEFAULT_PROFILE, listProfiles, readProfile, removeProfile, writeProfile } from './profiles.js';
import { installRelease, latestRelease } from './update.js';

/** The one request a command made with `endpoint` or `own` sends: its method, its path with any query, and its body if it has one. */
interface Request {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/** The largest file `comments add --file` sends: it goes inside the request, which a server takes 32 MB of, a third of that being what base64 adds. */
const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;

/** The option that makes a command about a post one about a comment on it. */
const COMMENT_OPTION = { comment: { type: 'string' } } as const;
/** `COMMENT_OPTION`, as the usage line of a command that takes it shows it. */
const COMMENT_FLAG = '[--comment <commentId>]';

/** The options of a command that lists a page at a time. */
const PAGE_OPTIONS = { limit: { type: 'string' }, cursor: { type: 'string' } } as const;
/** `PAGE_OPTIONS`, as the usage line of a command that takes them shows them. */
const PAGE_FLAGS = '[--limit <n>] [--cursor <cursor>]';

/** Where a post is read on its server: https://other.example/content/<id>. */
const POST_ADDRESS = /^(.+)\/content\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Why a repost didn't give a hashtag, as the server names it. */
const NOT_GIVEN: Record<string, string> = {
  already_tagged: 'the post has it already',
  muted: 'you or its publisher are muted on it',
  removed: 'a moderator removed it from the post',
  blocked_word: 'the post has a word it blocks',
};

/**
 * The sections of `help`, in the order it shows them: the role whose commands each one lists, and
 * its title, which names the hashtags `me` moderates if the server said who the key's user is.
 */
const SECTIONS: { role: Role; title: (me?: WhoAmI) => string }[] = [
  { role: 'anyone', title: () => 'For everyone' },
  {
    role: 'moderator',
    title: (me) => `For a hashtag's moderators${me?.moderates.length ? ` (you moderate ${hashtags(me.moderates)})` : ''}, and server moderators and admins on every hashtag`,
  },
  { role: 'serverModerator', title: () => 'For server moderators, and admins' },
  { role: 'admin', title: () => 'For admins' },
];

/** A path with each value encoded as one segment. */
const path = (parts: TemplateStringsArray, ...values: string[]) => parts.reduce((out, part, i) => out + encodeURIComponent(values[i - 1]!) + part);

/** Hashtags as people read them: ["news", "mumbai"] -> "#news #mumbai". */
const hashtags = (tags: string[]) => tags.map((t) => `#${t}`).join(' ');

/** Rows in columns as wide as their longest cell. */
function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ')).join('\n');
}

/** An admin can do all the others can, so only that is said of one. A ban is said after the roles. */
function roles(me: WhoAmI): string {
  const held = [me.moderator && 'a server moderator', me.moderates.length > 0 && `moderator of ${hashtags(me.moderates)}`].filter(Boolean);
  const role = me.admin ? 'an admin' : held.length ? held.join(', and ') : 'no moderation role';
  return me.banned ? `${role}; banned, so you can't post, comment, like or send messages` : role;
}

/** A post as the feed and the moderation queue give it, as far as the CLI shows it. */
interface PostRecord {
  contentId: string;
  publisher: { userId: string; username: string };
  preview: { kind: string; text?: string; url?: string };
  tags: string[];
  createdAt: string;
}

/** A text on one line, cut to what a row of a list has room for. */
function oneLine(text: string | undefined): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** What a post is, on one line: its text, its link, or the kind of file it is and its caption. */
const snippet = ({ preview }: PostRecord): string =>
  oneLine(preview.kind === 'text' ? preview.text : preview.kind === 'link' ? preview.url : [`[${preview.kind}]`, preview.text].filter(Boolean).join(' '));

/**
 * A comment on a post, as the server gives it; or what is left in the place of one that has
 * replies and isn't there to read: no author, no text, and a `status` that says why.
 */
interface CommentRecord {
  commentId: string;
  /** The post it is on. */
  contentId: string;
  /** The comment it replies to; null for a comment on the post itself. */
  parentId: string | null;
  /** Null on what stands in a comment's place. */
  author: { userId: string; username: string } | null;
  /** Empty for one that is only its image or video. */
  text: string;
  /** Whether its author declared it created with AI; false on what stands in a comment's place. */
  aiGenerated: boolean;
  /** The image or video it came with, and where its bytes are read; null for one that is only text. */
  media: { kind: 'image' | 'video'; url: string; mimeType: string; size: number; alt?: string } | null;
  likes: number;
  /** How many comments reply to it. */
  replies: number;
  createdAt: string;
  /** When its author last edited it; null for one that never was. */
  editedAt: string | null;
  /** "pending_review" on one that waits in the moderation queue; "deleted" on what a deleted comment that has replies leaves; "blocked" on one by a user you block. */
  status?: string;
}

/** A count with its noun, which is `one` for 1 and `many` for any other: "1 like", "0 likes". */
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What a comment is, on one line: the kind of file it came with, if it came with one, with what
 * describes an image that is described (its alternative text), and its
 * text. Of one that isn't there to read, why: it was deleted, its author is someone you block, or
 * it waits for the server's moderators.
 */
const commentLine = ({ author, media, text, status }: CommentRecord): string =>
  author === null
    ? status === 'deleted'
      ? '[deleted]'
      : status === 'blocked'
        ? '[by a user you block]'
        : '[waits for moderators]'
    : oneLine([media && (media.alt ? `[${media.kind}: ${media.alt}]` : `[${media.kind}]`), text].filter(Boolean).join(' '));

/** A file to send inside a request, as the server takes one inline: its bytes in base64, and its name, which says what type it is. */
async function inlineFile(file: string): Promise<{ content: string; contentEncoding: 'base64'; filename: string }> {
  let bytes: Buffer;
  try {
    if ((await stat(file)).size > MAX_INLINE_FILE_BYTES) throw new CliError(`${file} is larger than the ${MAX_INLINE_FILE_BYTES / 1024 / 1024} MB this command can send`, 2);
    bytes = await readFile(file);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`could not read ${file}: ${(err as Error).message}`, 2);
  }
  return { content: bytes.toString('base64'), contentEncoding: 'base64', filename: basename(file) };
}

/** What waits in the moderation queue or the report queue: a post, or a comment on one. */
type QueueItem = ({ kind: 'post' } & PostRecord) | ({ kind: 'comment' } & CommentRecord);

/**
 * A queue's row: which it is, its id, who wrote it, what the queue says of it (`facts`), and then a
 * post's hashtags or the post a comment is on, and what it says. A comment is decided on by both
 * ids: `<contentId> --comment <commentId>`.
 */
const queueRow = (item: QueueItem, facts: string[]): string[] =>
  item.kind === 'comment'
    ? ['comment', item.commentId, item.author?.username ?? '', ...facts, `on ${item.contentId}`, commentLine(item)]
    : ['post', item.contentId, item.publisher.username, ...facts, hashtags(item.tags), snippet(item)];

/** The id of the comment `--comment` names; undefined for a command about the post itself. */
const commentOf = ({ values }: Args) => (typeof values.comment === 'string' ? values.comment : undefined);

/** Where a queue's request about a post goes, or with --comment, the one about a comment on it. */
function queuePath(queue: 'queue' | 'reports', args: Args, decision?: string): string {
  const contentId = args.positionals[0]!;
  const commentId = commentOf(args);
  const about = commentId === undefined ? path`/moderation/${queue}/${contentId}` : path`/moderation/${queue}/${contentId}/comments/${commentId}`;
  return decision ? `${about}/${decision}` : about;
}

/** The page options a command was given, as the query of its request, after what `query` already asks; "" if neither asks anything. */
function pageQuery({ values }: Args, query = new URLSearchParams()): string {
  for (const name of ['limit', 'cursor']) if (typeof values[name] === 'string') query.set(name, values[name]);
  return query.size ? `?${query}` : '';
}
/** The line that ends a list which has another page, with the cursor that asks for it; "" after the last page. */
const more = (nextCursor: string | null) => (nextCursor ? `\nThere are more: --cursor ${nextCursor}` : '');

/** What deleting an account answers: gone, or on its way out while the compactor deletes its posts. */
interface AccountDeleted {
  userId: string;
  status: 'deleted' | 'pending_deletion';
  requestedAt?: string;
}

/** Deleting an account can't be undone, so the commands that do it go ahead only when told to. */
function confirmed({ values }: Args, what: string): void {
  if (values.yes !== true) throw new CliError(`${what} can't be undone: run the command again with --yes to go ahead`, 2);
}

/** What the CLI says of an account's deletion: that the account is gone, or that it goes once the last of its posts is removed. */
const deletedText = (d: AccountDeleted) =>
  d.status === 'deleted' ? `Deleted account ${d.userId}.` : `Deleted account ${d.userId}: its posts are being removed, and the account goes with the last of them.`;

/** One of the server's rules, or of a hashtag's, as the server gives them: `position` is its place in the list, from 1. */
interface RuleRecord {
  ruleId: string;
  position: number;
  text: string;
}

/** A claim to moderate a hashtag that waits, as the server gives it: who made it, when, and when it is granted unless an admin or a server moderator refuses it before. */
interface ClaimRecord {
  tag: string;
  userId: string;
  username: string;
  claimedAt: string;
  reviewUntil: string;
}

/** What ending a hashtag's claim answers: whether there was one, and whose. */
interface ClaimEnded {
  tag: string;
  wasClaimed: boolean;
  userId?: string;
}

/** What a server says of the code it runs, beside its rules: its operator's statement. */
interface ModificationDisclosure {
  /** Whether it runs a modified version of Evieverse, and not a release. */
  modified: boolean;
  /** The release it runs, or the one its modified version is based on. */
  release: string;
  /** Where its source code can be obtained, which a modified version says. */
  sourceUrl: string | null;
}

/** The body of a request that adds or changes a rule: the text it was given, and the place, each only if named. */
function ruleBody({ values }: Args, text?: string): { text?: string; position?: number } {
  const { position } = values;
  if (typeof position === 'string' && !/^[1-9]\d*$/.test(position)) throw new CliError('--position is a place in the list of rules, counted from 1', 2);
  return { ...(text !== undefined && { text }), ...(typeof position === 'string' && { position: Number(position) }) };
}

/** How many reports of a post or a comment there are, in words: "1 report", "3 reports". */
const reportCount = (reports: number) => `${reports} ${reports === 1 ? 'report' : 'reports'}`;

/** A command that is one request to the server, with the profile's key. */
function endpoint<T>(spec: Omit<Command, 'run'> & { request(args: Args): Request; text(data: T, args: Args): string }): Command {
  const { request, text, ...command } = spec;
  return {
    ...command,
    async run(ctx, args) {
      const { method, path: url, body } = request(args);
      const data = await (await ctx.api()).request<T>(method, url, body);
      return { data, text: text(data, args) };
    },
  };
}

/** A command that is one request about the profile's own account, which the request's path names by its userId. */
function own<T>(spec: Omit<Command, 'run'> & { request(args: Args, userId: string): Request; text(data: T, args: Args): string }): Command {
  const { request, text, ...command } = spec;
  return {
    ...command,
    async run(ctx, args) {
      const { method, path: url, body } = request(args, (await ctx.profile()).profile.userId);
      const data = await (await ctx.api()).request<T>(method, url, body);
      return { data, text: text(data, args) };
    },
  };
}

/**
 * What is in an inbox: a message a user sent, or a notice of the server's, which may quote the post or the comment it
 * is about. A notice has no sender, but for the notice of a mention, whose sender is who mentioned the user.
 */
interface InboxItem {
  messageId: string;
  kind: string;
  from?: { userId: string; username: string } | null;
  text: string;
  excerpt?: string;
  sentAt: string;
  readAt: string | null;
}

/** An inbox's row: what it is, when it came, whether it was read, who sent it (to answer or block them), and what it says, on one line. */
function inboxRow(m: InboxItem): string[] {
  return [
    m.messageId,
    m.sentAt,
    m.readAt ? 'read' : 'new',
    // What says nothing of a sender is the server's own: a message and the notice of a mention say whose they are.
    m.kind !== 'message' && m.from === undefined ? 'the server' : m.from ? `${m.from.username} (${m.from.userId})` : '(an account that is gone)',
    // A notice about a comment (comment_accepted, comment_deleted, ...) quotes the comment.
    (m.excerpt ? `${m.text} The ${m.kind.startsWith('comment_') ? 'comment' : 'post'}: "${m.excerpt}"` : m.text).replace(/\s+/g, ' ').trim(),
  ];
}

/** Turns messages between users on or off for the profile's account. */
const messages = (verb: 'on' | 'off') =>
  own<{ messages: boolean }>({
    name: `messages ${verb}`,
    role: 'anyone',
    summary:
      verb === 'on'
        ? 'Turns messages between users on for your account, as it is to begin with.'
        : "Turns messages between users off for your account: you are sent none, and send none. The server's notices still reach your inbox.",
    request: (_args, me) => ({ method: 'PATCH', path: path`/users/${me}`, body: { messages: verb === 'on' } }),
    text: (d) => (d.messages ? 'Messages are on: other users can send you messages, and you them.' : 'Messages are off: other users can send you none, and you send none.'),
  });

/** The blocked words a `words` command is about: a hashtag's (--tag), or the server's (--server). */
function wordList({ values }: Args): string {
  const tag = values.tag;
  if ((typeof tag === 'string') === (values.server === true)) throw new CliError('name one list: --tag <tag> for a hashtag, or --server for the whole server', 2);
  return typeof tag === 'string' ? path`/tags/${tag}/blocked-words` : '/moderation/blocked-words';
}

/**
 * A `words` command: lists a list of blocked words (see `wordList`), adds to it or removes from it,
 * and prints the list as the server answers it. `add` and `remove` take the words as arguments.
 */
const words = (verb: 'list' | 'add' | 'remove', method: Request['method'], summary: string) =>
  endpoint<{ tag?: string; words: string[] }>({
    name: `words ${verb}`,
    ...(verb !== 'list' && { rest: 'word' }),
    options: { tag: { type: 'string' }, server: { type: 'boolean' } },
    flags: '(--tag <tag> | --server)',
    role: 'moderator',
    summary,
    request: (args) => ({ method, path: wordList(args), ...(verb !== 'list' && { body: { words: args.positionals } }) }),
    text: (d) => (d.words.length ? d.words.join('\n') : `${d.tag ? `#${d.tag}` : 'The server'} has no blocked words.`),
  });

/** What a post's own server answers GET /content/:id/attestation with, as far as a repost reads it. */
interface Attested {
  /** The post as the server signed it, which is what POST /repost takes for a post on another server. */
  attestation?: string;
  /** Of a post that is itself a repost of one on another server (409): the original, which is the one to repost. */
  origin?: { url?: string };
  /** Why there is no attestation, as the server says it. */
  error?: string;
}

/**
 * What to repost, for the address of a post: the post's id, if the address is on the profile's own
 * server, and otherwise the post's attestation, which is asked for here, of the server the post is
 * on: that server signs what the post is, and the profile's server checks the signature, so
 * nothing the CLI could say of the post is taken on its word. The request carries no key: the key
 * is the profile's server's, and a post anyone can repost is one anyone can read.
 *
 * A post that is itself a repost of one on another server names its original, and that is what is
 * reposted, so that a post has one address wherever it is reposted from: the original's server is
 * then the one asked.
 */
async function repostSource(io: Io, server: string, address: string): Promise<{ contentId: string } | { origin: { attestation: string } }> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new CliError(`"${address}" is not the address of a post, such as https://other.example/content/<id>`, 2);
  }
  const at = POST_ADDRESS.exec(`${url.origin}${url.pathname}`);
  if (!['http:', 'https:'].includes(url.protocol) || !at || url.search || url.hash) {
    throw new CliError(`"${address}" is not the address of a post, such as https://other.example/content/<id>`, 2);
  }

  // The post at the address, and then at most the original it names: an original is nobody's repost.
  let found: RegExpExecArray | null = at;
  for (const last of [false, true]) {
    if (found[1] === server) return { contentId: found[2]!.toLowerCase() };
    const where = `${found[1]}/content/${found[2]!.toLowerCase()}`;
    let status: number;
    let answer: Attested | null;
    try {
      const res = await io.fetch(`${where}/attestation`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      status = res.status;
      answer = (await res.json().catch(() => null)) as Attested | null;
    } catch (err) {
      const e = err as Error & { cause?: { message?: string } };
      throw new CliError(`could not read the post at ${where}: ${e.name === 'TimeoutError' ? 'no answer in 60 seconds' : (e.cause?.message ?? e.message)}`);
    }
    if (status === 200 && typeof answer?.attestation === 'string') return { origin: { attestation: answer.attestation } };
    if (status === 404) throw new CliError(`there is no post at ${where}, or its server doesn't sign its posts for reposts`);
    const original = status === 409 && !last && typeof answer?.origin?.url === 'string' ? POST_ADDRESS.exec(answer.origin.url) : null;
    if (!original) throw new CliError(`could not repost the post at ${where}: ${typeof answer?.error === 'string' ? answer.error : `its server answered ${status}`}`);
    found = original;
  }
  throw new CliError(`could not repost the post at ${address}`);
}

/** What POST /repost answers: the hashtags the post got, those it didn't with why, and for a post from another server, the entry made for it here. */
interface Reposted {
  contentId: string;
  tags: string[];
  removedTags?: { tag: string; reason: string }[];
  repostedAt?: string;
  status?: string;
  origin?: { url: string };
}

/**
 * Every command the CLI has. The arguments name one by its `name` (see `findCommand` in main.ts),
 * and `helpText` lists them by `role`, in the order they have here.
 */
export const COMMANDS: Command[] = [
  {
    name: 'login',
    positionals: ['server', 'userId'],
    role: 'anyone',
    summary: 'Checks your API key with the server and saves it as a profile. It asks for the key, or reads EVIEVERSE_API_KEY.',
    async run({ io, profileName }, { positionals: [server, userId] }) {
      const profile = { server: serverUrl(server!), userId: userId!, apiKey: '' };
      profile.apiKey = (io.env.EVIEVERSE_API_KEY ?? (await io.readSecret('API key: '))).trim();
      if (!profile.apiKey) throw new CliError('no API key was given', 2);
      const me = await apiClient(io.fetch, profile).request<WhoAmI>('GET', '/whoami');
      const name = profileName ?? DEFAULT_PROFILE;
      const file = await writeProfile(io.home, name, { ...profile, username: me.username });
      return {
        data: { profile: name, file, server: profile.server, ...me },
        text: `Signed in to ${profile.server} as ${me.username} (${roles(me)}).\nSaved as profile "${name}" in ${file}`,
      };
    },
  },
  {
    name: 'logout',
    role: 'anyone',
    summary: 'Removes the profile from this machine. Its key still works on the server.',
    async run(ctx) {
      const { name } = await ctx.profile();
      await removeProfile(ctx.io.home, name);
      return { data: { profile: name, removed: true }, text: `Removed profile "${name}" from this machine. Its key still works on the server.` };
    },
  },
  {
    name: 'profiles',
    role: 'anyone',
    summary: 'Lists the profiles on this machine.',
    async run({ io }) {
      const found = await Promise.all(
        (await listProfiles(io.home)).map(async (name) => {
          const p = await readProfile(io.home, name).catch(() => null);
          return { profile: name, server: p?.server ?? null, userId: p?.userId ?? null, username: p?.username ?? null };
        }),
      );
      return {
        data: found,
        text: found.length
          ? table(found.map((p) => [p.profile, p.server ?? '(not a profile)', p.username ?? p.userId ?? '']))
          : 'There are no profiles: sign in with `evieverse login <server> <userId>`.',
      };
    },
  },
  {
    name: 'whoami',
    role: 'anyone',
    summary: "Shows the account the profile's key belongs to, and its roles.",
    async run(ctx) {
      const { name } = await ctx.profile();
      const api = await ctx.api();
      const me = await api.request<WhoAmI>('GET', '/whoami');
      return { data: { profile: name, server: api.server, ...me }, text: `${me.username} (${me.userId}) on ${api.server}: ${roles(me)}` };
    },
  },
  {
    name: 'key rotate',
    role: 'anyone',
    summary: 'Replaces your API key with a new one, and saves it in the profile. The old key stops working, wherever else it is in use.',
    async run(ctx) {
      const { name, profile } = await ctx.profile();
      const { apiKey } = await (await ctx.api()).request<{ apiKey: string }>('POST', path`/users/${profile.userId}/key`);
      let file: string;
      try {
        file = await writeProfile(ctx.io.home, name, { ...profile, apiKey });
      } catch (err) {
        // The old key is revoked by now, so the new one is nowhere but here.
        throw new CliError(`the key was replaced, but profile "${name}" could not be saved (${(err as Error).message}). The new key, shown this once: ${apiKey}`);
      }
      return {
        data: { profile: name, file, userId: profile.userId, replaced: true },
        text: `Replaced the API key of profile "${name}": the old key no longer works.\nThe new one is saved in ${file}`,
      };
    },
  },
  {
    name: 'version',
    role: 'anyone',
    summary: "Shows this CLI's version and build.",
    run: async () => ({ data: { version: VERSION, build: BUILD }, text: `evieverse ${VERSION} (build ${BUILD})` }),
  },
  {
    name: 'update',
    role: 'anyone',
    summary: "Replaces this CLI with the one the profile's server ships.",
    async run(ctx) {
      const { server } = (await ctx.profile()).profile;
      const release = await latestRelease(ctx.io.fetch, server);
      const current = release.build === BUILD;
      if (!current) await installRelease(ctx.io.fetch, ctx.io.selfPath, server, release);
      return {
        data: { updated: !current, version: release.version, build: release.build },
        text: current ? `Already the CLI ${server} ships: ${release.version} (build ${release.build}).` : `Updated to ${release.version} (build ${release.build}).`,
      };
    },
  },
  {
    name: 'account delete',
    options: { yes: { type: 'boolean' } },
    flags: '--yes',
    role: 'anyone',
    summary:
      'Deletes your account, for good: your key stops working, your posts are deleted, and the profile is removed from this machine. Your comments stay, without your name. Needs --yes.',
    async run(ctx, args) {
      confirmed(args, 'deleting your account');
      const { name, profile } = await ctx.profile();
      const deleted = await (await ctx.api()).request<AccountDeleted>('DELETE', path`/users/${profile.userId}`);
      // Its key is dead now: the profile is of no use to anyone.
      await removeProfile(ctx.io.home, name).catch(() => undefined);
      return {
        data: { profile: name, ...deleted },
        text: `${deletedText(deleted)}\nRemoved profile "${name}" from this machine.`,
      };
    },
  },
  {
    name: 'repost',
    positionals: ['post'],
    options: { tags: { type: 'string' } },
    flags: '--tags <tags>',
    role: 'anyone',
    summary:
      "Reposts a post: gives it hashtags it doesn't have, under which it shows as a new post, as it does to those who follow you. Name the post by its id, or a post on another server by its address there (https://other.example/content/<id>): that server signs what the post is, and it is reposted here as a link to it. Quote the hashtags: --tags \"news, mumbai\".",
    async run(ctx, { positionals: [post], values }) {
      const { tags } = values;
      if (typeof tags !== 'string' || !tags.trim()) throw new CliError('name the hashtags the repost gives the post: --tags "news, mumbai"', 2);
      const api = await ctx.api();
      const d = await api.request<Reposted>('POST', '/repost', { ...(/^https?:\/\//i.test(post!) ? await repostSource(ctx.io, api.server, post!) : { contentId: post! }), tags });
      const what = d.origin ? d.origin.url : d.contentId;
      return {
        data: d,
        text: `${
          d.status === 'pending_review'
            ? `Your repost of ${what} waits for the server's moderators: ${d.contentId}`
            : d.origin
              ? `Reposted ${what} under ${hashtags(d.tags)}: it is ${d.contentId} here.`
              : `Reposted ${what} under ${hashtags(d.tags)}.`
        }${(d.removedTags ?? []).map((r) => `\nNot #${r.tag}: ${NOT_GIVEN[r.reason] ?? r.reason}.`).join('')}`,
      };
    },
  },
  endpoint<{ contentId: string; requestedAt: string }>({
    name: 'content delete',
    positionals: ['contentId'],
    role: 'anyone',
    summary: 'Deletes content: your own, or any content if you are an admin.',
    request: ({ positionals: [contentId] }) => ({ method: 'DELETE', path: path`/content/${contentId!}` }),
    text: (d) => `${d.contentId} is set for deletion.`,
  }),
  endpoint<{ contentId: string; commentId?: string; alreadyReported: boolean }>({
    name: 'content report',
    positionals: ['contentId'],
    options: { ...COMMENT_OPTION, reason: { type: 'string' } },
    flags: `${COMMENT_FLAG} [--reason <text>]`,
    role: 'anyone',
    summary:
      "Reports a post to the server's moderators, or with --comment, a comment on it, with what is wrong with it if you say. You report a post or a comment once.",
    request: (args) => ({
      method: 'POST',
      path: '/report',
      body: {
        contentId: args.positionals[0],
        ...(commentOf(args) !== undefined && { commentId: commentOf(args) }),
        ...(typeof args.values.reason === 'string' && { reason: args.values.reason }),
      },
    }),
    text: (d) => {
      const what = d.commentId === undefined ? d.contentId : `comment ${d.commentId}`;
      return d.alreadyReported ? `You had already reported ${what}.` : `Reported ${what} to the server's moderators.`;
    },
  }),
  endpoint<{ contentId: string; commentId?: string; count: number; comments: CommentRecord[]; nextCursor: string | null }>({
    name: 'comments list',
    positionals: ['contentId'],
    options: { ...PAGE_OPTIONS, newest: { type: 'boolean' }, 'replies-to': { type: 'string' } },
    flags: `[--replies-to <commentId>] [--newest] ${PAGE_FLAGS}`,
    role: 'anyone',
    summary:
      "Lists the comments on a post, or with --replies-to, the replies to one of them, oldest first, or with --newest, newest first. Each row says how many likes and replies the comment has, and whether its author says it was created with AI. A comment that has replies and was deleted, or waits for the server's moderators, is listed as that.",
    request: (args) => {
      const parentId = args.values['replies-to'];
      const contentId = args.positionals[0]!;
      return {
        method: 'GET',
        path: `${
          typeof parentId === 'string' ? path`/content/${contentId}/comments/${parentId}/replies` : path`/content/${contentId}/comments`
        }${pageQuery(args, new URLSearchParams(args.values.newest === true ? { order: 'newest' } : {}))}`,
      };
    },
    text: (d) =>
      (d.comments.length
        ? table(
            // A comment's row in a list of comments: its id (to reply to it, or to list its replies), who wrote it and when, its likes and replies, and what it says.
            d.comments.map((c: CommentRecord): string[] => [
              c.commentId,
              c.author?.username ?? '',
              c.createdAt,
              counted(c.likes, 'like', 'likes'),
              counted(c.replies, 'reply', 'replies'),
              `${commentLine(c)}${c.aiGenerated ? ' (created with AI)' : ''}${c.editedAt ? ' (edited)' : ''}`,
            ]),
          )
        : d.commentId === undefined
          ? `${d.contentId} has no comments.`
          : `Comment ${d.commentId} has no replies.`) + more(d.nextCursor),
  }),
  {
    name: 'comments add',
    positionals: ['contentId', 'text'],
    options: { file: { type: 'string' }, alt: { type: 'string' }, 'reply-to': { type: 'string' }, ai: { type: 'boolean' } },
    flags: '[--file <path>] [--alt <text>] [--reply-to <commentId>] [--ai]',
    role: 'anyone',
    summary:
      'Comments on a post that takes comments, or with --reply-to, replies to a comment on it; quote the text. With --file, the comment comes with an image or a video, and its text can be "". With --alt, an image comes with its alternative text, which describes it to those who can\'t see it; quote it. With --ai, you say that the comment was created with AI. One the server holds back waits for its moderators, as a post does.',
    async run(ctx, { positionals: [contentId, text], values }) {
      const body = {
        text,
        ...(typeof values['reply-to'] === 'string' && { parentId: values['reply-to'] }),
        ...(values.ai === true && { aiGenerated: true }),
        ...(typeof values.file === 'string' && (await inlineFile(values.file))),
        ...(typeof values.alt === 'string' && { alt: values.alt }),
      };
      const d = await (await ctx.api()).request<CommentRecord>('POST', path`/content/${contentId!}/comments`, body);
      return {
        data: d,
        text:
          d.status === 'pending_review'
            ? `Your ${d.parentId === null ? `comment on ${d.contentId}` : `reply to comment ${d.parentId}`} waits for the server's moderators: ${d.commentId}`
            : `${d.parentId === null ? `Commented on ${d.contentId}` : `Replied to comment ${d.parentId}`}${
                d.media ? ` with ${d.media.kind === 'image' ? 'an image' : 'a video'}` : ''
              }: ${d.commentId}`,
      };
    },
  },
  endpoint<{ contentId: string; commentId: string; unchanged?: boolean; status?: string }>({
    name: 'comments edit',
    positionals: ['contentId', 'commentId', 'text'],
    options: { ai: { type: 'boolean' }, 'no-ai': { type: 'boolean' } },
    flags: '[--ai | --no-ai]',
    role: 'anyone',
    summary:
      "Gives a comment of yours another text; quote it. With --ai, you say that the comment was created with AI, and with --no-ai, that it wasn't; with neither, it says what it said. The comment keeps its replies and its likes. An edit the server holds back takes the comment off the post until its moderators accept it; its replies stay.",
    request: ({ positionals: [contentId, commentId, text], values }) => {
      if (values.ai === true && values['no-ai'] === true) throw new CliError("say one of the two: --ai if the comment was created with AI, --no-ai if it wasn't", 2);
      const declared = values.ai === true ? { aiGenerated: true } : values['no-ai'] === true ? { aiGenerated: false } : {};
      return { method: 'PATCH', path: path`/content/${contentId!}/comments/${commentId!}`, body: { text, ...declared } };
    },
    text: (d) =>
      d.unchanged
        ? `Comment ${d.commentId} already says that.`
        : d.status === 'pending_review'
          ? `Edited comment ${d.commentId}: it waits for the server's moderators, and is off the post until they accept it.`
          : `Edited comment ${d.commentId}.`,
  }),
  endpoint<{ contentId: string; commentId: string; likes: number; alreadyLiked: boolean }>({
    name: 'comments like',
    positionals: ['contentId', 'commentId'],
    role: 'anyone',
    summary: 'Likes a comment. You like a comment once, until you take the like back with comments unlike.',
    request: ({ positionals: [contentId, commentId] }) => ({ method: 'POST', path: '/like', body: { contentId, commentId } }),
    text: (d) => `${d.alreadyLiked ? `You had already liked comment ${d.commentId}` : `Liked comment ${d.commentId}`}: it has ${counted(d.likes, 'like', 'likes')}.`,
  }),
  endpoint<{ contentId: string; commentId: string; likes: number; wasLiked: boolean }>({
    name: 'comments unlike',
    positionals: ['contentId', 'commentId'],
    role: 'anyone',
    summary: 'Takes back your like of a comment. You can like the comment again afterwards.',
    request: ({ positionals: [contentId, commentId] }) => ({ method: 'DELETE', path: '/like', body: { contentId, commentId } }),
    text: (d) => `${d.wasLiked ? `Took back your like of comment ${d.commentId}` : `You hadn't liked comment ${d.commentId}`}: it has ${counted(d.likes, 'like', 'likes')}.`,
  }),
  endpoint<{ contentId: string; commentId: string }>({
    name: 'comments delete',
    positionals: ['contentId', 'commentId'],
    role: 'anyone',
    summary: 'Deletes a comment: your own, one on your post, or any comment if you are an admin. The replies to it stay.',
    request: ({ positionals: [contentId, commentId] }) => ({ method: 'DELETE', path: path`/content/${contentId!}/comments/${commentId!}` }),
    text: (d) => `Deleted comment ${d.commentId}.`,
  }),
  endpoint<{ tag: string; moderators: { userId: string; username: string; since: string }[]; claim?: ClaimRecord }>({
    name: 'moderators list',
    positionals: ['tag'],
    role: 'anyone',
    summary: "Lists a hashtag's moderators, and the claim to it that waits, if there is one.",
    request: ({ positionals: [tag] }) => ({ method: 'GET', path: path`/tags/${tag!}/moderators` }),
    text: (d) =>
      (d.moderators.length ? table(d.moderators.map((m) => [m.userId, m.username, `since ${m.since}`])) : `#${d.tag} has no moderators.`) +
      (d.claim ? `\n${d.claim.username} (${d.claim.userId}) claimed it, and becomes its moderator at ${d.claim.reviewUntil} unless the claim is refused.` : ''),
  }),
  endpoint<ClaimRecord & { alreadyClaimed: boolean }>({
    name: 'claims add',
    positionals: ['tag'],
    role: 'anyone',
    summary:
      'Claims a hashtag that has no moderator, to moderate it. The admins and server moderators are told, and can refuse the claim while it waits; if none does, you become its moderator. Only where publishers choose the hashtags of their posts.',
    request: ({ positionals: [tag] }) => ({ method: 'POST', path: path`/tags/${tag!}/claim` }),
    text: (d) =>
      `${d.alreadyClaimed ? `You had already claimed #${d.tag}` : `You claimed #${d.tag}`}: you become its moderator at ${d.reviewUntil}, unless an admin or a server moderator refuses the claim before then.`,
  }),
  endpoint<ClaimEnded>({
    name: 'claims withdraw',
    positionals: ['tag'],
    role: 'anyone',
    summary: 'Withdraws your claim to a hashtag.',
    request: ({ positionals: [tag] }) => ({ method: 'DELETE', path: path`/tags/${tag!}/claim` }),
    text: (d) => (d.wasClaimed ? `Withdrew your claim to #${d.tag}.` : `Nobody's claim to #${d.tag} is waiting.`),
  }),
  endpoint<{ tag: string; rules: RuleRecord[] }>({
    name: 'tag-rules list',
    positionals: ['tag'],
    role: 'anyone',
    summary: "Lists a hashtag's rules, in their order: what its moderators ask of the posts under it.",
    request: ({ positionals: [tag] }) => ({ method: 'GET', path: path`/tags/${tag!}/rules` }),
    text: (d) => (d.rules.length ? table(d.rules.map((r) => [String(r.position), r.ruleId, r.text.replace(/\s+/g, ' ').trim()])) : `#${d.tag} has no rules.`),
  }),
  endpoint<{ modificationDisclosure: ModificationDisclosure; supportEmail: string; rules: RuleRecord[] }>({
    name: 'rules list',
    role: 'anyone',
    summary:
      "Lists the server's rules, in their order, the email address to write to for support, and its modification disclosure: whether it runs a release of Evieverse or a modified version, which release, and where its source code is.",
    request: () => ({ method: 'GET', path: '/rules' }),
    text: (d) =>
      [
        d.rules.length ? table(d.rules.map((r) => [String(r.position), r.ruleId, r.text.replace(/\s+/g, ' ').trim()])) : 'The server has no rules.',
        '',
        `Support: ${d.supportEmail}`,
        '',
        [
          d.modificationDisclosure.modified
            ? `Modification disclosure: this server runs a modified version of Evieverse, based on release ${d.modificationDisclosure.release}.`
            : `Modification disclosure: this server runs Evieverse ${d.modificationDisclosure.release}, unmodified.`,
          ...(d.modificationDisclosure.sourceUrl ? [`Its source code: ${d.modificationDisclosure.sourceUrl}`] : []),
        ].join('\n'),
      ].join('\n'),
  }),
  own<{ unread: number; inbox: InboxItem[]; nextCursor: string | null }>({
    name: 'inbox list',
    options: { ...PAGE_OPTIONS, unread: { type: 'boolean' } },
    flags: `[--unread] ${PAGE_FLAGS}`,
    role: 'anyone',
    summary: 'Lists your inbox, newest first: the messages users sent you, and the notices of what moderators did to your posts and of your mutes. With --unread, only what you have not read.',
    request: (args, me) => ({
      method: 'GET',
      path: `${path`/users/${me}/inbox`}${pageQuery(args, new URLSearchParams(args.values.unread === true ? { unread: 'true' } : {}))}`,
    }),
    text: (d, { values }) =>
      (d.inbox.length ? table(d.inbox.map(inboxRow)) : values.unread === true ? 'Nothing in your inbox is unread.' : 'Your inbox is empty.') + more(d.nextCursor),
  }),
  own<{ read: number; unread: number }>({
    name: 'inbox read',
    options: { message: { type: 'string' } },
    flags: '[--message <messageId>]',
    role: 'anyone',
    summary: 'Marks everything in your inbox as read, or with --message, one message or notice.',
    request: ({ values }, me) => ({
      method: 'POST',
      path: path`/users/${me}/inbox/read`,
      ...(typeof values.message === 'string' && { body: { messageIds: [values.message] } }),
    }),
    text: (d) => `Marked ${d.read} as read: ${d.unread} ${d.unread === 1 ? 'is' : 'are'} left unread.`,
  }),
  own<{ messageId: string; wasThere: boolean }>({
    name: 'inbox delete',
    positionals: ['messageId'],
    role: 'anyone',
    summary: 'Deletes a message or a notice from your inbox.',
    request: ({ positionals: [messageId] }, me) => ({ method: 'DELETE', path: path`/users/${me}/inbox/${messageId!}` }),
    text: (d) => (d.wasThere ? `Deleted ${d.messageId} from your inbox.` : `${d.messageId} isn't in your inbox.`),
  }),
  endpoint<{ messageId: string; to: { userId: string; username: string } }>({
    name: 'messages send',
    positionals: ['userId', 'text'],
    role: 'anyone',
    summary: 'Sends a user a message, which lands in their inbox; quote the text. Refused if either of you turned messages off or blocked the other.',
    request: ({ positionals: [to, text] }) => ({ method: 'POST', path: '/messages', body: { to, text } }),
    text: (d) => `Sent to ${d.to.username} (${d.to.userId}).`,
  }),
  messages('on'),
  messages('off'),
  own<{ blocked: { userId: string; username: string; blockedAt: string }[]; nextCursor: string | null }>({
    name: 'blocks list',
    options: PAGE_OPTIONS,
    flags: PAGE_FLAGS,
    role: 'anyone',
    summary: 'Lists the users you block, most recently blocked first.',
    request: (args, me) => ({ method: 'GET', path: `${path`/users/${me}/blocked`}${pageQuery(args)}` }),
    text: (d) => (d.blocked.length ? table(d.blocked.map((b) => [b.userId, b.username, `blocked ${b.blockedAt}`])) : 'You block nobody.') + more(d.nextCursor),
  }),
  own<{ blockedId: string; alreadyBlocked: boolean }>({
    name: 'blocks add',
    positionals: ['userId'],
    role: 'anyone',
    summary: "Blocks a user: no message goes between the two of you, neither follows the other, they can't comment on your posts, and what they wrote is left out of what you're listed.",
    request: ({ positionals: [userId] }, me) => ({ method: 'PUT', path: path`/users/${me}/blocked/${userId!}` }),
    text: (d) =>
      d.alreadyBlocked ? `You already blocked ${d.blockedId}.` : `You block ${d.blockedId}: no message goes between the two of you, neither follows the other, and they can't comment on your posts.`,
  }),
  own<{ blockedId: string; wasBlocked: boolean }>({
    name: 'blocks remove',
    positionals: ['userId'],
    role: 'anyone',
    summary: 'Unblocks a user.',
    request: ({ positionals: [userId] }, me) => ({ method: 'DELETE', path: path`/users/${me}/blocked/${userId!}` }),
    text: (d) => (d.wasBlocked ? `You no longer block ${d.blockedId}.` : `You didn't block ${d.blockedId}.`),
  }),

  words('list', 'GET', "Lists a hashtag's blocked words, or with --server the server's (admins)."),
  words('add', 'POST', "Blocks words, phrases or patterns; quote a phrase, and a pattern, which is a regular expression between slashes ('/spam+/'). Prints the list as it is then."),
  words('remove', 'DELETE', 'Unblocks words, phrases or patterns. Prints the list as it is then.'),
  endpoint<{ tag: string; muted: { userId: string; username: string; mutedAt: string }[]; nextCursor: string | null }>({
    name: 'mute list',
    positionals: ['tag'],
    options: PAGE_OPTIONS,
    flags: PAGE_FLAGS,
    role: 'moderator',
    summary: 'Lists the users muted on a hashtag, most recently muted first.',
    request: (args) => ({ method: 'GET', path: `${path`/tags/${args.positionals[0]!}/muted`}${pageQuery(args)}` }),
    text: (d) => (d.muted.length ? table(d.muted.map((m) => [m.userId, m.username, `muted ${m.mutedAt}`])) : `Nobody is muted on #${d.tag}.`) + more(d.nextCursor),
  }),
  endpoint<{ tag: string; userId: string; alreadyMuted: boolean }>({
    name: 'mute add',
    positionals: ['tag', 'userId'],
    role: 'moderator',
    summary: "Mutes a user on a hashtag: their new posts and updates don't get it.",
    request: ({ positionals: [tag, userId] }) => ({ method: 'PUT', path: path`/tags/${tag!}/muted/${userId!}` }),
    text: (d) => (d.alreadyMuted ? `${d.userId} was already muted on #${d.tag}.` : `${d.userId} is muted on #${d.tag}.`),
  }),
  endpoint<{ tag: string; userId: string; wasMuted: boolean }>({
    name: 'mute remove',
    positionals: ['tag', 'userId'],
    role: 'moderator',
    summary: 'Unmutes a user on a hashtag.',
    request: ({ positionals: [tag, userId] }) => ({ method: 'DELETE', path: path`/tags/${tag!}/muted/${userId!}` }),
    text: (d) => (d.wasMuted ? `${d.userId} is no longer muted on #${d.tag}.` : `${d.userId} wasn't muted on #${d.tag}.`),
  }),
  endpoint<{ nextCursor: string | null; tags: Record<string, PostRecord[]> }>({
    name: 'tag queue',
    positionals: ['tag'],
    options: PAGE_OPTIONS,
    flags: PAGE_FLAGS,
    role: 'moderator',
    summary: "Lists a hashtag's moderation queue: the posts under it that no moderator has approved, or removed it from, yet.",
    // The queue is the hashtag's feed, without the posts a moderator approved. A feed is of its window alone,
    // so the queue asks for the widest one (90 days): everything under the hashtag, not the last day's posts.
    request: (args) => ({
      method: 'GET',
      path: `/feed${pageQuery(args, new URLSearchParams({ tags: args.positionals[0]!, moderated: 'false', hours: '2160' }))}`,
    }),
    text: (d, { positionals: [tag] }) => {
      const posts = Object.values(d.tags).flat();
      return (posts.length ? table(posts.map((p) => [p.contentId, p.publisher.username, p.createdAt, snippet(p)])) : `Nothing under #${tag!.replace(/^#/, '')} waits for a moderator.`) + more(d.nextCursor);
    },
  }),
  endpoint<{ contentId: string; tag: string; alreadyApproved: boolean }>({
    name: 'tag approve',
    positionals: ['contentId', 'tag'],
    role: 'moderator',
    summary: "Approves content under a hashtag, which takes it out of the hashtag's moderation queue until it is updated.",
    request: ({ positionals: [contentId, tag] }) => ({ method: 'PUT', path: path`/content/${contentId!}/tags/${tag!}` }),
    text: (d) => (d.alreadyApproved ? `${d.contentId} was already approved under #${d.tag}.` : `Approved ${d.contentId} under #${d.tag}.`),
  }),
  endpoint<{ contentId: string; tag: string; tags: string[]; muted: boolean }>({
    name: 'tag remove',
    positionals: ['contentId', 'tag'],
    options: { mute: { type: 'boolean' }, reason: { type: 'string' } },
    flags: '[--mute] [--reason <text>]',
    role: 'moderator',
    summary:
      "Removes a hashtag from content, for good: updates don't get it back. With --mute, also mutes its publisher on the hashtag. With --reason, why, which the post says to whoever reads it; quote it.",
    request: ({ positionals: [contentId, tag], values }) => {
      const body = { ...(values.mute === true && { mute: true }), ...(typeof values.reason === 'string' && { reason: values.reason }) };
      return { method: 'DELETE', path: path`/content/${contentId!}/tags/${tag!}`, ...(Object.keys(body).length > 0 && { body }) };
    },
    text: (d) =>
      (d.tags.length
        ? `Removed #${d.tag} from ${d.contentId}: it's now under ${hashtags(d.tags)}.`
        : `Removed #${d.tag} from ${d.contentId}: it was its last hashtag, so the content is in no hashtag's feed any more.`) + (d.muted ? `\nIts publisher is muted on #${d.tag}.` : ''),
  }),
  endpoint<RuleRecord & { tag: string }>({
    name: 'tag-rules add',
    positionals: ['tag', 'text'],
    options: { position: { type: 'string' } },
    flags: '[--position <n>]',
    role: 'moderator',
    summary: "Adds a rule to a hashtag's rules; quote it. It goes at the end of the list, or with --position, at that place, counted from 1.",
    request: (args) => ({ method: 'POST', path: path`/tags/${args.positionals[0]!}/rules`, body: ruleBody(args, args.positionals[1]) }),
    text: (d) => `Added rule ${d.position} of #${d.tag}: ${d.ruleId}`,
  }),
  endpoint<RuleRecord & { tag: string }>({
    name: 'tag-rules update',
    positionals: ['tag', 'ruleId'],
    options: { text: { type: 'string' }, position: { type: 'string' } },
    flags: '[--text <text>] [--position <n>]',
    role: 'moderator',
    summary: "Changes one of a hashtag's rules: with --text, what it says, and with --position, its place in the list, counted from 1.",
    request: (args) => {
      const { text } = args.values;
      const body = ruleBody(args, typeof text === 'string' ? text : undefined);
      if (!Object.keys(body).length) throw new CliError('say what to change: --text <text>, --position <n>, or both', 2);
      return { method: 'PATCH', path: path`/tags/${args.positionals[0]!}/rules/${args.positionals[1]!}`, body };
    },
    text: (d) => `Updated rule ${d.ruleId}: it is rule ${d.position} of #${d.tag}.`,
  }),
  endpoint<{ tag: string; ruleId: string; wasThere: boolean }>({
    name: 'tag-rules remove',
    positionals: ['tag', 'ruleId'],
    role: 'moderator',
    summary: "Removes one of a hashtag's rules.",
    request: ({ positionals: [tag, ruleId] }) => ({ method: 'DELETE', path: path`/tags/${tag!}/rules/${ruleId!}` }),
    text: (d) => (d.wasThere ? `Removed rule ${d.ruleId} of #${d.tag}.` : `${d.ruleId} isn't one of the rules of #${d.tag}.`),
  }),

  {
    name: 'register',
    positionals: ['username'],
    options: { language: { type: 'string' } },
    flags: '[--language <code>]',
    role: 'admin',
    summary:
      'Registers a user, and prints their userId and their API key, which is shown this once. With --language, the language the server answers them in, instead of yours.',
    async run(ctx, { positionals: [username], values }) {
      const user = await (await ctx.api())
        .request<{ userId: string; username: string; apiKey: string }>('POST', '/register', { username, ...(typeof values.language === 'string' && { language: values.language }) })
        .catch((err: unknown) => {
          // The server asks anyone but an admin to solve a challenge first, whose image takes a client to show.
          if (err instanceof ApiError && err.status === 428) {
            throw new CliError('only an admin registers a user with the CLI: the server asks anyone else to solve a challenge, which takes a client that shows its image');
          }
          throw err;
        });
      return { data: user, text: `Registered ${user.username} (${user.userId}).\nTheir API key, shown this once: ${user.apiKey}` };
    },
  },
  endpoint<{ admins: { userId: string; username: string }[] }>({
    name: 'admins list',
    role: 'admin',
    summary: "Lists the server's admins.",
    request: () => ({ method: 'GET', path: '/admins' }),
    text: (d) => table(d.admins.map((a) => [a.userId, a.username])),
  }),
  endpoint<AccountDeleted>({
    name: 'users delete',
    positionals: ['userId'],
    options: { yes: { type: 'boolean' } },
    flags: '--yes',
    role: 'admin',
    summary:
      "Deletes any user's account, for good: their key stops working and their posts are deleted. Their comments stay, without their name. Not the only admin's account. Needs --yes.",
    request: (args) => {
      confirmed(args, 'deleting an account');
      return { method: 'DELETE', path: path`/users/${args.positionals[0]!}` };
    },
    text: (d) => deletedText(d),
  }),
  {
    name: 'users rotate-key',
    positionals: ['userId'],
    role: 'admin',
    summary:
      "Replaces any user's API key with a new one, and prints it, which is shown this once, for you to pass on: for a user who lost their key, or whose key someone else has. Every key they had stops working. Another admin's too; your own is `key rotate`.",
    async run(ctx, { positionals: [userId] }) {
      // The server would replace the key the profile holds, and this command saves the new one nowhere.
      if (userId!.toLowerCase() === (await ctx.profile()).profile.userId.toLowerCase()) {
        throw new CliError('that is your own account: replace its key with `evieverse key rotate`, which saves the new one in the profile', 2);
      }
      const replaced = await (await ctx.api()).request<{ userId: string; apiKey: string }>('POST', path`/users/${userId!}/key`);
      return { data: replaced, text: `Replaced the API key of ${replaced.userId}: the keys they had no longer work.\nTheir new API key, shown this once: ${replaced.apiKey}` };
    },
  },
  endpoint<{ userId: string; username: string; alreadyAdmin: boolean }>({
    name: 'admins grant',
    positionals: ['userId'],
    role: 'admin',
    summary: 'Makes a user an admin.',
    request: ({ positionals: [userId] }) => ({ method: 'PUT', path: path`/admins/${userId!}` }),
    text: (d) => (d.alreadyAdmin ? `${d.username} (${d.userId}) was already an admin.` : `${d.username} (${d.userId}) is now an admin.`),
  }),
  endpoint<{ userId: string; wasAdmin: boolean }>({
    name: 'admins revoke',
    positionals: ['userId'],
    role: 'admin',
    summary: "Revokes a user's admin role: anyone's but the last admin's.",
    request: ({ positionals: [userId] }) => ({ method: 'DELETE', path: path`/admins/${userId!}` }),
    text: (d) => (d.wasAdmin ? `${d.userId} is no longer an admin.` : `${d.userId} wasn't an admin.`),
  }),
  endpoint<{ moderators: { userId: string; username: string }[] }>({
    name: 'server-moderators list',
    role: 'admin',
    summary: "Lists the server's moderators.",
    request: () => ({ method: 'GET', path: '/moderators' }),
    text: (d) => (d.moderators.length ? table(d.moderators.map((m) => [m.userId, m.username])) : 'The server has no moderators.'),
  }),
  endpoint<{ userId: string; username: string; alreadyModerator: boolean }>({
    name: 'server-moderators add',
    positionals: ['userId'],
    role: 'admin',
    summary: 'Makes a user a server moderator: they can work through the moderation queue and the report queue, and moderate every hashtag.',
    request: ({ positionals: [userId] }) => ({ method: 'PUT', path: path`/moderators/${userId!}` }),
    text: (d) => (d.alreadyModerator ? `${d.username} (${d.userId}) was already a server moderator.` : `${d.username} (${d.userId}) is now a server moderator.`),
  }),
  endpoint<{ userId: string; wasModerator: boolean }>({
    name: 'server-moderators remove',
    positionals: ['userId'],
    role: 'admin',
    summary: "Ends a user's time as a server moderator.",
    request: ({ positionals: [userId] }) => ({ method: 'DELETE', path: path`/moderators/${userId!}` }),
    text: (d) => (d.wasModerator ? `${d.userId} is no longer a server moderator.` : `${d.userId} wasn't a server moderator.`),
  }),
  endpoint<{ tag: string; userId: string; alreadyModerator: boolean }>({
    name: 'moderators add',
    positionals: ['tag', 'userId'],
    role: 'admin',
    summary: 'Makes a user a moderator of a hashtag.',
    request: ({ positionals: [tag, userId] }) => ({ method: 'PUT', path: path`/tags/${tag!}/moderators/${userId!}` }),
    text: (d) => (d.alreadyModerator ? `${d.userId} already moderated #${d.tag}.` : `${d.userId} now moderates #${d.tag}.`),
  }),
  endpoint<{ tag: string; userId: string; wasModerator: boolean }>({
    name: 'moderators remove',
    positionals: ['tag', 'userId'],
    role: 'admin',
    summary: "Ends a user's moderation of a hashtag.",
    request: ({ positionals: [tag, userId] }) => ({ method: 'DELETE', path: path`/tags/${tag!}/moderators/${userId!}` }),
    text: (d) => (d.wasModerator ? `${d.userId} no longer moderates #${d.tag}.` : `${d.userId} didn't moderate #${d.tag}.`),
  }),
  endpoint<RuleRecord>({
    name: 'rules add',
    positionals: ['text'],
    options: { position: { type: 'string' } },
    flags: '[--position <n>]',
    role: 'admin',
    summary: "Adds a rule to the server's rules; quote it. It goes at the end of the list, or with --position, at that place, counted from 1.",
    request: (args) => ({ method: 'POST', path: '/rules', body: ruleBody(args, args.positionals[0]) }),
    text: (d) => `Added rule ${d.position}: ${d.ruleId}`,
  }),
  endpoint<RuleRecord>({
    name: 'rules update',
    positionals: ['ruleId'],
    options: { text: { type: 'string' }, position: { type: 'string' } },
    flags: '[--text <text>] [--position <n>]',
    role: 'admin',
    summary: "Changes one of the server's rules: with --text, what it says, and with --position, its place in the list, counted from 1.",
    request: (args) => {
      const { text } = args.values;
      const body = ruleBody(args, typeof text === 'string' ? text : undefined);
      if (!Object.keys(body).length) throw new CliError('say what to change: --text <text>, --position <n>, or both', 2);
      return { method: 'PATCH', path: path`/rules/${args.positionals[0]!}`, body };
    },
    text: (d) => `Updated rule ${d.ruleId}: it is rule ${d.position}.`,
  }),
  endpoint<{ ruleId: string; wasThere: boolean }>({
    name: 'rules remove',
    positionals: ['ruleId'],
    role: 'admin',
    summary: "Removes one of the server's rules.",
    request: ({ positionals: [ruleId] }) => ({ method: 'DELETE', path: path`/rules/${ruleId!}` }),
    text: (d) => (d.wasThere ? `Removed rule ${d.ruleId}.` : `${d.ruleId} isn't one of the server's rules.`),
  }),
  endpoint<{ claims: ClaimRecord[]; nextCursor: string | null }>({
    name: 'claims list',
    options: PAGE_OPTIONS,
    flags: PAGE_FLAGS,
    role: 'serverModerator',
    summary: 'Lists the claims to hashtags that wait, longest waiting first: who claims each, and when they become its moderator unless the claim is refused.',
    request: (args) => ({ method: 'GET', path: `/moderation/tag-claims${pageQuery(args)}` }),
    text: (d) =>
      (d.claims.length ? table(d.claims.map((c) => [`#${c.tag}`, c.userId, c.username, `claimed ${c.claimedAt}`, `granted ${c.reviewUntil}`])) : 'No claim to a hashtag is waiting.') +
      more(d.nextCursor),
  }),
  endpoint<ClaimEnded>({
    name: 'claims refuse',
    positionals: ['tag'],
    role: 'serverModerator',
    summary: "Refuses the claim to a hashtag that waits: its user doesn't become the hashtag's moderator, and is told.",
    request: ({ positionals: [tag] }) => ({ method: 'DELETE', path: path`/tags/${tag!}/claim` }),
    text: (d) => (d.wasClaimed ? `Refused the claim of ${d.userId} to #${d.tag}.` : `Nobody's claim to #${d.tag} is waiting.`),
  }),
  endpoint<{ banned: { userId: string; username: string; bannedAt: string; reason: string | null; bannedBy: { userId: string; username: string } | null }[]; nextCursor: string | null }>({
    name: 'bans list',
    options: PAGE_OPTIONS,
    flags: PAGE_FLAGS,
    role: 'serverModerator',
    summary: 'Lists the banned users, most recently banned first: who banned each, when, and why.',
    request: (args) => ({ method: 'GET', path: `/banned${pageQuery(args)}` }),
    text: (d) =>
      (d.banned.length
        ? table(d.banned.map((b) => [b.userId, b.username, `since ${b.bannedAt}`, `by ${b.bannedBy?.username ?? '(an account that is gone)'}`, (b.reason ?? '(no reason given)').replace(/\s+/g, ' ')]))
        : 'Nobody is banned.') + more(d.nextCursor),
  }),
  endpoint<{ userId: string; username: string; alreadyBanned: boolean }>({
    name: 'bans add',
    positionals: ['userId'],
    options: { reason: { type: 'string' } },
    flags: '[--reason <text>]',
    role: 'serverModerator',
    summary:
      "Bans a user: they can't post, comment, like or send messages, and can still read. They are told. Not an admin or a server moderator. With --reason, what moderators can read of why.",
    request: ({ positionals: [userId], values }) => ({
      method: 'PUT',
      path: path`/banned/${userId!}`,
      ...(typeof values.reason === 'string' && { body: { reason: values.reason } }),
    }),
    text: (d) => (d.alreadyBanned ? `${d.username} (${d.userId}) was already banned.` : `${d.username} (${d.userId}) is banned: they can't post, comment, like or send messages.`),
  }),
  endpoint<{ userId: string; wasBanned: boolean }>({
    name: 'bans remove',
    positionals: ['userId'],
    role: 'serverModerator',
    summary: 'Ends a ban. The user is told.',
    request: ({ positionals: [userId] }) => ({ method: 'DELETE', path: path`/banned/${userId!}` }),
    text: (d) => (d.wasBanned ? `${d.userId} is no longer banned.` : `${d.userId} wasn't banned.`),
  }),
  endpoint<{ contentId: string; userId: string; status: 'removed' | 'pending_deletion'; tags?: string[] }>({
    name: 'reposts remove',
    positionals: ['contentId', 'userId'],
    role: 'serverModerator',
    summary:
      "Removes a user's repost of a post from this server: the post leaves the reposter's own feed, and loses the hashtags the repost gave it. The post itself stays. Of a post on another server, the first repost is this server's entry for it, which is deleted. The user is told, and can repost again: ban them to stop that.",
    request: ({ positionals: [contentId, userId] }) => ({ method: 'DELETE', path: path`/content/${contentId!}/reposts/${userId!}` }),
    text: (d) =>
      d.status === 'pending_deletion'
        ? `Removed the repost of ${d.userId}: ${d.contentId} was this server's entry for a post on another server, and is set for deletion.`
        : `Removed the repost of ${d.contentId} by ${d.userId}${d.tags?.length ? `: it loses ${hashtags(d.tags)}` : ''}.`,
  }),
  endpoint<{ queue: (QueueItem & { trustScore: number; queuedAt: string })[]; nextCursor: string | null }>({
    name: 'queue list',
    options: PAGE_OPTIONS,
    flags: PAGE_FLAGS,
    role: 'serverModerator',
    summary: 'Lists the moderation queue: the posts and the comments whose trust score held them back, longest waiting first.',
    request: (args) => ({ method: 'GET', path: `/moderation/queue${pageQuery(args)}` }),
    text: (d) =>
      (d.queue.length ? table(d.queue.map((item) => queueRow(item, [`score ${item.trustScore}`, `since ${item.queuedAt}`]))) : 'The moderation queue is empty.') +
      more(d.nextCursor),
  }),
  endpoint<{ contentId: string; commentId?: string; tags?: string[] }>({
    name: 'queue accept',
    positionals: ['contentId'],
    options: COMMENT_OPTION,
    flags: COMMENT_FLAG,
    role: 'serverModerator',
    summary: 'Accepts a post from the moderation queue, or with --comment, a comment on it: it is published.',
    request: (args) => ({ method: 'POST', path: queuePath('queue', args, 'accept') }),
    text: (d) =>
      d.commentId === undefined
        ? `Accepted ${d.contentId}: it's published under ${hashtags(d.tags ?? [])}.`
        : `Accepted comment ${d.commentId}: it's published on ${d.contentId}.`,
  }),
  endpoint<{ contentId: string; commentId?: string }>({
    name: 'queue reject',
    positionals: ['contentId'],
    options: COMMENT_OPTION,
    flags: COMMENT_FLAG,
    role: 'serverModerator',
    summary: 'Rejects a post in the moderation queue, or with --comment, a comment on it: it is deleted.',
    request: (args) => ({ method: 'POST', path: queuePath('queue', args, 'reject') }),
    text: (d) => (d.commentId === undefined ? `Rejected ${d.contentId}: it is set for deletion.` : `Rejected comment ${d.commentId}: it is deleted.`),
  }),
  endpoint<{ queue: (QueueItem & { reports: number; reportedAt: string })[]; nextCursor: string | null }>({
    name: 'reports list',
    options: PAGE_OPTIONS,
    flags: PAGE_FLAGS,
    role: 'serverModerator',
    summary: 'Lists the report queue: the posts and the comments users reported that nobody has decided on, longest reported first.',
    request: (args) => ({ method: 'GET', path: `/moderation/reports${pageQuery(args)}` }),
    text: (d) =>
      (d.queue.length ? table(d.queue.map((item) => queueRow(item, [reportCount(item.reports), `since ${item.reportedAt}`]))) : 'The report queue is empty.') +
      more(d.nextCursor),
  }),
  endpoint<{ contentId: string; commentId?: string; reports: { userId: string; username: string; reason?: string; reportedAt: string }[]; nextCursor: string | null }>({
    name: 'reports show',
    positionals: ['contentId'],
    options: { ...COMMENT_OPTION, ...PAGE_OPTIONS },
    flags: `${COMMENT_FLAG} ${PAGE_FLAGS}`,
    role: 'serverModerator',
    summary: "Lists a post's reports that nobody has decided on, or with --comment, a comment's, most recent first: who made each, when, and the reason they gave.",
    request: (args) => ({ method: 'GET', path: `${queuePath('reports', args)}${pageQuery(args)}` }),
    text: (d) =>
      (d.reports.length
        ? table(d.reports.map((r) => [r.userId, r.username, r.reportedAt, (r.reason ?? '(no reason given)').replace(/\s+/g, ' ')]))
        : `${d.commentId === undefined ? d.contentId : `Comment ${d.commentId}`} has no reports waiting for a decision.`) + more(d.nextCursor),
  }),
  endpoint<{ contentId: string; commentId?: string; reports: number }>({
    name: 'reports accept',
    positionals: ['contentId'],
    options: COMMENT_OPTION,
    flags: COMMENT_FLAG,
    role: 'serverModerator',
    summary: 'Accepts a reported post, or with --comment, a reported comment on it: it stays as it is, and leaves the report queue.',
    request: (args) => ({ method: 'POST', path: queuePath('reports', args, 'accept') }),
    text: (d) =>
      `Accepted ${d.commentId === undefined ? d.contentId : `comment ${d.commentId}`}: it stays, and ${reportCount(d.reports)} of it ${d.reports === 1 ? 'is' : 'are'} settled.`,
  }),
  endpoint<{ contentId: string; commentId?: string }>({
    name: 'reports delete',
    positionals: ['contentId'],
    options: COMMENT_OPTION,
    flags: COMMENT_FLAG,
    role: 'serverModerator',
    summary: 'Deletes a reported post, or with --comment, a reported comment on it.',
    request: (args) => ({ method: 'POST', path: queuePath('reports', args, 'delete') }),
    text: (d) => (d.commentId === undefined ? `Deleted ${d.contentId}: it is set for deletion.` : `Deleted comment ${d.commentId}.`),
  }),
];

/** A command's arguments, as its usage line shows them. */
export const usage = (c: Command) =>
  [c.name, ...(c.positionals ?? []).map((p) => `<${p}>`), c.flags, c.rest && `<${c.rest}>...`].filter(Boolean).join(' ');

/**
 * Every command, by who it is for. With a profile whose server answers, the ones its key may use are
 * marked, from the roles /whoami gives; the server still decides each request.
 */
export async function helpText(ctx: Context): Promise<string> {
  let who: { name: string; server: string; me: WhoAmI } | undefined;
  try {
    const { name } = await ctx.profile();
    const api = await ctx.api();
    // `help` waits 5 seconds for the server to say what the key may do, before it shows the commands unmarked.
    who = { name, server: api.server, me: await api.request<WhoAmI>('GET', '/whoami', undefined, 5000) };
  } catch {
    // No profile, or no answer: the commands are shown all the same.
  }
  const me = who?.me;
  const width = Math.max(...COMMANDS.map((c) => usage(c).length));

  const lines = [
    `evieverse ${VERSION} (build ${BUILD})`,
    "Manages an Evieverse server with your account's API key. The server decides what a key may do.",
    '',
    'Usage: evieverse [--profile <name>] [--json] <command>',
    '',
  ];
  if (who && me) lines.push(`Profile "${who.name}": ${me.username} on ${who.server}, ${roles(me)}`, '  + your key may use it    - it may not', '');
  for (const { role, title } of SECTIONS) {
    lines.push(title(me));
    for (const c of COMMANDS.filter((command) => command.role === role)) {
      lines.push(
        `  ${
          // A server moderator may use a hashtag's moderator's commands too, on every hashtag.
          me ? (role === 'anyone' || me.admin || (role === 'moderator' && (me.moderator || me.moderates.length > 0)) || (role === 'serverModerator' && me.moderator) ? '+ ' : '- ') : ''
        }${usage(c).padEnd(width)}  ${c.summary}`,
      );
    }
    lines.push('');
  }
  lines.push(
    'Options',
    '  --profile <name>  The profile to use, if there are several (or set EVIEVERSE_PROFILE); the name `login` saves under.',
    '  --json            Prints the server\'s answer as JSON.',
    '',
    'Users are named by their userId, and hashtags without the #.',
  );
  return lines.join('\n');
}
