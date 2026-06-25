import { describe, it, expect, beforeEach } from "vitest";
import { createWakeLock } from "./controller.js";
import { MockWakeLockDriver } from "./drivers/mock.js";
import { NoopWakeLockDriver } from "./drivers/noop.js";
import type { DegradedReason, WakeLockDriver, WakeLockState } from "./types.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A driver whose `setState`/`shutdown` resolve only after a macrotask delay,
 * and which tracks how many `setState` calls are in flight at once. If the
 * controller did not serialize, overlapping calls would push
 * `maxConcurrentSetState` above 1 and leave torn state behind.
 */
class DelayedDriver implements WakeLockDriver {
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
class FlakyDriver implements WakeLockDriver {
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

describe("createWakeLock", () => {
  let driver: MockWakeLockDriver;

  beforeEach(() => {
    driver = new MockWakeLockDriver();
  });

  it("acquire(system) engages the system axis only", async () => {
    const wl = createWakeLock({ driver });
    await wl.acquire("job", { system: true, description: "import" });

    const s = wl.status();
    expect(s.engaged).toEqual({ system: true, display: false });
    expect(s.platform).toBe("mock");
    expect(s.available).toBe(true);
    expect(s.reasons.system.map((r) => r.key)).toEqual(["job"]);
  });

  it("defaults to the system axis only", async () => {
    const wl = createWakeLock({ driver });
    await wl.acquire("job");
    expect(wl.status().engaged).toEqual({ system: true, display: false });
  });

  it("holds are independent — releasing one keeps the other", async () => {
    const wl = createWakeLock({ driver });
    await wl.acquire("job", { system: true });
    await wl.acquire("view", { display: true });
    expect(wl.status().engaged).toEqual({ system: true, display: true });

    await wl.release("job");
    expect(wl.status().engaged).toEqual({ system: false, display: true });
  });

  it("releasing an unknown key is a no-op", async () => {
    const wl = createWakeLock({ driver });
    await wl.release("nope");
    expect(driver.setStateCalls).toHaveLength(0);
  });

  it("counts engageTransitions as false→true edges", async () => {
    const wl = createWakeLock({ driver });
    await wl.acquire("a", { system: true });
    await wl.release("a");
    await wl.acquire("b", { system: true });
    expect(wl.status().counters.engageTransitions.system).toBe(2);
  });

  it("accumulates awakeMsTotal across the hold using an injected clock", async () => {
    let t = 1000;
    const wl = createWakeLock({ driver, now: () => t });
    await wl.acquire("a", { system: true });
    t = 1500;
    await wl.release("a");
    expect(wl.status().counters.awakeMsTotal.system).toBe(500);
  });

  it("status() includes the live (not-yet-released) span", async () => {
    let t = 1000;
    const wl = createWakeLock({ driver, now: () => t });
    await wl.acquire("a", { system: true });
    t = 1200;
    expect(wl.status().counters.awakeMsTotal.system).toBe(200);
  });

  it("emits engaged then disengaged", async () => {
    const wl = createWakeLock({ driver });
    const events: string[] = [];
    wl.on("engaged", () => events.push("engaged"));
    wl.on("disengaged", () => events.push("disengaged"));
    await wl.acquire("a", { system: true });
    await wl.release("a");
    expect(events).toEqual(["engaged", "disengaged"]);
  });

  it("on() returns a working unsubscribe", async () => {
    const wl = createWakeLock({ driver });
    let n = 0;
    const off = wl.on("engaged", () => {
      n += 1;
    });
    off();
    await wl.acquire("a", { system: true });
    expect(n).toBe(0);
  });

  it("surfaces a degraded driver via status() and the degraded event", async () => {
    const wl = createWakeLock({ driver: new NoopWakeLockDriver("container") });
    const seen: string[] = [];
    wl.on("degraded", () => seen.push("degraded"));
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(seen).toEqual(["degraded"]);
    const s = wl.status();
    expect(s.available).toBe(false);
    expect(s.degradedReason).toBe("container");
  });

  it("shutdown tears down the driver", async () => {
    const wl = createWakeLock({ driver });
    await wl.acquire("a", { system: true });
    await wl.shutdown();
    expect(driver.shutdownCalls.length).toBeGreaterThan(0);
  });

  it("a both-axes acquire from idle makes exactly one setState with no intermediate state", async () => {
    const wl = createWakeLock({ driver });
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
    const wl = createWakeLock({ driver: delayed });

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
    const wl = createWakeLock({ driver: flaky });

    flaky.failNext = true;
    const failing = wl.acquire("bad", { system: true });
    const following = wl.acquire("good", { display: true });

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBeUndefined();

    expect(wl.status().reasons.display.map((r) => r.key)).toEqual(["good"]);
    expect(wl.status().engaged.display).toBe(true);
  });

  it("fires primitiveDied + bumps primitiveRestarts for an INJECTED driver", async () => {
    const wl = createWakeLock({ driver });
    const seen: string[] = [];
    wl.on("primitiveDied", () => seen.push("primitiveDied"));

    await wl.acquire("a", { system: true });
    driver.simulatePrimitiveDeath();

    expect(seen).toEqual(["primitiveDied"]);
    expect(wl.status().counters.primitiveRestarts).toBe(1);
  });

  describe("onEvent telemetry hook", () => {
    it("fires for every lifecycle event with (event, status)", async () => {
      const events: { event: string; engaged: WakeLockState }[] = [];
      const wl = createWakeLock({
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
      const wl = createWakeLock({ driver, onEvent: (event) => seen.push(event) });
      await wl.acquire("a", { system: true });
      driver.simulatePrimitiveDeath();
      expect(seen).toContain("primitiveDied");
    });

    it("fires 'degraded' for an unavailable driver", async () => {
      const seen: string[] = [];
      createWakeLock({
        driver: new NoopWakeLockDriver("forced"),
        onEvent: (event) => seen.push(event),
      });
      // `degraded` is surfaced on a microtask so callers can attach listeners
      // synchronously after construction; flush the queue.
      await tick();
      expect(seen).toContain("degraded");
    });

    it("a throwing onEvent never breaks the lock and still notifies .on listeners", async () => {
      const seen: string[] = [];
      const wl = createWakeLock({
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
});
