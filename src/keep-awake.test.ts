import { describe, it, expect, beforeEach } from "vitest";
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
