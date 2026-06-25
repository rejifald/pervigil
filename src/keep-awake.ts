import { createWakeLock, type CreateWakeLockOptions, type WakeLockStatus } from "./controller.js";

export interface KeepAwakeOptions extends CreateWakeLockOptions {
  /** Block system sleep. Default `true`. */
  system?: boolean;
  /** Block display sleep. Default `false`. */
  display?: boolean;
  /** Human-readable reason, surfaced in logs and OS assertion listings. */
  reason?: string;
}

/** A single-purpose handle returned by {@link keepAwake}. */
export interface WakeLockHandle {
  /** Release the assertion and tear down the OS primitive. Idempotent. */
  release(): Promise<void>;
  /** Observability snapshot for this handle. */
  status(): WakeLockStatus;
  /** `await using` support (Node 20.4+ / TS 5.2+). */
  [Symbol.asyncDispose](): Promise<void>;
}

const HANDLE_KEY = "keep-awake";

interface KeepAwakeFn {
  (opts?: KeepAwakeOptions): Promise<WakeLockHandle>;
  /**
   * Hold the lock for the duration of `fn`, releasing it afterwards even if
   * `fn` throws. Returns whatever `fn` returns.
   */
  while<T>(opts: KeepAwakeOptions, fn: () => Promise<T> | T): Promise<T>;
}

/**
 * Acquire a wake lock and get a handle to release it. The simple, one-shot
 * entry point; for multi-reason coordination use {@link createWakeLock}.
 *
 * ```ts
 * const lock = await keepAwake({ system: true, reason: "nightly backup" });
 * // ... long job ...
 * await lock.release();
 * ```
 */
export const keepAwake: KeepAwakeFn = async function keepAwake(
  opts: KeepAwakeOptions = {},
): Promise<WakeLockHandle> {
  const { system = true, display = false, reason, ...controllerOpts } = opts;
  const wl = createWakeLock(controllerOpts);
  await wl.acquire(HANDLE_KEY, { system, display, description: reason ?? HANDLE_KEY });
  return {
    release: () => wl.shutdown(),
    status: () => wl.status(),
    [Symbol.asyncDispose]: () => wl.shutdown(),
  };
} as KeepAwakeFn;

keepAwake.while = async function keepAwakeWhile<T>(
  opts: KeepAwakeOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lock = await keepAwake(opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
};
