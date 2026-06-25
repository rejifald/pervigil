import { describe, it, expect } from "vitest";
import { collectMetrics, toPrometheus } from "./metrics.js";
import { wakeLock } from "./controller.js";
import { MockDriver } from "./drivers/mock.js";
import type { WakeLockStatus } from "./controller.js";

/** Build a lock on the in-memory mock driver and engage the system axis once. */
async function engagedSystemLock() {
  const driver = new MockDriver();
  const lock = wakeLock({ driver });
  await lock.acquire("job", { system: true });
  return lock;
}

describe("collectMetrics", () => {
  it("emits the full neutral sample set with correct types", async () => {
    const lock = await engagedSystemLock();
    const samples = collectMetrics(lock);
    const byKey = (name: string, axis?: string) =>
      samples.find(
        (s) => s.name === name && (axis === undefined || s.labels?.axis === axis),
      );

    expect(byKey("pervigil_available")).toMatchObject({ type: "gauge", value: 1 });
    expect(byKey("pervigil_active")).toMatchObject({ type: "gauge", value: 1 });
    expect(byKey("pervigil_awake", "system")).toMatchObject({ type: "gauge", value: 1 });
    expect(byKey("pervigil_awake", "display")).toMatchObject({ type: "gauge", value: 0 });
    expect(byKey("pervigil_engage_transitions_total", "system")).toMatchObject({
      type: "counter",
      value: 1,
    });
    expect(byKey("pervigil_engage_transitions_total", "display")).toMatchObject({
      type: "counter",
      value: 0,
    });
    expect(byKey("pervigil_awake_ms_total", "system")?.type).toBe("counter");
    expect(byKey("pervigil_primitive_restarts_total")).toMatchObject({
      type: "counter",
      value: 0,
    });
  });

  it("accepts a raw WakeLockStatus as well as a source with status()", async () => {
    const lock = await engagedSystemLock();
    const status: WakeLockStatus = lock.status();
    const fromStatus = collectMetrics(status);
    const fromSource = collectMetrics(lock);
    expect(fromStatus.find((s) => s.name === "pervigil_available")?.value).toBe(1);
    expect(fromSource.find((s) => s.name === "pervigil_available")?.value).toBe(1);
  });
});

describe("toPrometheus", () => {
  it("renders HELP/TYPE lines and the engaged system axis", async () => {
    const lock = await engagedSystemLock();
    const text = toPrometheus(lock);

    // # TYPE lines for every metric.
    expect(text).toContain("# TYPE pervigil_available gauge");
    expect(text).toContain("# TYPE pervigil_active gauge");
    expect(text).toContain("pervigil_active 1");
    expect(text).toContain("# TYPE pervigil_awake gauge");
    expect(text).toContain("# TYPE pervigil_awake_ms_total counter");
    expect(text).toContain("# TYPE pervigil_engage_transitions_total counter");
    expect(text).toContain("# TYPE pervigil_primitive_restarts_total counter");

    // # HELP lines present for each metric.
    expect(text).toContain("# HELP pervigil_available");
    expect(text).toContain("# HELP pervigil_awake ");
    expect(text).toContain("# HELP pervigil_awake_ms_total");
    expect(text).toContain("# HELP pervigil_engage_transitions_total");
    expect(text).toContain("# HELP pervigil_primitive_restarts_total");

    // Engaged system axis values.
    expect(text).toContain('pervigil_awake{axis="system"} 1');
    expect(text).toContain('pervigil_awake{axis="display"} 0');
    expect(text).toContain('pervigil_engage_transitions_total{axis="system"} 1');
    expect(text).toContain('pervigil_engage_transitions_total{axis="display"} 0');
    expect(text).toContain("pervigil_available 1");
    expect(text).toContain("pervigil_primitive_restarts_total 0");
    expect(text).toMatch(/pervigil_awake_ms_total\{axis="system"\} \d+/);
  });

  it("ends with a trailing newline (Prometheus convention)", async () => {
    const lock = await engagedSystemLock();
    expect(toPrometheus(lock).endsWith("\n")).toBe(true);
  });
});
