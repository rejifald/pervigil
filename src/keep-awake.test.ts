import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { keepAwake } from "./keep-awake.js";
import { WakeLockUnavailableError } from "./errors.js";
import { MockDriver } from "./drivers/mock.js";
import type { Driver } from "./types.js";

/** A driver that is degraded (never holds) but tracks shutdown calls. */
function deadDriver(): Driver & { shutdowns: number } {
  const d = {
    platform: "noop",
    available: false,
    degradedReason: "container" as const,
    shutdowns: 0,
    setState: async () => undefined,
    shutdown: async () => {
      d.shutdowns += 1;
    },
  };
  return d;
}

describe("keepAwake", () => {
  let driver: MockDriver;

  beforeEach(() => {
    driver = new MockDriver();
  });

  it("acquires on call and releases on handle.release()", async () => {
    const lock = await keepAwake({ system: true, description: "backup", driver });
    expect(driver.engageTransitions).toBe(1);
    expect(driver.setStateCalls[0]!.description).toBe("backup");

    await lock.release();
    expect(driver.shutdownCalls.length).toBeGreaterThan(0);
  });

  it("strict: rejects and tears the controller down when the host can't be kept awake", async () => {
    const dead = deadDriver();
    await expect(keepAwake({ strict: true, driver: dead })).rejects.toBeInstanceOf(
      WakeLockUnavailableError,
    );
    // No leaked controller — it was shut down before the error propagated.
    expect(dead.shutdowns).toBe(1);
  });

  it("non-strict on a degraded driver resolves but reports inactive", async () => {
    const lock = await keepAwake({ driver: deadDriver() });
    expect(lock.status().active).toBe(false);
    expect(lock.status().available).toBe(false);
    await lock.release();
  });

  it("defaults to the system axis only", async () => {
    const lock = await keepAwake({ driver });
    expect(driver.setStateCalls[0]!.state).toEqual({ system: true, display: false });
    await lock.release();
  });

  it("display:true (system:false) engages the display axis only", async () => {
    const lock = await keepAwake({ display: true, system: false, driver });
    expect(driver.setStateCalls[0]!.state).toEqual({ system: false, display: true });
    await lock.release();
  });

  it("while() holds for the duration and releases afterwards", async () => {
    let engagedDuring = false;
    const result = await keepAwake.while({ system: true, driver }, () => {
      engagedDuring = driver.setStateCalls.at(-1)!.state.system;
      return 42;
    });
    expect(result).toBe(42);
    expect(engagedDuring).toBe(true);
    expect(driver.shutdownCalls.length).toBeGreaterThan(0);
  });

  it("while() releases even when the callback throws", async () => {
    await expect(
      keepAwake.while({ system: true, driver }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(driver.shutdownCalls.length).toBeGreaterThan(0);
  });

  it("handle.status() reports the driver platform", async () => {
    const lock = await keepAwake({ driver });
    expect(lock.status().platform).toBe("mock");
    await lock.release();
  });

  it("supports Symbol.asyncDispose", async () => {
    const lock = await keepAwake({ driver });
    expect(typeof lock[Symbol.asyncDispose]).toBe("function");
    await lock[Symbol.asyncDispose]();
    expect(driver.shutdownCalls.length).toBeGreaterThan(0);
  });
});

describe("keepAwake.for / keepAwake.until", () => {
  let driver: MockDriver;

  beforeEach(() => {
    driver = new MockDriver();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("for() engages immediately and auto-releases after the duration", async () => {
    const lock = await keepAwake.for({ system: true, driver }, 1000);
    // Engaged immediately — exactly one false→true edge.
    expect(driver.engageTransitions).toBe(1);
    expect(driver.shutdownCalls.length).toBe(0);
    expect(lock.status().platform).toBe("mock");

    await vi.advanceTimersByTimeAsync(1000);
    // Fired exactly once.
    expect(driver.shutdownCalls.length).toBe(1);
  });

  it("for() does not release before the deadline", async () => {
    await keepAwake.for({ system: true, driver }, 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(driver.shutdownCalls.length).toBe(0);
  });

  it("manual release() before the deadline releases once and cancels the timer", async () => {
    const lock = await keepAwake.for({ system: true, driver }, 1000);

    await lock.release();
    expect(driver.shutdownCalls.length).toBe(1);

    // Advancing past the deadline must NOT release again (timer was cleared).
    await vi.advanceTimersByTimeAsync(2000);
    expect(driver.shutdownCalls.length).toBe(1);
  });

  it("release() is idempotent", async () => {
    const lock = await keepAwake.for({ system: true, driver }, 1000);
    await lock.release();
    await lock.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(driver.shutdownCalls.length).toBe(1);
  });

  it("Symbol.asyncDispose on a for() handle also cancels the timer", async () => {
    const lock = await keepAwake.for({ system: true, driver }, 1000);
    await lock[Symbol.asyncDispose]();
    expect(driver.shutdownCalls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(driver.shutdownCalls.length).toBe(1);
  });

  it("until() releases around the deadline", async () => {
    const when = new Date(Date.now() + 500);
    await keepAwake.until({ system: true, driver }, when);
    expect(driver.engageTransitions).toBe(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(driver.shutdownCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(driver.shutdownCalls.length).toBe(1);
  });

  it("until() with a past date releases on the next tick", async () => {
    const when = new Date(Date.now() - 5000);
    await keepAwake.until({ system: true, driver }, when);
    expect(driver.shutdownCalls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(driver.shutdownCalls.length).toBe(1);
  });
});

describe("keepAwake.shared", () => {
  // shared() takes no controller config by design, so it always builds the real
  // default driver. Force the no-op driver to keep these unit tests from
  // spawning a real OS primitive; coalescing is asserted via the controller's
  // own status() counters, which are driver-independent.
  beforeEach(() => {
    vi.stubEnv("PERVIGIL_FORCE_NOOP", "1");
  });

  afterEach(async () => {
    await keepAwake.shutdownShared();
    vi.unstubAllEnvs();
  });

  it("coalesces overlapping simple locks onto a single controller", async () => {
    const a = await keepAwake.shared({ system: true });
    const b = await keepAwake.shared({ system: true });

    // Both holds ride on a single false→true edge of one shared controller.
    expect(b.status().counters.engageTransitions.system).toBe(1);

    // Releasing one keeps the shared axis engaged.
    await a.release();
    expect(b.status().engaged.system).toBe(true);
    expect(b.status().counters.engageTransitions.system).toBe(1);

    // Releasing the last hold disengages the axis.
    await b.release();
    expect(b.status().engaged.system).toBe(false);
  });

  it("uses a UNIQUE key per call so concurrent holds do not clobber each other", async () => {
    const a = await keepAwake.shared({ system: true });
    const b = await keepAwake.shared({ system: true });

    const reasons = b.status().reasons.system.map((r) => r.key);
    expect(new Set(reasons).size).toBe(2);

    await a.release();
    await b.release();
  });

  it("release() removes only that key and is idempotent", async () => {
    const a = await keepAwake.shared({ system: true });
    const b = await keepAwake.shared({ system: true });

    await a.release();
    await a.release();
    // Still one hold remaining; the shared controller never shut down.
    expect(b.status().reasons.system.length).toBe(1);

    await b.release();
  });

  it("ignores controller config — the shared instance is always default", async () => {
    // `shared()` only accepts per-call axes; there is no first-caller-wins
    // config surprise. The platform reflects the default (here forced-noop)
    // driver, never an injected one.
    const a = await keepAwake.shared({ system: true });
    expect(a.status().platform).toBe("noop");
    await a.release();
  });

  it("shutdownShared() tears down the shared instance for a clean slate", async () => {
    const a = await keepAwake.shared({ system: true });
    expect(a.status().engaged.system).toBe(true);

    await keepAwake.shutdownShared();

    // A fresh shared instance starts from zero — its own first false→true edge.
    const b = await keepAwake.shared({ system: true });
    expect(b.status().counters.engageTransitions.system).toBe(1);
    await b.release();
  });
});
