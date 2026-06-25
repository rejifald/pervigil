import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { keepAwake } from "./keep-awake.js";
import { MockWakeLockDriver } from "./drivers/mock.js";

describe("keepAwake", () => {
  let driver: MockWakeLockDriver;

  beforeEach(() => {
    driver = new MockWakeLockDriver();
  });

  it("acquires on call and releases on handle.release()", async () => {
    const lock = await keepAwake({ system: true, reason: "backup", driver });
    expect(driver.engageTransitions).toBe(1);
    expect(driver.setStateCalls[0]!.description).toBe("backup");

    await lock.release();
    expect(driver.shutdownCalls.length).toBeGreaterThan(0);
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
  let driver: MockWakeLockDriver;

  beforeEach(() => {
    driver = new MockWakeLockDriver();
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
  let driver: MockWakeLockDriver;

  beforeEach(() => {
    driver = new MockWakeLockDriver();
  });

  afterEach(async () => {
    await keepAwake.shutdownShared();
  });

  it("coalesces overlapping simple locks onto a single OS primitive", async () => {
    const a = await keepAwake.shared({ system: true, driver });
    const b = await keepAwake.shared({ system: true, driver });

    // Both holds ride on a single false→true edge.
    expect(driver.engageTransitions).toBe(1);

    // Releasing one keeps the shared primitive engaged.
    await a.release();
    expect(driver.shutdownCalls.length).toBe(0);
    expect(driver.engageTransitions).toBe(1);

    // Releasing the last hold disengages the axis.
    await b.release();
    expect(driver.disengageCalls.length).toBe(1);
  });

  it("uses a UNIQUE key per call so concurrent holds do not clobber each other", async () => {
    const a = await keepAwake.shared({ system: true, driver });
    const b = await keepAwake.shared({ system: true, driver });

    const reasons = b.status().reasons.system.map((r) => r.key);
    expect(new Set(reasons).size).toBe(2);

    await a.release();
    await b.release();
  });

  it("release() removes only that key and is idempotent", async () => {
    const a = await keepAwake.shared({ system: true, driver });
    const b = await keepAwake.shared({ system: true, driver });

    await a.release();
    await a.release();
    // Still one hold remaining, shared controller never shut down.
    expect(driver.shutdownCalls.length).toBe(0);
    expect(b.status().reasons.system.length).toBe(1);

    await b.release();
  });

  it("configures the shared controller from the first call's options", async () => {
    const first = new MockWakeLockDriver();
    const second = new MockWakeLockDriver();

    const a = await keepAwake.shared({ system: true, driver: first });
    const b = await keepAwake.shared({ system: true, driver: second });

    // The second call's driver is ignored; everything rides on `first`.
    expect(first.engageTransitions).toBe(1);
    expect(second.setStateCalls.length).toBe(0);

    await a.release();
    await b.release();
  });

  it("shutdownShared() tears down the shared instance for a clean slate", async () => {
    const first = new MockWakeLockDriver();
    await keepAwake.shared({ system: true, driver: first });
    await keepAwake.shutdownShared();
    expect(first.shutdownCalls.length).toBe(1);

    // A fresh shared instance can be configured by a new first caller.
    const second = new MockWakeLockDriver();
    const b = await keepAwake.shared({ system: true, driver: second });
    expect(second.engageTransitions).toBe(1);
    await b.release();
  });
});
