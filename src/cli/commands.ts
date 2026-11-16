import { ApiError, apiClient, BUILD, CliError, serverUrl, VERSION, type Api } from './client.js';
import { DEFAULT_PROFILE, listProfiles, readProfile, removeProfile, writeProfile, type Profile } from './profiles.js';
import { installRelease, latestRelease } from './update.js';

/** What the CLI reaches the world through, so tests can stand in for it. */
export interface Io {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** A command's result, to stdout. */
  out(text: string): void;
  /** Errors and notices, to stderr. */
  err(text: string): void;
  /** Where profiles are kept: ~/.evieverse, or EVIEVERSE_HOME. */
  home: string;
  /** The CLI's own file, which an update replaces; null for a copy run from source. */
  selfPath: string | null;
  /** Asks for a secret without showing it. */
  readSecret(prompt: string): Promise<string>;
  /** Runs the CLI's file again with the same arguments, after an update replaced it; resolves with its exit code. */
  rerun(argv: string[]): Promise<number>;
}

export interface Context {
  io: Io;
  /** The profile named by --profile or EVIEVERSE_PROFILE. */
  profileName: string | undefined;
  /** The profile to use (see pickProfile). */
  profile(): Promise<{ name: string; profile: Profile }>;
  /** Requests to that profile's server, with its key. */
  api(): Promise<Api>;
}

/**
 * Who a command is for. The server decides, by the key, whether a request is allowed; this only sorts
 * the help, and marks there what the key in use may do. `moderator` is a hashtag's moderator, and
 * `serverModerator` the server's: one who works through its moderation queue and its report queue.
 */
type Role = 'anyone' | 'moderator' | 'serverModerator' | 'admin';

interface Args {
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
}

interface Result {
  /** What `--json` prints. */
  data: unknown;
  text: string;
}

export interface Command {
  /** One or two words: "whoami", "admins grant". */
  name: string;
  /** The arguments it takes, in order... */
  positionals?: string[];
  /** ...and then one or more of these. */
  rest?: string;
  options?: Record<string, { type: 'string' | 'boolean' }>;
  /** The options, as the usage line shows them. */
  flags?: string;
  role: Role;
  summary: string;
  run(ctx: Context, args: Args): Promise<Result>;
}

export interface WhoAmI {
  userId: string;
  username: string;
  admin: boolean;
  /** A server moderator. */
  moderator: boolean;
  /** The hashtags they moderate. */
  moderates: string[];
  /** Whether they take part in messages between users. */
  messages: boolean;
  /** Whether anyone can list whom they follow, and who follows them. */
  showFollowing: boolean;
  showFollowers: boolean;
  /** Whether a moderator banned them: they can't post, comment or send messages. */
  banned?: boolean;
}

interface Request {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/** A path with each value encoded as one segment. */
const path = (parts: TemplateStringsArray, ...values: string[]) => parts.reduce((out, part, i) => out + encodeURIComponent(values[i - 1]!) + part);

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
  return me.banned ? `${role}; banned, so you can't post, comment or send messages` : role;
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

/** A comment on a post, as the server gives it. */
interface CommentRecord {
  commentId: string;
  /** The post it is on. */
  contentId: string;
  author: { userId: string; username: string };
  text: string;
  createdAt: string;
  /** "pending_review" on one that waits in the moderation queue. */
  status?: string;
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
    ? ['comment', item.commentId, item.author.username, ...facts, `on ${item.contentId}`, oneLine(item.text)]
    : ['post', item.contentId, item.publisher.username, ...facts, hashtags(item.tags), snippet(item)];

/** The option that makes a command about a post one about a comment on it. */
const COMMENT_OPTION = { comment: { type: 'string' } } as const;
const COMMENT_FLAG = '[--comment <commentId>]';
const commentOf = ({ values }: Args) => (typeof values.comment === 'string' ? values.comment : undefined);

/** Where a queue's request about a post goes, or with --comment, the one about a comment on it. */
function queuePath(queue: 'queue' | 'reports', args: Args, decision?: string): string {
  const contentId = args.positionals[0]!;
  const commentId = commentOf(args);
  const about = commentId === undefined ? path`/moderation/${queue}/${contentId}` : path`/moderation/${queue}/${contentId}/comments/${commentId}`;
  return decision ? `${about}/${decision}` : about;
}

/** The options of a command that lists a page at a time, as the query of its request. */
const PAGE_OPTIONS = { limit: { type: 'string' }, cursor: { type: 'string' } } as const;
const PAGE_FLAGS = '[--limit <n>] [--cursor <cursor>]';
function pageQuery({ values }: Args, query = new URLSearchParams()): string {
  for (const name of ['limit', 'cursor']) if (typeof values[name] === 'string') query.set(name, values[name]);
  return query.size ? `?${query}` : '';
}
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

const deletedText = (d: AccountDeleted) =>
  d.status === 'deleted' ? `Deleted account ${d.userId}.` : `Deleted account ${d.userId}: its posts are being removed, and the account goes with the last of them.`;

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

/** What is in an inbox: a message a user sent, or a notice of the server's, which has no sender and may quote the post or the comment it is about. */
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
  const sender = m.kind !== 'message' ? 'the server' : m.from ? `${m.from.username} (${m.from.userId})` : '(an account that is gone)';
  // A notice about a comment (comment_accepted, comment_deleted, ...) quotes the comment.
  const said = m.excerpt ? `${m.text} The ${m.kind.startsWith('comment_') ? 'comment' : 'post'}: "${m.excerpt}"` : m.text;
  return [m.messageId, m.sentAt, m.readAt ? 'read' : 'new', sender, said.replace(/\s+/g, ' ').trim()];
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
      const names = await listProfiles(io.home);
      const found = await Promise.all(
        names.map(async (name) => {
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
  endpoint<{ contentId: string; count: number; comments: CommentRecord[]; nextCursor: string | null }>({
    name: 'comments list',
    positionals: ['contentId'],
    options: { ...PAGE_OPTIONS, newest: { type: 'boolean' } },
    flags: `[--newest] ${PAGE_FLAGS}`,
    role: 'anyone',
    summary: "Lists a post's comments, oldest first, or with --newest, newest first.",
    request: (args) => ({
      method: 'GET',
      path: `${path`/content/${args.positionals[0]!}/comments`}${pageQuery(args, new URLSearchParams(args.values.newest === true ? { order: 'newest' } : {}))}`,
    }),
    text: (d) =>
      (d.comments.length ? table(d.comments.map((c) => [c.commentId, c.author.username, c.createdAt, oneLine(c.text)])) : `${d.contentId} has no comments.`) +
      more(d.nextCursor),
  }),
  endpoint<CommentRecord>({
    name: 'comments add',
    positionals: ['contentId', 'text'],
    role: 'anyone',
    summary: "Comments on a post that takes comments; quote the text. One the server holds back waits for its moderators, as a post does.",
    request: ({ positionals: [contentId, text] }) => ({ method: 'POST', path: path`/content/${contentId!}/comments`, body: { text } }),
    text: (d) =>
      d.status === 'pending_review'
        ? `Your comment on ${d.contentId} waits for the server's moderators: ${d.commentId}`
        : `Commented on ${d.contentId}: ${d.commentId}`,
  }),
  endpoint<{ contentId: string; commentId: string }>({
    name: 'comments delete',
    positionals: ['contentId', 'commentId'],
    role: 'anyone',
    summary: 'Deletes a comment: your own, one on your post, or any comment if you are an admin.',
    request: ({ positionals: [contentId, commentId] }) => ({ method: 'DELETE', path: path`/content/${contentId!}/comments/${commentId!}` }),
    text: (d) => `Deleted comment ${d.commentId}.`,
  }),
  endpoint<{ tag: string; moderators: { userId: string; username: string; since: string }[] }>({
    name: 'moderators list',
    positionals: ['tag'],
    role: 'anyone',
    summary: "Lists a hashtag's moderators.",
    request: ({ positionals: [tag] }) => ({ method: 'GET', path: path`/tags/${tag!}/moderators` }),
    text: (d) => (d.moderators.length ? table(d.moderators.map((m) => [m.userId, m.username, `since ${m.since}`])) : `#${d.tag} has no moderators.`),
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
    summary: 'Blocks a user: no message goes between the two of you, either way.',
    request: ({ positionals: [userId] }, me) => ({ method: 'PUT', path: path`/users/${me}/blocked/${userId!}` }),
    text: (d) => (d.alreadyBlocked ? `You already blocked ${d.blockedId}.` : `You block ${d.blockedId}: no message goes between the two of you.`),
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
  words('add', 'POST', 'Blocks words or phrases; quote a phrase. Prints the list as it is then.'),
  words('remove', 'DELETE', 'Unblocks words or phrases. Prints the list as it is then.'),
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
  endpoint<{ contentId: string; tag: string; tags: string[]; status?: string; muted: boolean }>({
    name: 'tag remove',
    positionals: ['contentId', 'tag'],
    options: { mute: { type: 'boolean' } },
    flags: '[--mute]',
    role: 'moderator',
    summary: "Removes a hashtag from content, for good: updates don't get it back. With --mute, also mutes its publisher on the hashtag.",
    request: ({ positionals: [contentId, tag], values }) => ({
      method: 'DELETE',
      path: path`/content/${contentId!}/tags/${tag!}`,
      ...(values.mute === true && { body: { mute: true } }),
    }),
    text: (d) =>
      (d.status === 'pending_deletion'
        ? `#${d.tag} was the last hashtag of ${d.contentId}, so the content is set for deletion.`
        : `Removed #${d.tag} from ${d.contentId}: it's now under ${hashtags(d.tags)}.`) + (d.muted ? `\nIts publisher is muted on #${d.tag}.` : ''),
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
      const body = { username, ...(typeof values.language === 'string' && { language: values.language }) };
      const user = await (await ctx.api()).request<{ userId: string; username: string; apiKey: string }>('POST', '/register', body).catch((err: unknown) => {
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
    summary: 'Makes a user a server moderator: they can work through the moderation queue and the report queue.',
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
      "Bans a user: they can't post, comment or send messages, and can still read. They are told. Not an admin or a server moderator. With --reason, what moderators can read of why.",
    request: ({ positionals: [userId], values }) => ({
      method: 'PUT',
      path: path`/banned/${userId!}`,
      ...(typeof values.reason === 'string' && { body: { reason: values.reason } }),
    }),
    text: (d) => (d.alreadyBanned ? `${d.username} (${d.userId}) was already banned.` : `${d.username} (${d.userId}) is banned: they can't post, comment or send messages.`),
  }),
  endpoint<{ userId: string; wasBanned: boolean }>({
    name: 'bans remove',
    positionals: ['userId'],
    role: 'serverModerator',
    summary: 'Ends a ban. The user is told.',
    request: ({ positionals: [userId] }) => ({ method: 'DELETE', path: path`/banned/${userId!}` }),
    text: (d) => (d.wasBanned ? `${d.userId} is no longer banned.` : `${d.userId} wasn't banned.`),
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

const SECTIONS: { role: Role; title: (me?: WhoAmI) => string }[] = [
  { role: 'anyone', title: () => 'For everyone' },
  {
    role: 'moderator',
    title: (me) => `For a hashtag's moderators${me?.moderates.length ? ` (you moderate ${hashtags(me.moderates)})` : ''}, and admins on every hashtag`,
  },
  { role: 'serverModerator', title: () => 'For server moderators, and admins' },
  { role: 'admin', title: () => 'For admins' },
];

/** How long `help` waits for the server to say what the key may do, before it shows the commands unmarked. */
const HELP_TIMEOUT_MS = 5000;

/**
 * Every command, by who it is for. With a profile whose server answers, the ones its key may use are
 * marked, from the roles /whoami gives; the server still decides each request.
 */
export async function helpText(ctx: Context): Promise<string> {
  let who: { name: string; server: string; me: WhoAmI } | undefined;
  try {
    const { name } = await ctx.profile();
    const api = await ctx.api();
    who = { name, server: api.server, me: await api.request<WhoAmI>('GET', '/whoami', undefined, HELP_TIMEOUT_MS) };
  } catch {
    // No profile, or no answer: the commands are shown all the same.
  }
  const me = who?.me;
  const allowed = (role: Role) =>
    role === 'anyone' || me!.admin || (role === 'moderator' && me!.moderates.length > 0) || (role === 'serverModerator' && me!.moderator);
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
      lines.push(`  ${me ? (allowed(role) ? '+ ' : '- ') : ''}${usage(c).padEnd(width)}  ${c.summary}`);
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
