import { parseArgs } from 'node:util';
import { apiClient, CliError, UpdateRequired } from './client.js';
import type { Api } from './client.types.js';
import { COMMANDS, helpText, usage } from './commands.js';
import type { Command, Context, Io } from './commands.types.js';
import { pickProfile } from './profiles.js';
import { installRelease } from './update.js';

/** Set for the run that follows an update, so a server that still wants another build ends it instead of looping. */
export const UPDATED = 'EVIEVERSE_UPDATED';

/** The options every command takes, wherever they are among the arguments; the rest are the command's. */
function globalOptions(argv: string[]) {
  const options = { profile: undefined as string | undefined, json: false, help: false, version: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version') options.version = true;
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length);
    else if (arg === '--profile') {
      options.profile = argv[++i];
      if (options.profile === undefined) throw new CliError('--profile needs a name', 2);
    } else rest.push(arg);
  }
  return { options, rest };
}

/** The command the arguments start with, and the arguments after its name. */
function findCommand(args: string[]): { command: Command; args: string[] } {
  const [first, second] = args;
  for (const [name, taken] of [[`${first} ${second}`, 2], [first, 1]] as const) {
    const command = COMMANDS.find((c) => c.name === name);
    if (command) return { command, args: args.slice(taken) };
  }
  const group = COMMANDS.filter((c) => c.name.startsWith(`${first} `)).map((c) => c.name.split(' ')[1]);
  if (group.length) throw new CliError(`\`${first}\` is followed by one of: ${group.join(', ')}`, 2);
  throw new CliError(`there is no command \`${first}\`: \`evieverse help\` lists them`, 2);
}

function parse(command: Command, args: string[]) {
  const wrong = () => new CliError(`usage: evieverse ${usage(command)}`, 2);
  let parsed;
  try {
    parsed = parseArgs({ args, options: command.options ?? {}, allowPositionals: true, strict: true });
  } catch {
    throw wrong();
  }
  const count = parsed.positionals.length;
  const needed = command.positionals?.length ?? 0;
  if (command.rest ? count <= needed : count !== needed) throw wrong();
  return parsed;
}

async function dispatch(argv: string[], io: Io): Promise<void> {
  const { options, rest } = globalOptions(argv);
  const profileName = options.profile ?? (io.env.EVIEVERSE_PROFILE || undefined);
  let picked: ReturnType<typeof pickProfile> | undefined;
  const ctx: Context = {
    io,
    profileName,
    profile: () => (picked ??= pickProfile(io.home, profileName)),
    api: async (): Promise<Api> => apiClient(io.fetch, (await ctx.profile()).profile),
  };

  if (options.help || rest[0] === 'help' || (!rest.length && !options.version)) return io.out(await helpText(ctx));
  const { command, args } = options.version ? { command: COMMANDS.find((c) => c.name === 'version')!, args: [] } : findCommand(rest);
  const result = await command.run(ctx, parse(command, args));
  io.out(options.json ? JSON.stringify(result.data, null, 2) : result.text);
}

/**
 * The server answered 426: it ships another build of the CLI. This one replaces its own file with the
 * server's and runs the command again, once: a second 426 means the server's nodes disagree, mid-deploy.
 */
async function update({ server, release }: UpdateRequired, argv: string[], io: Io): Promise<number> {
  if (io.env[UPDATED]) {
    throw new CliError(`${server} asked for another build of the CLI (${release.build}) right after an update: it may be mid-deploy, so try again in a minute`);
  }
  io.err(`evieverse: ${server} needs version ${release.version} (build ${release.build}) of the CLI; updating...`);
  await installRelease(io.fetch, io.selfPath, server, release);
  return io.rerun(argv);
}

/** Runs the CLI with `argv` (the arguments after the program's name). Resolves with the exit code: 0, 1 for a failure, 2 for a command that isn't one. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    try {
      await dispatch(argv, io);
      return 0;
    } catch (err) {
      if (!(err instanceof UpdateRequired)) throw err;
      return await update(err, argv, io);
    }
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`evieverse: ${err.message}`);
    return err.exitCode;
  }
}
