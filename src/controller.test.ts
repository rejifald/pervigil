import { describe, it, expect, beforeEach } from "vitest";
import { createWakeLock } from "./controller.js";
import { MockWakeLockDriver } from "./drivers/mock.js";
import { NoopWakeLockDriver } from "./drivers/noop.js";

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
});
