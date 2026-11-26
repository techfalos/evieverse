/** One of the programs a supervisor runs (see supervise). */
export interface Part {
  /** What the log calls it. */
  name: string;
  /** The program. */
  command: string;
  /** What it is started with. */
  args: string[];
  /** Its environment; the supervisor's own where none is given. */
  env?: Record<string, string | undefined>;
  /**
   * For a part the ones after it need: resolves once it does what they need of it. They are
   * started then, and stopped before it is. `signal` is aborted when the wait is for nothing any
   * more, as the supervisor stops.
   */
  ready?: (signal: AbortSignal) => Promise<void>;
}

/** How a supervisor runs its parts. */
export interface SuperviseOptions {
  /** How long a part has to end once it is told to (SIGTERM), in milliseconds, before it is killed (SIGKILL). */
  graceMs?: number;
  /** Is told what the supervisor does, a line for each thing. */
  log?: (line: string) => void;
}

/** Parts that are being run (see supervise). */
export interface Supervised {
  /** Resolves once every part has ended: with 0 if they were stopped (see `stop`), and with 1 if one of them ended of itself, or never started. */
  done: Promise<number>;
  /** Stops the parts, which is how they are meant to end. `why` is what the log says of it. */
  stop: (why: string) => void;
}
