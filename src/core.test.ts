import { describe, it, expect, beforeEach } from "vitest";
import { WakeLockEngine } from "./core.js";
import { MockDriver } from "./drivers/mock.js";
import type { WakeReason } from "./types.js";

function reason(key: string, description?: string): WakeReason {
  return { key, description };
}

describe("WakeLockEngine", () => {
  let driver: MockDriver;
  let engine: WakeLockEngine;

  beforeEach(() => {
    driver = new MockDriver();
    engine = new WakeLockEngine(driver);
  });

  it("applyAxis(system,[r]) engages system only", async () => {
    await engine.applyAxis("system", [reason("job", "import")]);
    expect(driver.setStateCalls).toHaveLength(1);
    expect(driver.setStateCalls[0]!.state).toEqual({ system: true, display: false });
    expect(driver.setStateCalls[0]!.description).toBe("import");
  });

  it("applyAxis(system,[]) on engaged → disengage", async () => {
    await engine.applyAxis("system", [reason("job", "import")]);
    await engine.applyAxis("system", []);
    expect(driver.disengageCalls).toHaveLength(1);
    expect(driver.setStateCalls.at(-1)!.state).toEqual({ system: false, display: false });
  });

  it("falls back to the key when no description is given", async () => {
    await engine.applyAxis("system", [reason("job:42")]);
    expect(driver.setStateCalls[0]!.description).toBe("job:42");
  });

  it("system + display are independent", async () => {
    await engine.applyAxis("system", [reason("job", "import")]);
    await engine.applyAxis("display", [reason("view", "live view")]);
    expect(driver.setStateCalls.at(-1)!.state).toEqual({ system: true, display: true });

    await engine.applyAxis("system", []);
    expect(driver.setStateCalls.at(-1)!.state).toEqual({ system: false, display: true });
    expect(driver.disengageCalls).toHaveLength(0);
  });

  it("coalesces an idempotent same-state, same-description call", async () => {
    await engine.applyAxis("system", [reason("job", "import")]);
    await engine.applyAxis("system", [reason("job", "import")]);
    expect(driver.setStateCalls).toHaveLength(1);
  });

  it("a description-only change re-calls the driver", async () => {
    await engine.applyAxis("system", [reason("job", "a")]);
    await engine.applyAxis("system", [reason("job", "b")]);
    expect(driver.setStateCalls).toHaveLength(2);
    expect(driver.setStateCalls.at(-1)!.description).toBe("b");
  });

  it("isEngaged reflects per-axis state", async () => {
    expect(engine.isEngaged("system")).toBe(false);
    await engine.applyAxis("system", [reason("job")]);
    expect(engine.isEngaged("system")).toBe(true);
    expect(engine.isEngaged("display")).toBe(false);
  });

  it("shutdown tears down once, is idempotent, and is inert afterwards", async () => {
    await engine.applyAxis("system", [reason("job", "import")]);
    await engine.shutdown();
    await engine.shutdown();
    expect(driver.shutdownCalls).toHaveLength(1);

    const before = driver.setStateCalls.length;
    await engine.applyAxis("system", [reason("job", "import")]);
    expect(driver.setStateCalls).toHaveLength(before);
  });

  it("shutdown with nothing engaged still calls driver.shutdown once", async () => {
    await engine.shutdown();
    expect(driver.shutdownCalls).toHaveLength(1);
    expect(driver.disengageCalls).toHaveLength(0);
  });

  it("applyAxes both-axes from idle emits exactly one setState and no intermediate state", async () => {
    await engine.applyAxes([reason("job", "import")], [reason("job", "import")]);

    expect(driver.setStateCalls).toHaveLength(1);
    expect(driver.setStateCalls[0]!.state).toEqual({ system: true, display: true });
    // The buggy two-call path would have emitted {system:true, display:false} first.
    expect(driver.setStateCalls.some((c) => c.state.system === true && c.state.display === false)).toBe(
      false,
    );
  });

  it("applyAxes replaces both axis reason maps and reconciles once", async () => {
    await engine.applyAxes([reason("a", "alpha")], []);
    expect(driver.setStateCalls.at(-1)!.state).toEqual({ system: true, display: false });

    const callsBefore = driver.setStateCalls.length;
    await engine.applyAxes([], [reason("b", "beta")]);
    expect(driver.setStateCalls.length).toBe(callsBefore + 1);
    expect(driver.setStateCalls.at(-1)!.state).toEqual({ system: false, display: true });
    expect(engine.isEngaged("system")).toBe(false);
    expect(engine.isEngaged("display")).toBe(true);
  });

  it("applyAxes coalesces an idempotent same-state, same-description call", async () => {
    await engine.applyAxes([reason("job", "import")], []);
    await engine.applyAxes([reason("job", "import")], []);
    expect(driver.setStateCalls).toHaveLength(1);
  });

  it("applyAxes is inert after shutdown", async () => {
    await engine.shutdown();
    await engine.applyAxes([reason("job", "import")], [reason("job", "import")]);
    expect(driver.setStateCalls).toHaveLength(0);
  });
});
