import { WakeLockEngine } from "./core.js";
import { detectDriver } from "./detect.js";
import { WakeLockUnavailableError } from "./errors.js";
import { registerExitCleanup } from "./internal/exit-cleanup.js";
import type {
  DegradedReason,
  Driver,
  Logger,
  LoggerFn,
  LogLevel,
  WakeAxis,
  WakeLockState,
  WakeReason,
} from "./types.js";

/** Per-call axis selection + human description. */
export interface AcquireOptions {
  /** Block system sleep. Defaults to `true` only when neither axis is given. */
  system?: boolean;
  /** Block display sleep. Default `false`. */
  display?: boolean;
  /** Human-readable reason, surfaced in logs and OS assertion listings. */
  description?: string;
}

/** A point-in-time + cumulative view of the wake lock, for observability. */
export interface WakeLockStatus {
  /** Driver platform/backend id, e.g. `"macos-caffeinate"`, `"noop"`. */
  platform: string;
  /** Whether the driver is capable of a real OS primitive (false ⇒ no-op). */
  available: boolean;
  /**
   * Whether the host is actually being kept awake **right now** — a real OS
   * assertion is in effect. This is the truth, distinct from `available` (the
   * driver is *capable*) and `engaged` (a reason is *desired*). It is `false`
   * when degraded, when nothing is engaged, or when the OS primitive has died
   * and not yet re-engaged.
   */
  active: boolean;
  /** Why the driver is degraded, or `null`. */
  degradedReason: DegradedReason;
  /** Which axes currently have a reason desired (intent, not reality). */
  engaged: WakeLockState;
  /** The active reasons per axis. */
  reasons: { system: WakeReason[]; display: WakeReason[] };
  /** Epoch-ms the current engagement of each axis began, or `null`. */
  since: { system: number | null; display: number | null };
  counters: {
    /** false→true edges per axis (real activations). */
    engageTransitions: { system: number; display: number };
    /** Total wall-clock ms each axis has been held (includes the live span). */
    awakeMsTotal: { system: number; display: number };
    /** Times the OS primitive died unexpectedly and was recycled. */
    primitiveRestarts: number;
  };
}

export type WakeLockEvent =
  | "engaged"
  | "disengaged"
  | "reasonsChanged"
  | "primitiveDied"
  | "degraded";

/** A supervised, multi-reason wake lock. */
export interface WakeLock {
  /** Add or replace a reason by `key`. Reconciles the OS primitive. */
  acquire(key: string, opts?: AcquireOptions): Promise<void>;
  /** Remove a reason by `key`. No-op if the key is not held. */
  release(key: string): Promise<void>;
  /** Current + cumulative observability snapshot. */
  status(): WakeLockStatus;
  /** Subscribe to an event; returns an unsubscribe function. */
  on(event: WakeLockEvent, listener: (status: WakeLockStatus) => void): () => void;
  /** Release every reason and tear down the driver. Idempotent. */
  shutdown(): Promise<void>;
}

export interface WakeLockOptions {
  /** Inject a driver. Default: {@link detectDriver} for the host platform. */
  driver?: Driver;
  /**
   * Sink for pervigil's log lines, passed to the default driver. Either a
   * method-shaped {@link Logger} (pino/bunyan/console) or a {@link LoggerFn}
   * (one `LogRecord` per line, for any other logger). Ignored when a `driver`
   * is injected (that driver carries its own logger). Defaults to a built-in
   * console sink, gated by {@link WakeLockOptions.logLevel}.
   */
  logger?: Logger | LoggerFn;
  /**
   * Emission threshold for pervigil's own logs. Defaults to `silent` unless a
   * `logger` is supplied. Also settable via `PERVIGIL_LOG_LEVEL`. Ignored when
   * a `driver` is injected.
   */
  logLevel?: LogLevel;
  /**
   * Telemetry hook fired on every lifecycle event (`engaged`, `disengaged`,
   * `reasonsChanged`, `primitiveDied`, `degraded`) with a fresh status
   * snapshot — one place to forward to OpenTelemetry / StatsD / logs without
   * subscribing to each event individually. A throwing handler is swallowed so
   * it can never break the lock. Equivalent to calling {@link WakeLock.on} for
   * each event.
   */
  onEvent?: (event: WakeLockEvent, status: WakeLockStatus) => void;
  /**
   * Fail loud instead of degrading silently. When `true`, `acquire` rejects
   * with {@link WakeLockUnavailableError} if the driver cannot engage a real OS
   * primitive (unsupported platform, container, missing binary, forced no-op).
   * Default `false` — pervigil stays a graceful no-op. Use `strict` when the
   * job genuinely must not proceed unless the host is actually kept awake.
   */
  strict?: boolean;
  /**
   * Release the OS primitive automatically when the process exits, so a
   * forgotten `shutdown()` can't leak an orphaned `caffeinate` /
   * `systemd-inhibit` / PowerShell child. Default `true`.
   *
   * Implemented with a single shared `process` `"exit"` handler (no signal
   * listeners, so it never interferes with Ctrl-C / your own `SIGINT` /
   * `SIGTERM` handling). It covers normal exit, `process.exit()`, and Ctrl-C;
   * for `SIGTERM`-without-a-handler use {@link releaseOnExit} or your own
   * signal handler. Set `false` to opt out.
   */
  autoRelease?: boolean;
  /** Stable identity surfaced to the OS (systemd `--who=`, sysfs cookie). */
  identity?: string;
  /** Wall-clock source; injectable for tests. Default `Date.now`. */
  now?: () => number;
}

interface Hold {
  system: boolean;
  display: boolean;
  reason: WakeReason;
}

const AXES: readonly WakeAxis[] = ["system", "display"];

/**
 * Create a supervised, multi-reason wake lock. Callers `acquire`/`release`
 * reasons by key; the controller reconciles them onto the two independent
 * axes and drives the OS primitive, while tracking observability counters.
 */
export function wakeLock(opts: WakeLockOptions = {}): WakeLock {
  const now = opts.now ?? (() => Date.now());
  const listeners = new Map<WakeLockEvent, Set<(s: WakeLockStatus) => void>>();
  const holds = new Map<string, Hold>();

  const counters = {
    engageTransitions: { system: 0, display: 0 },
    awakeMsTotal: { system: 0, display: 0 },
    primitiveRestarts: 0,
  };
  const since: { system: number | null; display: number | null } = {
    system: null,
    display: null,
  };

  const driver: Driver =
    opts.driver ??
    detectDriver({
      logger: opts.logger,
      logLevel: opts.logLevel,
      identity: opts.identity,
      // Death notification is wired below via `driver.onPrimitiveDied(...)` for
      // every driver (injected or self-built), so we must NOT also pass the
      // constructor `onPrimitiveDied` option here — doing so would register the
      // same handler twice and double-count each death.
    });

  // Register the controller's death handler for EVERY driver — injected drivers
  // never see the `detectDriver` constructor option, so this is the only path
  // that surfaces `primitiveDied` for them.
  driver.onPrimitiveDied?.(() => {
    counters.primitiveRestarts += 1;
    emit("primitiveDied");
  });

  // Release the OS primitive on process exit by default, so a forgotten
  // shutdown can't leak an orphaned child. `driver.shutdown()` sends its child
  // SIGTERM synchronously, which is what an `exit` handler needs.
  let unregisterExit: (() => void) | undefined;
  if (opts.autoRelease !== false) {
    unregisterExit = registerExitCleanup(() => {
      driver.shutdown().then(undefined, () => undefined);
    });
  }

  const engine = new WakeLockEngine(driver, {
    onFlush: (state, prev) => {
      const t = now();
      for (const axis of AXES) {
        const was = prev[axis];
        const is = state[axis];
        if (!was && is) {
          counters.engageTransitions[axis] += 1;
          since[axis] = t;
          emit("engaged");
        } else if (was && !is) {
          const start = since[axis];
          if (start !== null) counters.awakeMsTotal[axis] += t - start;
          since[axis] = null;
          emit("disengaged");
        }
      }
    },
  });

  if (!driver.available) {
    // Surface the degraded state once, after the caller has had a chance to
    // attach listeners synchronously following construction.
    queueMicrotask(() => emit("degraded"));
  }

  const onEvent = opts.onEvent;

  function emit(event: WakeLockEvent): void {
    const set = listeners.get(event);
    const hasListeners = set !== undefined && set.size > 0;
    // Build the snapshot once, only if someone is listening.
    if (!hasListeners && onEvent === undefined) return;
    const snapshot = status();
    if (onEvent !== undefined) {
      try {
        onEvent(event, snapshot);
      } catch {
        // A misbehaving telemetry hook must never break the lock.
      }
    }
    if (hasListeners) {
      for (const cb of set) {
        try {
          cb(snapshot);
        } catch {
          // A misbehaving listener must never break the lock.
        }
      }
    }
  }

  function reasonsFor(axis: WakeAxis): WakeReason[] {
    const out: WakeReason[] = [];
    for (const h of holds.values()) {
      if (h[axis]) out.push(h.reason);
    }
    return out;
  }

  async function reconcile(): Promise<void> {
    await engine.applyAxes(reasonsFor("system"), reasonsFor("display"));
  }

  // Serialize every state-changing operation through a promise chain so they
  // run to completion in order and never interleave with an in-flight
  // `driver.setState`. A rejected op must not break the chain for later ops:
  // we always advance `tail` past the settled op, and surface each op's own
  // result (resolve or reject) to its caller.
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = tail.then(op, op);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function status(): WakeLockStatus {
    const t = now();
    const awakeMsTotal = {
      system: counters.awakeMsTotal.system,
      display: counters.awakeMsTotal.display,
    };
    for (const axis of AXES) {
      const start = since[axis];
      if (start !== null) awakeMsTotal[axis] += t - start;
    }
    const anyEngaged = engine.isEngaged("system") || engine.isEngaged("display");
    // `active` = a real assertion is in effect now. Fall back to "assume held"
    // for drivers that don't observe their primitive (`held === undefined`), so
    // injected/simple drivers still report active whenever engaged + available.
    const active = driver.available && anyEngaged && (driver.held ?? true);
    return {
      platform: driver.platform,
      available: driver.available,
      active,
      degradedReason: driver.degradedReason ?? null,
      engaged: { system: engine.isEngaged("system"), display: engine.isEngaged("display") },
      reasons: { system: reasonsFor("system"), display: reasonsFor("display") },
      since: { system: since.system, display: since.display },
      counters: {
        engageTransitions: { ...counters.engageTransitions },
        awakeMsTotal,
        primitiveRestarts: driver.restarts ?? counters.primitiveRestarts,
      },
    };
  }

  return {
    acquire(key, o = {}) {
      return enqueue(async () => {
        // Strict mode: refuse to pretend. If the driver can't engage a real
        // primitive, reject instead of silently no-op'ing — and don't record
        // the hold, since it would never take effect.
        if (opts.strict && !driver.available) {
          throw new WakeLockUnavailableError(driver.degradedReason ?? null, driver.platform);
        }
        // Default to the system axis only when neither axis is specified; an
        // explicitly-set axis must not drag the other to its default.
        const specified = o.system !== undefined || o.display !== undefined;
        holds.set(key, {
          system: o.system ?? !specified,
          display: o.display ?? false,
          reason: { key, description: o.description ?? key },
        });
        await reconcile();
        emit("reasonsChanged");
      });
    },
    release(key) {
      return enqueue(async () => {
        if (!holds.delete(key)) return;
        await reconcile();
        emit("reasonsChanged");
      });
    },
    status,
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    shutdown() {
      // Stop tracking for exit-cleanup the moment shutdown is requested — the
      // caller is tearing down explicitly, so the `exit` handler shouldn't also
      // fire for this lock.
      unregisterExit?.();
      unregisterExit = undefined;
      return enqueue(() => engine.shutdown());
    },
  };
}
