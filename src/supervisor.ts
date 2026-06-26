import { wakeLock } from "./controller.js";
import type {
  AcquireOptions,
  ReasonSpec,
  WakeLock,
  WakeLockOptions,
  WakeLockStatus,
} from "./controller.js";
import { resolveLogger } from "./internal/logger.js";
import type { Logger, WakeAxis } from "./types.js";

/**
 * `pervigil/supervisor` — a declarative layer over {@link wakeLock}. Instead of
 * imperatively `acquire`/`release`-ing reasons and tracking lifetimes, callers
 * **declare self-managing locks and forget them**: each lock states its impact
 * (axes), an optional `active` predicate ("should it hold right now?"), and
 * optional eviction triggers (`until` / `maxAge` / `stale`). The supervisor
 * polls these, reconciles the underlying wake lock via {@link WakeLock.apply},
 * and reaps dead locks — so reality stays in sync with the declared conditions.
 *
 * @example Conditional, scoped, and pinned locks.
 * ```ts
 * import { supervise } from "pervigil/supervisor";
 *
 * const sup = supervise({ identity: "my-app", poll: "auto" });
 *
 * // standing: stay awake while any download runs
 * sup.add({ key: "downloads", active: () => downloads.size > 0 });
 * // scoped: hold for one operation, auto-evicted when it settles
 * sup.add({ description: "Importing dataset", until: importDataset() });
 * // pinned: held until removed
 * const override = sup.add({ axes: ["system", "display"], description: "Presentation mode" });
 * override.remove();
 * ```
 *
 * @module
 */

/** The five surfaced states of a supervised lock. See {@link LockHandle.state}. */
export type LockState = "holding" | "idle" | "unknown" | "paused" | "evicted";

/** A declarative, self-managing lock registered with a {@link Supervisor}. */
export interface SupervisedLock {
  /** Dedup id; auto-generated if omitted. */
  key?: string;
  /** Which OS axes this lock impacts. Default `["system"]`. */
  axes?: readonly WakeAxis[];
  /** Human-readable reason, surfaced in logs and OS assertion listings. */
  description?: string;
  /** "Should it hold right now?" — omitted ⇒ always holding. */
  active?: () => boolean | Promise<boolean>;
  /**
   * Permanent eviction trigger: a `PromiseLike` (evict when it settles) or a
   * predicate (evict when it returns true). A throwing predicate does NOT
   * evict — the lock stays registered and the error is logged.
   */
  until?: PromiseLike<unknown> | (() => boolean | Promise<boolean>);
  /**
   * Milliseconds of *continuous* `active()`-error before the lock is evicted.
   * Applies only to locks with an `active` callback. Any successful evaluation
   * (true or false) resets the clock. `false` disables. Default via
   * {@link SupervisorOptions.defaults}.
   */
  stale?: number | false;
  /**
   * Hard ceiling in ms from registration: evict when exceeded regardless of
   * state. Opt-in; no default.
   */
  maxAge?: number;
}

/** A live handle to a registered lock; mirrors the {@link Supervisor} controls. */
export interface LockHandle {
  readonly key: string;
  readonly axes: readonly WakeAxis[];
  readonly description?: string;
  /** The current {@link LockState}. Recomputed on each reconcile. */
  readonly state: LockState;
  /** Stop engaging + evaluating this lock until {@link LockHandle.resume}. */
  pause(): void;
  /** Resume a paused lock. */
  resume(): void;
  /** Permanently evict this lock. */
  remove(): void;
}

/** A live handle to an axis restriction. See {@link Supervisor.restrict}. */
export interface RestrictionHandle {
  readonly axis: WakeAxis;
  /** Whether the restriction is currently masking its axis off. */
  readonly active: boolean;
  /** Lift the restriction. */
  lift(): void;
}

/** The declarative supervisor over a {@link WakeLock}. See {@link supervise}. */
export interface Supervisor {
  /** Register a self-managing lock; returns its live {@link LockHandle}. */
  add(lock: SupervisedLock): LockHandle;
  /** Find a registered lock by key. */
  get(key: string): LockHandle | undefined;
  /** All currently-registered (non-evicted) handles. */
  list(): LockHandle[];
  /** Permanently evict a lock by key. No-op if unknown. */
  remove(key: string): void;
  /** Pause a lock by key. */
  pause(key: string): void;
  /** Resume a lock by key. */
  resume(key: string): void;
  /**
   * Forbid an axis: it is masked OFF in the final reconcile regardless of
   * locks. An optional `while` predicate makes the restriction conditional.
   */
  restrict(axis: WakeAxis, opts?: { while?: () => boolean }): RestrictionHandle;
  /** Lift every restriction on an axis. */
  allow(axis: WakeAxis): void;
  /** Introspect the active restrictions. */
  restrictions(): RestrictionHandle[];
  /** Force a supervisor-wide re-reconcile. */
  refresh(): Promise<void>;
  /** The underlying wake-lock observability snapshot. */
  status(): WakeLockStatus;
  /** Evict every lock, stop polling, and tear down the underlying lock. */
  shutdown(): Promise<void>;
  /** The composed underlying {@link WakeLock}. */
  readonly lock: WakeLock;
}

/** Options for {@link supervise}. Extends {@link WakeLockOptions}. */
export interface SupervisorOptions extends WakeLockOptions {
  /** Locks to register up front. */
  locks?: readonly SupervisedLock[];
  /**
   * Poll interval driving periodic re-reconciles. `number` (ms) | `"auto"`
   * (60s, and **no timer at all** when no registered lock needs polling) |
   * `() => number` (re-read each cycle). Default `"auto"`. The timer is
   * `unref()`'d so it never keeps the process alive.
   */
  poll?: number | "auto" | (() => number);
  /** Defaults merged into every added lock unless overridden. */
  defaults?: Partial<Pick<SupervisedLock, "axes" | "description" | "stale">>;
  /** Inject the underlying controller instead of building one. */
  lock?: WakeLock;
}

/** `"auto"` poll cadence. */
const AUTO_POLL_MS = 60_000;
/** Default `stale` window for `active`-bearing locks (5 min). */
const DEFAULT_STALE_MS = 5 * 60_000;
/** Default axes for a lock that doesn't declare any. */
const DEFAULT_AXES: readonly WakeAxis[] = ["system"];

/** Internal mutable lock record. */
interface Lock {
  readonly key: string;
  axes: readonly WakeAxis[];
  description?: string;
  active?: () => boolean | Promise<boolean>;
  until?: PromiseLike<unknown> | (() => boolean | Promise<boolean>);
  stale: number | false;
  maxAge?: number;
  /** `now()` at registration, for `maxAge`. */
  readonly bornAt: number;
  /** `now()` when the *current* run of `active()` errors began, else null. */
  errorSince: number | null;
  /** True once a promise-`until` has settled. */
  untilSettled: boolean;
  paused: boolean;
  evicted: boolean;
  state: LockState;
  /** The handle handed back to the caller (stable identity). */
  handle: LockHandle;
}

/** Internal restriction record. */
interface Restriction {
  readonly axis: WakeAxis;
  readonly while?: () => boolean;
  lifted: boolean;
  handle: RestrictionHandle;
}

/**
 * Create a declarative supervisor over a {@link wakeLock}. Register
 * self-managing locks (conditional / scoped / pinned), restrict axes, and let
 * the supervisor keep the OS primitive in sync — no manual acquire/release.
 */
export function supervise(opts: SupervisorOptions = {}): Supervisor {
  const now = opts.now ?? (() => Date.now());
  const logger: Logger | undefined = resolveLogger({
    logger: opts.logger,
    logLevel: opts.logLevel,
  });

  // Compose the underlying lock: use the injected one, else build from the
  // passthrough WakeLockOptions. We never own the injected lock's lifecycle
  // beyond what shutdown() does, matching the controller's discipline.
  const lock: WakeLock = opts.lock ?? wakeLock(opts);

  const locks = new Map<string, Lock>();
  const restrictions: Restriction[] = [];
  const defaults = opts.defaults ?? {};

  let anonCounter = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pollKind: number | undefined;
  let shuttingDown = false;

  // Serialize reconciles through a promise chain so a poll tick and an explicit
  // refresh()/add() never run a cycle concurrently — mirroring the controller's
  // serialized-operation discipline. The underlying lock.apply is itself
  // serialized, but we also want our per-lock bookkeeping to be race-free.
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue(op: () => Promise<void>): Promise<void> {
    const run = tail.then(op, op);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function makeKey(): string {
    let key: string;
    do {
      key = `lock-${(++anonCounter).toString(36)}`;
    } while (locks.has(key));
    return key;
  }

  function makeHandle(rec: Lock): LockHandle {
    return {
      get key() {
        return rec.key;
      },
      get axes() {
        return rec.axes;
      },
      get description() {
        return rec.description;
      },
      get state() {
        return rec.state;
      },
      pause() {
        pauseLock(rec);
      },
      resume() {
        resumeLock(rec);
      },
      remove() {
        removeLock(rec);
      },
    };
  }

  function makeRestrictionHandle(rec: Restriction): RestrictionHandle {
    return {
      get axis() {
        return rec.axis;
      },
      get active() {
        return !rec.lifted && restrictionEngaged(rec);
      },
      lift() {
        if (rec.lifted) return;
        rec.lifted = true;
        const i = restrictions.indexOf(rec);
        if (i >= 0) restrictions.splice(i, 1);
        void scheduleReconcile();
      },
    };
  }

  /** Whether a (non-lifted) restriction is masking its axis right now. */
  function restrictionEngaged(rec: Restriction): boolean {
    if (rec.lifted) return false;
    if (!rec.while) return true;
    try {
      return rec.while();
    } catch (err) {
      // A throwing `while` predicate must never break the cycle; treat it as
      // not restricting (fail-open on the restriction so locks can still hold).
      logger?.warn({ axis: rec.axis, err }, "pervigil/supervisor: restriction `while` threw");
      return false;
    }
  }

  function pauseLock(rec: Lock): void {
    if (rec.evicted || rec.paused) return;
    rec.paused = true;
    rec.state = "paused";
    rec.errorSince = null;
    void scheduleReconcile();
  }

  function resumeLock(rec: Lock): void {
    if (rec.evicted || !rec.paused) return;
    rec.paused = false;
    // Recomputed on the next reconcile; keep idle as a neutral resting state.
    rec.state = "idle";
    void scheduleReconcile();
  }

  function removeLock(rec: Lock): void {
    if (rec.evicted) return;
    evict(rec);
    void scheduleReconcile();
  }

  /** Mark a lock terminally evicted and drop it from the registry. */
  function evict(rec: Lock): void {
    rec.evicted = true;
    rec.state = "evicted";
    locks.delete(rec.key);
  }

  function add(spec: SupervisedLock): LockHandle {
    const key = spec.key ?? makeKey();
    const axes = spec.axes ?? defaults.axes ?? DEFAULT_AXES;
    const description = spec.description ?? defaults.description;
    // `stale` applies only to active-bearing locks; resolve the default for
    // those, leave it inert (false) otherwise so a pinned lock never reaps.
    const staleOpt = spec.stale ?? defaults.stale ?? DEFAULT_STALE_MS;
    const stale = spec.active ? staleOpt : false;

    const rec: Lock = {
      key,
      axes,
      description,
      active: spec.active,
      until: spec.until,
      stale,
      maxAge: spec.maxAge,
      bornAt: now(),
      errorSince: null,
      untilSettled: false,
      paused: false,
      evicted: false,
      state: "idle",
      handle: undefined as unknown as LockHandle,
    };
    rec.handle = makeHandle(rec);
    locks.set(key, rec);

    // A promise-`until` evicts on settle; wire a one-shot that flips a flag and
    // reconciles. Errors count as "settled" too (the operation is over).
    const until = spec.until;
    if (until && typeof until !== "function" && typeof until.then === "function") {
      until.then(
        () => onUntilSettled(rec),
        () => onUntilSettled(rec),
      );
    }

    void scheduleReconcile();
    return rec.handle;
  }

  function onUntilSettled(rec: Lock): void {
    if (rec.evicted) return;
    rec.untilSettled = true;
    void scheduleReconcile();
  }

  /** Does any registered lock require periodic polling? */
  function needsPolling(): boolean {
    for (const rec of locks.values()) {
      if (rec.paused) continue;
      // An `active` predicate or a *function* `until` must be re-read; a
      // promise-`until` settles via its own callback, and a pinned lock never
      // changes — neither needs the timer.
      if (rec.active) return true;
      if (typeof rec.until === "function") return true;
    }
    return false;
  }

  /** (Re)compute whether the poll timer should run, and at what cadence. */
  function syncPollTimer(): void {
    if (shuttingDown) return;
    const desired = resolvePollMs();
    if (desired === undefined) {
      stopPollTimer();
      return;
    }
    if (pollTimer !== undefined && pollKind === desired) return;
    stopPollTimer();
    pollKind = desired;
    pollTimer = setInterval(() => {
      // A function-poll may change the cadence between cycles; re-sync after the
      // reconcile so the next interval reflects the latest value.
      void scheduleReconcile().then(() => {
        if (typeof opts.poll === "function") syncPollTimer();
      });
    }, desired);
    // Never keep the event loop alive just to poll.
    pollTimer.unref?.();
  }

  /**
   * Resolve the poll interval in ms, or `undefined` to run no timer. `"auto"`
   * (the default) skips the timer entirely when nothing needs polling.
   */
  function resolvePollMs(): number | undefined {
    const poll = opts.poll ?? "auto";
    if (poll === "auto") {
      return needsPolling() ? AUTO_POLL_MS : undefined;
    }
    if (typeof poll === "function") {
      if (!needsPolling()) return undefined;
      try {
        const ms = poll();
        return ms > 0 ? ms : undefined;
      } catch (err) {
        logger?.warn({ err }, "pervigil/supervisor: poll() threw");
        return AUTO_POLL_MS;
      }
    }
    // A fixed numeric cadence always runs (the caller asked for it explicitly).
    return poll > 0 ? poll : undefined;
  }

  function stopPollTimer(): void {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      pollKind = undefined;
    }
  }

  /** Enqueue a reconcile cycle, then re-sync the poll timer. */
  function scheduleReconcile(): Promise<void> {
    return enqueue(async () => {
      await reconcile();
      syncPollTimer();
    });
  }

  /** Resolve an `until` predicate (not a promise) to "should evict?". */
  async function untilFired(rec: Lock): Promise<boolean> {
    if (rec.untilSettled) return true; // promise-until already settled
    const until = rec.until;
    if (typeof until !== "function") return false;
    try {
      return (await until()) === true;
    } catch (err) {
      // A throwing until-predicate must NOT evict; keep registered, log.
      logger?.warn({ key: rec.key, err }, "pervigil/supervisor: until() threw");
      return false;
    }
  }

  /**
   * One reconcile cycle (see the spec's algorithm):
   *   1. Evict locks whose `until` settled/returned true, or whose
   *      `maxAge`/`stale` elapsed.
   *   2. Evaluate survivors' `active` concurrently → holding / idle / unknown.
   *   3. Build the ReasonSpec set from holding + unknown (union by key).
   *   4. Subtract restricted axes.
   *   5. lock.apply(reasons) — a single reconcile.
   */
  async function reconcile(): Promise<void> {
    if (shuttingDown) return;
    const t = now();

    // ── 1. maxAge + promise-until eviction (cheap, synchronous) ────────────
    for (const rec of [...locks.values()]) {
      if (rec.maxAge !== undefined && t - rec.bornAt >= rec.maxAge) {
        evict(rec);
        continue;
      }
      if (rec.untilSettled) {
        evict(rec);
      }
    }

    // ── until-predicate eviction (async, concurrent) ───────────────────────
    const survivors = [...locks.values()].filter((r) => !r.evicted && !r.paused);
    const untilResults = await Promise.all(
      survivors.map((rec) =>
        typeof rec.until === "function" ? untilFired(rec) : Promise.resolve(false),
      ),
    );
    survivors.forEach((rec, i) => {
      if (untilResults[i]) evict(rec);
    });

    // ── 2. evaluate `active` for the remaining survivors, concurrently ─────
    const engaging = survivors.filter((r) => !r.evicted);
    await Promise.all(engaging.map((rec) => evaluate(rec, t)));

    // After evaluation, stale may have pushed some to evicted; re-filter.
    const live = engaging.filter((r) => !r.evicted);

    // ── 3 + 4. build reasons (union by key, merge axes, last desc wins),
    //          then subtract restricted axes ──────────────────────────────
    const masked = new Set<WakeAxis>();
    for (const axis of ["system", "display"] as const) {
      if (restrictions.some((r) => r.axis === axis && restrictionEngaged(r))) {
        masked.add(axis);
      }
    }

    const reasons: ReasonSpec[] = [];
    for (const rec of live) {
      if (rec.state !== "holding" && rec.state !== "unknown") continue;
      const opts2: AcquireOptions = {
        system: rec.axes.includes("system") && !masked.has("system"),
        display: rec.axes.includes("display") && !masked.has("display"),
        description: rec.description,
      };
      // Drop a lock that no axis survives the mask — nothing to assert.
      if (!opts2.system && !opts2.display) continue;
      reasons.push({ key: rec.key, ...opts2 });
    }

    // ── 5. single reconcile of the underlying lock ─────────────────────────
    await lock.apply(reasons);
  }

  /**
   * Evaluate one lock's `active`, updating its state and stale clock. A lock
   * with no `active` always engages (`holding`). A throw engages defensively
   * (`unknown`, fail-awake) and runs the stale clock; a boolean resets it.
   */
  async function evaluate(rec: Lock, t: number): Promise<void> {
    if (!rec.active) {
      rec.state = "holding";
      rec.errorSince = null;
      return;
    }
    try {
      const on = (await rec.active()) === true;
      rec.errorSince = null;
      rec.state = on ? "holding" : "idle";
    } catch (err) {
      // Fail-awake: keep the host engaged so it can recover, and run the stale
      // clock against continuous error time.
      logger?.warn({ key: rec.key, err }, "pervigil/supervisor: active() threw");
      rec.state = "unknown";
      if (rec.errorSince === null) rec.errorSince = t;
      if (rec.stale !== false && t - rec.errorSince >= rec.stale) {
        evict(rec);
      }
    }
  }

  // ── Initial locks ─────────────────────────────────────────────────────────
  for (const spec of opts.locks ?? []) add(spec);

  return {
    add,
    get(key) {
      return locks.get(key)?.handle;
    },
    list() {
      return [...locks.values()].map((r) => r.handle);
    },
    remove(key) {
      const rec = locks.get(key);
      if (rec) removeLock(rec);
    },
    pause(key) {
      const rec = locks.get(key);
      if (rec) pauseLock(rec);
    },
    resume(key) {
      const rec = locks.get(key);
      if (rec) resumeLock(rec);
    },
    restrict(axis, o = {}) {
      const rec: Restriction = {
        axis,
        while: o.while,
        lifted: false,
        handle: undefined as unknown as RestrictionHandle,
      };
      rec.handle = makeRestrictionHandle(rec);
      restrictions.push(rec);
      void scheduleReconcile();
      return rec.handle;
    },
    allow(axis) {
      for (const rec of restrictions.filter((r) => r.axis === axis)) {
        rec.lifted = true;
      }
      for (let i = restrictions.length - 1; i >= 0; i--) {
        if (restrictions[i]!.axis === axis) restrictions.splice(i, 1);
      }
      void scheduleReconcile();
    },
    restrictions() {
      return restrictions.map((r) => r.handle);
    },
    refresh() {
      return scheduleReconcile();
    },
    status() {
      return lock.status();
    },
    async shutdown() {
      shuttingDown = true;
      stopPollTimer();
      for (const rec of [...locks.values()]) evict(rec);
      // Let any in-flight reconcile settle, then tear down the lock.
      await tail.catch(() => undefined);
      await lock.shutdown();
    },
    lock,
  };
}
