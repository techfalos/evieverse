import type { Api } from './client.types.js';
import type { Profile } from './profiles.types.js';

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

/**
 * What a command runs with: the world it reaches (`io`), and the profile and its server, which are
 * read and reached only if the command asks for them. `dispatch` in main.ts makes it.
 */
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
 * `serverModerator` the server's: one who works through its moderation queue and its report queue,
 * and may use a hashtag's moderator's commands on every hashtag, as an admin may.
 */
export type Role = 'anyone' | 'moderator' | 'serverModerator' | 'admin';

/** A command's own arguments, once they are checked against what it takes: the positionals in order, and the options given, by name. */
export interface Args {
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
}

/** What a command's `run` resolves with, in both forms the CLI can print it: `text` for people, and `data` for programs. */
interface Result {
  /** What `--json` prints. */
  data: unknown;
  text: string;
}

/**
 * A command of the CLI: its name and the arguments it takes, which `help` shows and the arguments
 * given are checked against, who it is for, and what it does. `COMMANDS` holds them all.
 */
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

/**
 * What GET /whoami answers, as far as the CLI reads it: the account a key belongs to, its roles and
 * its settings. `login`, `whoami` and `help` say from it who the key's user is.
 */
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
  /** Whether a server moderator or an admin banned them: they can't post, comment, like or send messages. */
  banned?: boolean;
}
