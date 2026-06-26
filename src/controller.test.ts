import { describe, it, expect, beforeEach } from "vitest";
import { wakeLock } from "./controller.js";
import { WakeLockUnavailableError } from "./errors.js";
import { runExitCleanup } from "./internal/exit-cleanup.js";
import { MockDriver } from "./drivers/mock.js";
import { NoopDriver } from "./drivers/noop.js";
import type { DegradedReason, Driver, WakeLockState } from "./types.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A driver whose `setState`/`shutdown` resolve only after a macrotask delay,
 * and which tracks how many `setState` calls are in flight at once. If the
 * controller did not serialize, overlapping calls would push
 * `maxConcurrentSetState` above 1 and leave torn state behind.
 */
class DelayedDriver implements Driver {
  readonly platform = "delayed";
  readonly available = true;
  readonly degradedReason: DegradedReason = null;
  readonly restarts = 0;

  readonly setStateCalls: { state: WakeLockState; description: string }[] = [];
  private inFlight = 0;
  maxConcurrentSetState = 0;

  async setState(state: WakeLockState, description: string): Promise<void> {
    this.inFlight += 1;
    this.maxConcurrentSetState = Math.max(this.maxConcurrentSetState, this.inFlight);
    await tick();
    this.setStateCalls.push({ state, description });
    this.inFlight -= 1;
  }

  async shutdown(): Promise<void> {
    await tick();
  }
}

/** A driver that can be told to reject its next `setState`. */
class FlakyDriver implements Driver {
  readonly platform = "flaky";
  readonly available = true;
  readonly degradedReason: DegradedReason = null;
  readonly restarts = 0;

  failNext = false;

  async setState(): Promise<void> {
    await tick();
    if (this.failNext) {
      this.failNext = false;
      throw new Error("boom");
    }
  }

  async shutdown(): Promise<void> {
    await tick();
  }
}

describe("wakeLock", () => {
  let driver: MockDriver;

  beforeEach(() => {
    driver = new MockDriver();
  });

  it("acquire(system) engages the system axis only", async () => {
    const wl = wakeLock({ driver });
    await wl.acquire("job", { system: true, description: "import" });

    const s = wl.status();
    expect(s.engaged).toEqual({ system: true, display: false });
    expect(s.platform).toBe("mock");
    expect(s.available).toBe(true);
    expect(s.reasons.system.map((r) => r.key)).toEqual(["job"]);
  });

  it("defaults to the system axis only", async () => {
    const wl = wakeLock({ driver });
    await wl.acquire("job");
    expect(wl.status().engaged).toEqual({ system: true, display: false });
  });

  it("holds are independent — releasing one keeps the other", async () => {
    const wl = wakeLock({ driver });
    await wl.acquire("job", { system: true });
    await wl.acquire("view", { display: true });
    expect(wl.status().engaged).toEqual({ system: true, display: true });

    await wl.release("job");
    expect(wl.status().engaged).toEqual({ system: false, display: true });
  });

  it("releasing an unknown key is a no-op", async () => {
    const wl = wakeLock({ driver });
    await wl.release("nope");
    expect(driver.setStateCalls).toHaveLength(0);
  });

  it("counts engageTransitions as false→true edges", async () => {
    const wl = wakeLock({ driver });
    await wl.acquire("a", { system: true });
    await wl.release("a");
    await wl.acquire("b", { system: true });
    expect(wl.status().counters.engageTransitions.system).toBe(2);
  });

  it("accumulates awakeMsTotal across the hold using an injected clock", async () => {
    let t = 1000;
    const wl = wakeLock({ driver, now: () => t });
    await wl.acquire("a", { system: true });
    t = 1500;
    await wl.release("a");
    expect(wl.status().counters.awakeMsTotal.system).toBe(500);
  });

  it("status() includes the live (not-yet-released) span", async () => {
    let t = 1000;
    const wl = wakeLock({ driver, now: () => t });
    await wl.acquire("a", { system: true });
    t = 1200;
    expect(wl.status().counters.awakeMsTotal.system).toBe(200);
  });

  it("emits engaged then disengaged", async () => {
    const wl = wakeLock({ driver });
    const events: string[] = [];
    wl.on("engaged", () => events.push("engaged"));
    wl.on("disengaged", () => events.push("disengaged"));
    await wl.acquire("a", { system: true });
    await wl.release("a");
    expect(events).toEqual(["engaged", "disengaged"]);
  });

  it("on() returns a working unsubscribe", async () => {
    const wl = wakeLock({ driver });
    let n = 0;
    const off = wl.on("engaged", () => {
      n += 1;
    });
    off();
    await wl.acquire("a", { system: true });
    expect(n).toBe(0);
  });

  it("surfaces a degraded driver via status() and the degraded event", async () => {
    const wl = wakeLock({ driver: new NoopDriver("container") });
    const seen: string[] = [];
    wl.on("degraded", () => seen.push("degraded"));
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(seen).toEqual(["degraded"]);
    const s = wl.status();
    expect(s.available).toBe(false);
    expect(s.degradedReason).toBe("container");
  });

  it("shutdown tears down the driver", async () => {
    const wl = wakeLock({ driver });
    await wl.acquire("a", { system: true });
    await wl.shutdown();
    expect(driver.shutdownCalls.length).toBeGreaterThan(0);
  });

  it("a both-axes acquire from idle makes exactly one setState with no intermediate state", async () => {
    const wl = wakeLock({ driver });
    await wl.acquire("job", { system: true, display: true, description: "import" });

    expect(driver.setStateCalls).toHaveLength(1);
    expect(driver.setStateCalls[0]!.state).toEqual({ system: true, display: true });
    // The buggy two-call reconcile would pass through {system:true, display:false}.
    expect(
      driver.setStateCalls.some((c) => c.state.system === true && c.state.display === false),
    ).toBe(false);
  });

  it("serializes concurrent acquire/release so the final state is deterministic", async () => {
    // A driver whose I/O is deliberately delayed, so un-serialized operations
    // would interleave with an in-flight setState and tear state apart.
    const delayed = new DelayedDriver();
    const wl = wakeLock({ driver: delayed });

    // Fire several overlapping ops WITHOUT awaiting between them.
    const ops = [
      wl.acquire("a", { system: true }),
      wl.acquire("b", { display: true }),
      wl.release("a"),
      wl.acquire("c", { system: true }),
    ];
    await Promise.all(ops);

    // Final desired state: b (display) + c (system) held, a released.
    expect(wl.status().engaged).toEqual({ system: true, display: true });
    expect(
      wl
        .status()
        .reasons.system.map((r) => r.key)
        .sort(),
    ).toEqual(["c"]);
    expect(
      wl
        .status()
        .reasons.display.map((r) => r.key)
        .sort(),
    ).toEqual(["b"]);

    // No setState ran while another was still in flight (no torn intermediate).
    expect(delayed.maxConcurrentSetState).toBe(1);
    // The last reconciled state the driver saw matches the final engaged state.
    expect(delayed.setStateCalls.at(-1)!.state).toEqual({ system: true, display: true });
  });

  it("a rejected op does not break the queue for subsequent ops", async () => {
    const flaky = new FlakyDriver();
    const wl = wakeLock({ driver: flaky });

    flaky.failNext = true;
    const failing = wl.acquire("bad", { system: true });
    const following = wl.acquire("good", { display: true });

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBeUndefined();

    expect(wl.status().reasons.display.map((r) => r.key)).toEqual(["good"]);
    expect(wl.status().engaged.display).toBe(true);
  });

  it("fires primitiveDied + bumps primitiveRestarts for an INJECTED driver", async () => {
    const wl = wakeLock({ driver });
    const seen: string[] = [];
    wl.on("primitiveDied", () => seen.push("primitiveDied"));

    await wl.acquire("a", { system: true });
    driver.simulatePrimitiveDeath();

    expect(seen).toEqual(["primitiveDied"]);
    expect(wl.status().counters.primitiveRestarts).toBe(1);
  });

  describe("apply (declarative bulk reconcile)", () => {
    it("holds every key in the new set with its per-axis defaults", async () => {
      const wl = wakeLock({ driver });
      await wl.apply([
        { key: "a", system: true },
        { key: "b", display: true },
        { key: "c" }, // neither axis specified ⇒ system only, like acquire
      ]);

      const s = wl.status();
      expect(s.reasons.system.map((r) => r.key).sort()).toEqual(["a", "c"]);
      expect(s.reasons.display.map((r) => r.key).sort()).toEqual(["b"]);
      expect(s.engaged).toEqual({ system: true, display: true });
    });

    it("a both-axes apply from idle makes exactly one driver setState", async () => {
      const wl = wakeLock({ driver });
      await wl.apply([
        { key: "a", system: true },
        { key: "b", display: true },
      ]);

      expect(driver.setStateCalls).toHaveLength(1);
      expect(driver.setStateCalls[0]!.state).toEqual({ system: true, display: true });
      // The buggy per-key reconcile would pass through {system:true, display:false}.
      expect(
        driver.setStateCalls.some((c) => c.state.system === true && c.state.display === false),
      ).toBe(false);
    });

    it("releases keys not present in the new set", async () => {
      const wl = wakeLock({ driver });
      await wl.acquire("old", { system: true });
      await wl.apply([{ key: "new", system: true }]);

      const s = wl.status();
      expect(s.reasons.system.map((r) => r.key)).toEqual(["new"]);
    });

    it("an empty set releases everything", async () => {
      const wl = wakeLock({ driver });
      await wl.acquire("a", { system: true, display: true });
      await wl.apply([]);
      expect(wl.status().engaged).toEqual({ system: false, display: false });
    });

    it("is idempotent — applying the same set twice does not churn the driver", async () => {
      const wl = wakeLock({ driver });
      const set = [
        { key: "a", system: true },
        { key: "b", display: true },
      ];
      await wl.apply(set);
      const callsAfterFirst = driver.setStateCalls.length;
      await wl.apply(set);
      expect(driver.setStateCalls.length).toBe(callsAfterFirst);
    });

    it("uses the description like acquire (falls back to the key)", async () => {
      const wl = wakeLock({ driver });
      await wl.apply([
        { key: "a", system: true, description: "import" },
        { key: "b", system: true },
      ]);
      const s = wl.status();
      const byKey = new Map(s.reasons.system.map((r) => [r.key, r.description]));
      expect(byKey.get("a")).toBe("import");
      expect(byKey.get("b")).toBe("b");
    });

    it("emits reasonsChanged once for an apply", async () => {
      const wl = wakeLock({ driver });
      const events: string[] = [];
      wl.on("reasonsChanged", () => events.push("reasonsChanged"));
      await wl.apply([{ key: "a", system: true }]);
      expect(events).toEqual(["reasonsChanged"]);
    });

    it("is serialized with acquire/release", async () => {
      const delayed = new DelayedDriver();
      const wl = wakeLock({ driver: delayed });
      const ops = [wl.acquire("x", { system: true }), wl.apply([{ key: "y", display: true }])];
      await Promise.all(ops);
      // apply replaces the whole set, so only "y" (display) survives.
      expect(wl.status().reasons.system.map((r) => r.key)).toEqual([]);
      expect(wl.status().reasons.display.map((r) => r.key)).toEqual(["y"]);
      expect(delayed.maxConcurrentSetState).toBe(1);
    });
  });

  describe("onEvent telemetry hook", () => {
    it("fires for every lifecycle event with (event, status)", async () => {
      const events: { event: string; engaged: WakeLockState }[] = [];
      const wl = wakeLock({
        driver,
        onEvent: (event, status) => events.push({ event, engaged: status.engaged }),
      });

      await wl.acquire("job", { system: true });
      await wl.release("job");

      const names = events.map((e) => e.event);
      // acquire: engine flips system on (engaged) then acquire emits reasonsChanged;
      // release: engine flips system off (disengaged) then reasonsChanged.
      expect(names).toEqual(["engaged", "reasonsChanged", "disengaged", "reasonsChanged"]);
      // The snapshot reflects the state at emit time.
      expect(events[0]!.engaged).toEqual({ system: true, display: false });
      expect(events[3]!.engaged).toEqual({ system: false, display: false });
    });

    it("fires for primitiveDied", async () => {
      const seen: string[] = [];
      const wl = wakeLock({ driver, onEvent: (event) => seen.push(event) });
      await wl.acquire("a", { system: true });
      driver.simulatePrimitiveDeath();
      expect(seen).toContain("primitiveDied");
    });

    it("fires 'degraded' for an unavailable driver", async () => {
      const seen: string[] = [];
      wakeLock({
        driver: new NoopDriver("forced"),
        onEvent: (event) => seen.push(event),
      });
      // `degraded` is surfaced on a microtask so callers can attach listeners
      // synchronously after construction; flush the queue.
      await tick();
      expect(seen).toContain("degraded");
    });

    it("a throwing onEvent never breaks the lock and still notifies .on listeners", async () => {
      const seen: string[] = [];
      const wl = wakeLock({
        driver,
        onEvent: () => {
          throw new Error("telemetry backend down");
        },
      });
      wl.on("engaged", () => seen.push("engaged"));

      await expect(wl.acquire("job", { system: true })).resolves.toBeUndefined();
      expect(wl.status().engaged.system).toBe(true);
      expect(seen).toEqual(["engaged"]);
    });
  });

  describe("status().active", () => {
    it("is false before anything is acquired", () => {
      expect(wakeLock({ driver }).status().active).toBe(false);
    });

    it("is true while a reason is held on an available driver", async () => {
      const wl = wakeLock({ driver });
      await wl.acquire("job", { system: true });
      expect(wl.status().active).toBe(true);
    });

    it("is false on a degraded driver even though a reason is engaged (intent ≠ reality)", async () => {
      const wl = wakeLock({ driver: new NoopDriver("container") });
      await wl.acquire("job", { system: true });
      expect(wl.status().engaged.system).toBe(true); // intent
      expect(wl.status().available).toBe(false);
      expect(wl.status().active).toBe(false); // reality
    });

    it("goes false when the primitive dies, then true again after re-engage", async () => {
      const wl = wakeLock({ driver });
      await wl.acquire("job", { system: true });
      expect(wl.status().active).toBe(true);

      driver.simulatePrimitiveDeath();
      expect(wl.status().active).toBe(false); // dropped, not yet re-engaged
      expect(wl.status().engaged.system).toBe(true); // still desired

      await wl.acquire("job2", { system: true }); // next change re-engages
      expect(wl.status().active).toBe(true);
    });

    it("falls back to available && engaged for a driver that does not report `held`", async () => {
      const bare: Driver = {
        platform: "bare",
        available: true,
        degradedReason: null,
        setState: async () => undefined,
        shutdown: async () => undefined,
      };
      const wl = wakeLock({ driver: bare });
      expect(wl.status().active).toBe(false);
      await wl.acquire("a", { system: true });
      expect(wl.status().active).toBe(true);
    });
  });

  describe("strict mode", () => {
    it("acquire rejects with WakeLockUnavailableError on a degraded driver", async () => {
      const wl = wakeLock({ driver: new NoopDriver("container"), strict: true });
      await expect(wl.acquire("job", { system: true })).rejects.toBeInstanceOf(
        WakeLockUnavailableError,
      );
    });

    it("the rejection carries degradedReason and platform", async () => {
      const wl = wakeLock({ driver: new NoopDriver("container"), strict: true });
      const err = await wl.acquire("job", { system: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WakeLockUnavailableError);
      expect((err as WakeLockUnavailableError).degradedReason).toBe("container");
      expect((err as WakeLockUnavailableError).platform).toBe("noop");
    });

    it("does not record the hold when it rejects", async () => {
      const wl = wakeLock({ driver: new NoopDriver("container"), strict: true });
      await wl.acquire("job", { system: true }).catch(() => undefined);
      expect(wl.status().engaged.system).toBe(false);
      expect(wl.status().reasons.system).toHaveLength(0);
    });

    it("acquire succeeds normally when the driver is available", async () => {
      const wl = wakeLock({ driver, strict: true });
      await expect(wl.acquire("job", { system: true })).resolves.toBeUndefined();
      expect(wl.status().active).toBe(true);
    });

    it("a later op still runs after a strict rejection (queue not broken)", async () => {
      const wl = wakeLock({ driver: new NoopDriver("container"), strict: true });
      await wl.acquire("bad", { system: true }).catch(() => undefined);
      // The controller stays usable; release of an unknown key is a clean no-op.
      await expect(wl.release("bad")).resolves.toBeUndefined();
    });

    it("non-strict acquire on a degraded driver resolves (no throw) and is inactive", async () => {
      const wl = wakeLock({ driver: new NoopDriver("container") });
      await expect(wl.acquire("job", { system: true })).resolves.toBeUndefined();
      expect(wl.status().active).toBe(false);
    });
  });

  describe("autoRelease on process exit", () => {
    it("releases the driver on exit by default", async () => {
      const wl = wakeLock({ driver });
      await wl.acquire("a", { system: true });
      expect(driver.shutdownCalls.length).toBe(0);

      runExitCleanup(); // simulate process exit

      expect(driver.shutdownCalls.length).toBe(1);
      await wl.shutdown();
    });

    it("does not fire after the lock is shut down (unregistered)", async () => {
      const wl = wakeLock({ driver });
      await wl.acquire("a", { system: true });
      await wl.shutdown();
      const after = driver.shutdownCalls.length;

      runExitCleanup();

      expect(driver.shutdownCalls.length).toBe(after); // no extra teardown
    });

    it("autoRelease:false opts out — no teardown on exit", async () => {
      const wl = wakeLock({ driver, autoRelease: false });
      await wl.acquire("a", { system: true });

      runExitCleanup();

      expect(driver.shutdownCalls.length).toBe(0);
      await wl.shutdown();
    });
  });
});
