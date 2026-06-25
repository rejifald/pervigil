/**
 * Options for {@link releaseOnExit}.
 */
export interface AutoReleaseOptions {
  /**
   * POSIX signals to release on. Default `["SIGINT", "SIGTERM"]`.
   *
   * Note: listening for a signal does not, by itself, stop the process from
   * terminating; it merely gives us a chance to release the lock first. If you
   * install your own handlers for these signals (e.g. for a graceful
   * shutdown), call the returned unregister function so the two don't fight
   * over teardown ordering.
   */
  signals?: NodeJS.Signals[];
  /**
   * Emitter to register on. Default `process`. Injectable so tests can drive
   * exit events without touching the real process.
   */
  emitter?: NodeJS.EventEmitter;
}

const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Release `target` automatically when the process is about to exit.
 *
 * Registers `beforeExit` plus the given `signals` on the emitter and calls
 * `target.shutdown()` exactly once — the first event to fire wins, and later
 * events are ignored (idempotent). Returns an unregister function that removes
 * every listener it added.
 *
 * ```ts
 * const lock = wakeLock();
 * const stop = releaseOnExit(lock);
 * // ... later, if you take over signal handling yourself:
 * stop();
 * ```
 *
 * The `emitter` option exists for tests; consumers that manage their own
 * signal handlers should call the returned unregister function to avoid
 * double-handling.
 */
export function releaseOnExit(
  target: { shutdown(): Promise<void> | void },
  opts: AutoReleaseOptions = {},
): () => void {
  const emitter = opts.emitter ?? process;
  const signals = opts.signals ?? DEFAULT_SIGNALS;

  let fired = false;
  const onExit = (): void => {
    if (fired) return;
    fired = true;
    // Swallow the result: exit handlers can't meaningfully await, and a
    // rejected teardown must never become an unhandled rejection.
    void Promise.resolve(target.shutdown()).catch(() => {
      /* best-effort teardown */
    });
  };

  emitter.on("beforeExit", onExit);
  for (const signal of signals) {
    emitter.on(signal, onExit);
  }

  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    emitter.removeListener("beforeExit", onExit);
    for (const signal of signals) {
      emitter.removeListener(signal, onExit);
    }
  };
}
