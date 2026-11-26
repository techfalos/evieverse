import type { Config } from '../config.js';
import { addon, answered, say } from '../native.js';
import type { SaidTo } from '../native.types.js';
import type { Moderation, Shown, TrustOptions } from './trust.types.js';

/**
 * A post's trust score: how far the server trusts it, from 0 (not at all) to 100. It serves one
 * purpose, which is to say where the post goes, and is kept nowhere but in the moderation queue,
 * beside a post that waits there.
 *
 * The score is worked out by plugins, which are Rust, as is everything that reads them a post:
 * every folder of compactor/crates/trust/src/plugins is one, an algorithm that looks at a post
 * and may lower its score. Every post and update starts at 100 and goes through each of the ones
 * the server runs: all of them, but for the optional ones it didn't turn on
 * (`trust.optionalPlugins`). A comment on a post is scored the same way, and so is what a user
 * puts on their profile.
 *
 * The compactor's process runs the same plugins on what it scores (a video, a repost's original
 * that changed). Here they are reached through the addon (src/native.ts), which a server opens
 * once: `openTrust`.
 */

/**
 * A server's trust plugins and the moderation policy over them, as the addon keeps them: its own
 * few connections to the database, and what the plugins keep between posts (a list they
 * download).
 */
export class TrustEngine {
  /** The plugins the server runs, by name, in the order they run in. */
  readonly plugins: readonly string[];
  /** Whether one of them reads a post's images. Where none does, nothing of an image is read for them. */
  readonly readsImages: boolean;
  private closed = false;

  /** `log` is the process's log, which is told what the plugins say between two requests. */
  constructor(
    private readonly handle: number,
    private readonly log?: SaidTo,
  ) {
    this.plugins = addon().pluginNames(handle);
    this.readsImages = addon().readsImages(handle);
  }

  /**
   * Has the addon do `method` with `asked`, at the time `now`. What it says for the log meanwhile
   * goes to `log`, the request's. Throws if it could not be done at all: a plugin failed, or the
   * database. A post a plugin didn't get to look at is not published.
   */
  async ask<T>(method: string, now: number, asked: Record<string, unknown>, log?: SaidTo): Promise<Moderation<T>> {
    const answer = answered<T>(await addon().call(this.handle, method, now, JSON.stringify(asked)));
    say(log ?? this.log, answer.logs);
    say(this.log, answer.background);
    if ('failed' in answer) throw new Error(answer.failed);
    return 'refused' in answer ? { refused: answer.refused as never } : { ok: answer.ok };
  }

  /** What the test plugins that record were shown since this was last asked, in order. Only an addon built for tests answers. */
  async seen(): Promise<Shown[]> {
    const answer = await this.ask<Shown[]>('seen', 0, {});
    return 'ok' in answer ? answer.ok : [];
  }

  /** Closes its connections to the database. It is asked nothing after this. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await addon().close(this.handle);
  }
}

/**
 * Opens a server's trust: the plugins its settings turn on, loaded now, so that one the addon
 * was built without stops the server here, and not at the first post.
 */
export function openTrust(config: Config, log?: SaidTo, options: TrustOptions = {}): TrustEngine {
  return new TrustEngine(addon().open(JSON.stringify(config), JSON.stringify(options)), log);
}
