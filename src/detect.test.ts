import { describe, it, expect, vi, afterEach } from "vitest";

// detect.ts imports platform-specific drivers at load time, so we reset modules
// between cases and stub env / fs as needed.

describe("detectDriver", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // doMock("node:fs") registrations are not cleared by restoreAllMocks; drop
    // them explicitly so a mocked fs cannot leak into a later case.
    vi.doUnmock("node:fs");
    vi.doUnmock("./drivers/linux.js");
    vi.resetModules();
  });

  it("PERVIGIL_FORCE_NOOP=1 → noop, available=false, degradedReason=forced", async () => {
    vi.stubEnv("PERVIGIL_FORCE_NOOP", "1");
    const { detectDriver } = await import("./detect.js");
    const driver = detectDriver();
    expect(driver.platform).toBe("noop");
    expect(driver.available).toBe(false);
    expect(driver.degradedReason).toBe("forced");
  });

  it("forceNoop option → noop, available=false", async () => {
    vi.unstubAllEnvs();
    const { detectDriver } = await import("./detect.js");
    const driver = detectDriver({ forceNoop: true });
    expect(driver.platform).toBe("noop");
    expect(driver.available).toBe(false);
  });

  it("forceNoop option does not emit a selected-backend info log", async () => {
    vi.unstubAllEnvs();
    const { detectDriver } = await import("./detect.js");
    const info = vi.fn();
    detectDriver({ forceNoop: true, logger: { warn: vi.fn(), info } });
    expect(info).not.toHaveBeenCalled();
  });

  it("container env variable set → noop, degradedReason=container", async () => {
    vi.stubEnv("container", "podman");
    vi.resetModules();
    const { detectDriver } = await import("./detect.js");
    const driver = detectDriver();
    expect(driver.platform).toBe("noop");
    expect(driver.degradedReason).toBe("container");
  });

  it("/.dockerenv present → noop", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: (p: string) => p === "/.dockerenv",
    }));
    const { detectDriver } = await import("./detect.js");
    const driver = detectDriver();
    expect(driver.platform).toBe("noop");
    expect(driver.available).toBe(false);
  });

  it("no force, no container → returns a WakeLockDriver shape without throwing", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const { detectDriver } = await import("./detect.js");
    const driver = detectDriver();
    expect(typeof driver.platform).toBe("string");
    expect(typeof driver.available).toBe("boolean");
    expect(typeof driver.setState).toBe("function");
    expect(typeof driver.shutdown).toBe("function");
  });

  it("unsupported platform → noop with a warning that names the platform", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const { detectDriver } = await import("./detect.js");
      const warn = vi.fn();
      const driver = detectDriver({ logger: { warn } });
      expect(driver.platform).toBe("noop");
      expect(driver.available).toBe(false);
      expect(driver.degradedReason).toBe("unsupported-platform");
      expect(warn).toHaveBeenCalledTimes(1);
      const [meta, msg] = warn.mock.calls[0]!;
      expect((meta as { platform: string }).platform).toBe("win32");
      expect(String(msg)).toMatch(/no-?op|pervigil/i);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("container detection passes a warning to the supplied logger", async () => {
    vi.stubEnv("container", "podman");
    vi.resetModules();
    const { detectDriver } = await import("./detect.js");
    const warn = vi.fn();
    const driver = detectDriver({ logger: { warn } });
    expect(driver.platform).toBe("noop");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toMatch(/container/i);
  });

  it("linux backend selection emits one info log naming the backend", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
    }));
    vi.doMock("./drivers/linux.js", () => ({
      LinuxWakeLockDriver: class {
        readonly platform = "linux-systemd-inhibit";
        readonly available = true;
        readonly degradedReason = null;
        readonly restarts = 0;

        async setState(): Promise<void> {
          return undefined;
        }

        async shutdown(): Promise<void> {
          return undefined;
        }
      },
    }));

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const { detectDriver } = await import("./detect.js");
      const info = vi.fn();
      const driver = detectDriver({ logger: { warn: vi.fn(), info } });

      expect(driver.platform).toBe("linux-systemd-inhibit");
      expect(info).toHaveBeenCalledTimes(1);
      const [meta, msg] = info.mock.calls[0]!;
      expect(meta).toEqual({ platform: "linux-systemd-inhibit", available: true });
      expect(String(msg)).toMatch(/selected.*backend/i);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
