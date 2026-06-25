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
 * Method-style log sink: an object with a `warn` method (and optional `info` /
 * `debug`). The call shape is `(fields, msg)` — structured object first, message
 * second — which matches pino, bunyan, and roarr, so those drop in directly; a
 * plain `console` or `{}` satisfies it too. This is the *sink* — where pervigil's
 * log lines go; {@link LogLevel} controls *which* lines are emitted.
 *
 * For loggers with a different argument order (winston, consola, …) pass a
 * {@link LoggerFn} instead and map the {@link LogRecord} however you like.
 */
export interface Logger {
  warn(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

/**
 * One log line pervigil wants to emit, normalised for a {@link LoggerFn}.
 * `fields` is always present — an empty object when there's no structured data —
 * so `record.fields.x` never throws on you.
 */
export interface LogRecord {
  /** Severity of this line; never `"silent"` (that suppresses emission entirely). */
  readonly level: Exclude<LogLevel, "silent">;
  /** Human-readable message, if any. */
  readonly msg?: string;
  /** Structured context for the line; `{}` when there is none. */
  readonly fields: Record<string, unknown>;
}

/**
 * Function-style log sink: pervigil hands you one {@link LogRecord} per line and
 * you forward it to any logger, regardless of its argument order. The escape
 * hatch for loggers that aren't `(fields, msg)`-shaped:
 *
 * ```ts
 * wakeLock({ logger: (r) => winston.log(r.level, r.msg ?? "", r.fields) });
 * ```
 */
export type LoggerFn = (record: LogRecord) => void;

/**
 * Verbosity threshold for pervigil's own log emission, highest (`debug`) to
 * lowest (`silent`). Resolved from the `logLevel` option, else the
 * `PERVIGIL_LOG_LEVEL` env var, else a default (`silent` when no logger is
 * wired, `debug` when a logger is supplied — i.e. forward everything and let
 * your logger filter).
 */
export type LogLevel = "silent" | "warn" | "info" | "debug";

/**
 * The platform mechanism behind a wake lock. Drivers coalesce idempotent
 * calls and recycle their OS primitive when the axis flags change.
 */
export interface Driver {
  /** A short platform/backend id, e.g. `"macos-caffeinate"`, `"noop"`. */
  readonly platform: string;
  /** Whether a real OS primitive is available (false ⇒ no-op). */
  readonly available: boolean;
  /** Why the driver is degraded to no-op, if it is. */
  readonly degradedReason?: DegradedReason;
  /**
   * Whether a real OS assertion is in effect **right now** — distinct from
   * "available" (the driver is capable) and from the controller's "engaged"
   * (a reason is desired). Goes `false` when the primitive dies between
   * re-engages. Optional: drivers that can't observe their primitive may omit
   * it, and the controller then assumes the lock is held whenever a reason is
   * engaged on an available driver.
   */
  readonly held?: boolean;
  /** Count of times the OS primitive died unexpectedly and was recycled. */
  readonly restarts?: number;
  /**
   * Apply the desired axis state. Called whenever the (system, display) pair
   * or the description changes.
   */
  setState(state: WakeLockState, description: string): Promise<void>;
  /** Release every axis and tear down the OS primitive. Idempotent. */
  shutdown(): Promise<void>;
  /**
   * Register a callback invoked whenever the OS primitive dies unexpectedly
   * (and is recycled). May be called more than once to register multiple
   * callbacks. Optional: drivers with no recyclable primitive (e.g. the no-op
   * driver) may treat it as a no-op. The controller uses this to surface the
   * `primitiveDied` event for both self-built and injected drivers.
   */
  onPrimitiveDied?(cb: () => void): void;
}
