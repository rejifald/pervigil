import type { DegradedReason } from "./types.js";

/**
 * Thrown by `acquire` (and therefore `keepAwake`) **only in `strict` mode**,
 * when the lock cannot engage a real OS assertion — i.e. the driver is degraded
 * to a no-op (unsupported platform, container, missing binary, or forced).
 *
 * In the default (non-strict) mode pervigil never throws this: it degrades to a
 * silent no-op instead. Opt into `strict` when your job genuinely must not run
 * unless the host is actually kept awake.
 */
export class WakeLockUnavailableError extends Error {
  /** Why the driver is degraded, or `null` if unknown. */
  readonly degradedReason: DegradedReason;
  /** The driver platform/backend id that could not engage, e.g. `"noop"`. */
  readonly platform: string;

  constructor(degradedReason: DegradedReason, platform: string) {
    super(
      `pervigil: wake lock unavailable on "${platform}"` +
        (degradedReason ? ` (${degradedReason})` : "") +
        " — strict mode requires a real OS wake-lock primitive.",
    );
    this.name = "WakeLockUnavailableError";
    this.degradedReason = degradedReason;
    this.platform = platform;
  }
}
