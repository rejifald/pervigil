/** Which OS sleep behaviour an assertion targets. */
export type WakeAxis = "system" | "display";

/** Why a driver is running in no-op mode, or `null` when fully operational. */
export type DegradedReason =
  | "container"
  | "missing-binary"
  | "unsupported-platform"
  | "forced"
  | null;

/** The desired engagement of each independent axis. */
export interface WakeLockState {
  /** Block system idle sleep. */
  readonly system: boolean;
  /** Block display sleep independently from system sleep. */
  readonly display: boolean;
}

/**
 * A single named reason the host should stay awake. `key` is a free-form,
 * caller-defined dedup id (e.g. `"job:123"`); `description` is the
 * human-readable text surfaced in logs and OS assertion listings.
 */
export interface WakeReason {
  readonly key: string;
  readonly description?: string;
}

/**
 * Pino-shaped logger surface used by drivers. All methods are optional so a
 * plain `console` or `{}` satisfies it.
 */
export interface WakeLockLogger {
  warn(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

/**
 * The platform mechanism behind a wake lock. Drivers coalesce idempotent
 * calls and recycle their OS primitive when the axis flags change.
 */
export interface WakeLockDriver {
  /** A short platform/backend id, e.g. `"macos-caffeinate"`, `"noop"`. */
  readonly platform: string;
  /** Whether a real OS primitive is available (false ⇒ no-op). */
  readonly available: boolean;
  /** Why the driver is degraded to no-op, if it is. */
  readonly degradedReason?: DegradedReason;
  /** Count of times the OS primitive died unexpectedly and was recycled. */
  readonly restarts?: number;
  /**
   * Apply the desired axis state. Called whenever the (system, display) pair
   * or the description changes.
   */
  setState(state: WakeLockState, description: string): Promise<void>;
  /** Release every axis and tear down the OS primitive. Idempotent. */
  shutdown(): Promise<void>;
}
