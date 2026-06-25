/**
 * Options for {@link releaseOnExit}.
 */
export interface AutoReleaseOptions {
  /**
   * POSIX signals to release on. Default `["SIGINT", "SIGTERM"]`.
   *
   * Installing a listener for one of these signals removes Node's default
   * "terminate on signal" behaviour, so after releasing we **re-raise** the
   * signal (restoring the default disposition) — the process still exits, with
   * the conventional `128 + signal` code. If you already manage these signals
   * yourself (e.g. a graceful-shutdown routine), call the returned unregister
   * function so the two don't both drive teardown.
   */
  signals?: NodeJS.Signals[];
  /**
   * Emitter to register on. Default `process`. Injectable so tests can drive
   * exit events without touching the real process. The signal re-raise only
   * fires when this is the real `process`.
   */
  emitter?: NodeJS.EventEmitter;
}

const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Release `target` automatically when the process is about to exit, including
 * on `SIGINT` / `SIGTERM` — the gap the default `autoRelease` (`exit`-only)
 * can't see.
 *
 * `target.shutdown()` runs exactly once (the first event wins; later events are
 * ignored). On a signal it releases and then re-raises the signal so the
 * process still terminates normally — without that, installing a signal
 * listener would suppress Node's default exit and hang the process. Returns an
 * unregister function that removes every listener it added.
 *
 * ```ts
 * const lock = wakeLock();
 * const stop = releaseOnExit(lock);
 * // ... later, if you take over signal handling yourself:
 * stop();
 * ```
 */
export function releaseOnExit(
  target: { shutdown(): Promise<void> | void },
  opts: AutoReleaseOptions = {},
): () => void {
  const emitter = opts.emitter ?? process;
  const signals = opts.signals ?? DEFAULT_SIGNALS;

  let fired = false;
  let unregistered = false;
  const unregister = (): void => {
    if (unregistered) return;
    unregistered = true;
    emitter.removeListener("beforeExit", onBeforeExit);
    for (const signal of signals) {
      emitter.removeListener(signal, onSignal);
    }
  };

  // Natural exit: just release. `beforeExit` can host async work and doesn't
  // need re-raising.
  const onBeforeExit = (): void => {
    if (fired) return;
    fired = true;
    void Promise.resolve(target.shutdown()).catch(() => undefined);
  };

  // Signal: release, then restore default disposition and re-raise so the
  // process terminates as it would have without our listener.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (fired) return;
    fired = true;
    void Promise.resolve(target.shutdown())
      .catch(() => undefined)
      .finally(() => {
        unregister();
        // Only re-raise against the real process — tests inject a mock emitter
        // and must not signal the test runner.
        if (emitter === process) {
          process.kill(process.pid, signal);
        }
      });
  };

  emitter.on("beforeExit", onBeforeExit);
  for (const signal of signals) {
    emitter.on(signal, onSignal);
  }

  return unregister;
}
