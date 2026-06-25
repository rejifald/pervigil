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
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    try {
      const { detectDriver } = await import("./detect.js");
      const warn = vi.fn();
      const driver = detectDriver({ logger: { warn } });
      expect(driver.platform).toBe("noop");
      expect(driver.available).toBe(false);
      expect(driver.degradedReason).toBe("unsupported-platform");
      expect(warn).toHaveBeenCalledTimes(1);
      const [meta, msg] = warn.mock.calls[0]!;
      expect((meta as { platform: string }).platform).toBe("freebsd");
      expect(String(msg)).toMatch(/no-?op|pervigil/i);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("win32 → routes to the Windows backend (not the unsupported-platform no-op)", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const { detectDriver } = await import("./detect.js");
      const driver = detectDriver();
      // win32 must route to the Windows backend regardless of host. A real
      // Windows runner finds PowerShell (`windows-powershell`, available); a
      // macOS/Linux CI host has none, so the driver degrades to its own no-op
      // variant (`windows-noop`). Either way it's the Windows backend — never
      // the generic `unsupported-platform` no-op.
      expect(driver.platform).toMatch(/^windows-(powershell|noop)$/);
      if (driver.available) {
        expect(driver.platform).toBe("windows-powershell");
        expect(driver.degradedReason).toBe(null);
      } else {
        expect(driver.platform).toBe("windows-noop");
        expect(driver.degradedReason).toBe("missing-binary");
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("darwin → emits exactly one info line naming the selected platform", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const { detectDriver } = await import("./detect.js");
      const info = vi.fn();
      const warn = vi.fn();
      detectDriver({ logger: { warn, info } });
      expect(info).toHaveBeenCalledTimes(1);
      const [meta] = info.mock.calls[0]!;
      expect(typeof (meta as { platform: unknown }).platform).toBe("string");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("linux → emits exactly one info line naming the selected platform", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const { detectDriver } = await import("./detect.js");
      const info = vi.fn();
      const warn = vi.fn();
      detectDriver({ logger: { warn, info } });
      expect(info).toHaveBeenCalledTimes(1);
      const [meta] = info.mock.calls[0]!;
      expect(typeof (meta as { platform: unknown }).platform).toBe("string");
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

  it("is silent by default — no logger, no logLevel ⇒ nothing on the console", async () => {
    vi.stubEnv("container", "podman");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { detectDriver } = await import("./detect.js");
    const driver = detectDriver();
    expect(driver.platform).toBe("noop");
    expect(warn).not.toHaveBeenCalled();
  });

  it("logLevel:'warn' surfaces the container warning to the console sink (no logger)", async () => {
    vi.stubEnv("container", "podman");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { detectDriver } = await import("./detect.js");
    detectDriver({ logLevel: "warn" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]!.join(" "))).toMatch(/container/i);
  });

  it("PERVIGIL_LOG_LEVEL surfaces warnings without a logger", async () => {
    vi.stubEnv("container", "podman");
    vi.stubEnv("PERVIGIL_LOG_LEVEL", "warn");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const { detectDriver } = await import("./detect.js");
    detectDriver();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
