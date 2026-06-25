import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

// ---------- mock setup ----------

const mockSpawn = vi.fn();
const mockAccessSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("node:fs", () => ({
  accessSync: (...args: unknown[]) => mockAccessSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  constants: { X_OK: 1, W_OK: 2 },
}));

// Must import AFTER mocks are registered
import { LinuxDriver, type LinuxDriverOptions } from "./linux.js";

// ---------- helpers ----------

function makeChild(): ChildProcess & EventEmitter {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  let killed = false;
  const child = {
    exitCode: null as number | null,
    get killed() {
      return killed;
    },
    kill: vi.fn((sig?: string) => {
      killed = true;
      setImmediate(() => {
        (listeners["exit"] ?? []).forEach((fn) => fn(null, sig));
      });
      return true;
    }),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(fn);
      return child;
    }),
    once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      const wrapper = (...args: unknown[]) => {
        fn(...args);
        listeners[event] = (listeners[event] ?? []).filter((l) => l !== wrapper);
      };
      (listeners[event] ??= []).push(wrapper);
      return child;
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      (listeners[event] ?? []).forEach((fn) => fn(...args));
      return true;
    }),
  } as unknown as ChildProcess & EventEmitter;
  return child;
}

const FAKE_INHIBIT = "/fake/systemd-inhibit";
const FAKE_WAKE_LOCK = "/fake/wake_lock";
const FAKE_WAKE_UNLOCK = "/fake/wake_unlock";

function makeDriver(overrides: LinuxDriverOptions = {}) {
  return new LinuxDriver({
    systemdInhibitPath: FAKE_INHIBIT,
    sysfsWakeLockPath: FAKE_WAKE_LOCK,
    sysfsWakeUnlockPath: FAKE_WAKE_UNLOCK,
    logger: { warn: vi.fn() },
    ...overrides,
  });
}

// ---------- tests ----------

describe("LinuxDriver — backend selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("systemd-inhibit available → platform=linux-systemd-inhibit, available=true", () => {
    mockAccessSync.mockImplementation(() => undefined);
    const driver = makeDriver();
    expect(driver.platform).toBe("linux-systemd-inhibit");
    expect(driver.available).toBe(true);
    expect(driver.degradedReason).toBe(null);
  });

  it("systemd-inhibit missing, sysfs writable → platform=linux-syspower-wakelock", () => {
    mockAccessSync.mockImplementation((_path: string, _mode: number) => {
      if (_path === FAKE_INHIBIT || _path === "/usr/bin/systemd-inhibit") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return undefined;
    });
    const driver = makeDriver();
    expect(driver.platform).toBe("linux-syspower-wakelock");
    expect(driver.available).toBe(true);
  });

  it("neither available → platform=linux-noop, available=false, degradedReason=missing-binary", () => {
    mockAccessSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const driver = makeDriver();
    expect(driver.platform).toBe("linux-noop");
    expect(driver.available).toBe(false);
    expect(driver.degradedReason).toBe("missing-binary");
  });

  it("noop backend logs one warning at construction", () => {
    mockAccessSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const warnSpy = vi.fn();
    makeDriver({ logger: { warn: warnSpy } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![1]).toMatch(/systemd-inhibit|wake_lock/);
  });
});

describe("LinuxDriver — systemd-inhibit backend", () => {
  let child: ReturnType<typeof makeChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    child = makeChild();
    mockSpawn.mockReturnValue(child);
  });

  it("setState({system:true}) spawns systemd-inhibit --what=sleep with the default identity", async () => {
    const driver = makeDriver({ forceBackend: "systemd-inhibit" });
    await driver.setState({ system: true, display: false }, "foo");

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain("--what=sleep");
    expect(args).toContain("--who=pervigil");
    expect(args).toContain("--why=foo");
    expect(args).toContain("--mode=block");
  });

  it("custom identity flows into --who=", async () => {
    const driver = makeDriver({ forceBackend: "systemd-inhibit", identity: "my-app" });
    await driver.setState({ system: true, display: false }, "foo");
    const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain("--who=my-app");
  });

  it("setState({system:true,display:true}) → --what=sleep:idle:handle-lid-switch", async () => {
    const driver = makeDriver({ forceBackend: "systemd-inhibit" });
    await driver.setState({ system: true, display: true }, "display+sys");
    const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
    const whatArg = args.find((a) => a.startsWith("--what="));
    expect(whatArg).toContain("sleep");
    expect(whatArg).toContain("idle");
    expect(whatArg).toContain("handle-lid-switch");
  });

  it("setState({display:true}) → --what=idle:handle-lid-switch (no sleep)", async () => {
    const driver = makeDriver({ forceBackend: "systemd-inhibit" });
    await driver.setState({ system: false, display: true }, "display-only");
    const args: string[] = mockSpawn.mock.calls[0]![1] as string[];
    const whatArg = args.find((a) => a.startsWith("--what="));
    expect(whatArg).not.toContain("sleep");
    expect(whatArg).toContain("idle");
    expect(whatArg).toContain("handle-lid-switch");
  });

  it("setState({system:false,display:false}) does not spawn", async () => {
    const driver = makeDriver({ forceBackend: "systemd-inhibit" });
    await driver.setState({ system: false, display: false }, "nothing");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("shutdown SIGTERMs the systemd-inhibit child", async () => {
    const driver = makeDriver({ forceBackend: "systemd-inhibit" });
    await driver.setState({ system: true, display: false }, "test");
    await driver.shutdown();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("shutdown with no child is a no-op", async () => {
    const driver = makeDriver({ forceBackend: "systemd-inhibit" });
    await expect(driver.shutdown()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("flag change re-spawns (kills first child, spawns second)", async () => {
    const child2 = makeChild();
    mockSpawn.mockReturnValueOnce(child).mockReturnValueOnce(child2);

    const driver = makeDriver({ forceBackend: "systemd-inhibit" });
    await driver.setState({ system: true, display: false }, "first");
    await driver.setState({ system: true, display: true }, "second");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const secondArgs: string[] = mockSpawn.mock.calls[1]![1] as string[];
    expect(secondArgs).toContain("--why=second");
  });

  it("repeated setState with same flags + description does not re-spawn", async () => {
    const driver = makeDriver({ forceBackend: "systemd-inhibit" });
    await driver.setState({ system: true, display: false }, "same");
    await driver.setState({ system: true, display: false }, "same");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("unexpected child exit clears state, bumps restarts, and respawns on next setState", async () => {
    const child2 = makeChild();
    mockSpawn.mockReturnValueOnce(child).mockReturnValueOnce(child2);

    const warn = vi.fn();
    const driver = makeDriver({ forceBackend: "systemd-inhibit", logger: { warn } });
    await driver.setState({ system: true, display: false }, "first");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    (child as unknown as { exitCode: number | null }).exitCode = 0;
    child.emit("exit", 0, null);

    expect(driver.restarts).toBe(1);
    const exitWarn = warn.mock.calls.find(([, msg]) => String(msg).includes("exited"));
    expect(exitWarn).toBeDefined();

    await driver.setState({ system: true, display: false }, "first");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

describe("LinuxDriver — sysfs backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("any axis engaged writes the identity cookie to wake_lock", async () => {
    const driver = makeDriver({ forceBackend: "sysfs" });
    await driver.setState({ system: true, display: false }, "sysfs test");
    expect(mockWriteFileSync).toHaveBeenCalledWith(FAKE_WAKE_LOCK, "pervigil\n");
  });

  it("all-off writes the identity cookie to wake_unlock", async () => {
    const driver = makeDriver({ forceBackend: "sysfs" });
    await driver.setState({ system: true, display: false }, "sysfs test");
    await driver.setState({ system: false, display: false }, "sysfs off");
    expect(mockWriteFileSync).toHaveBeenCalledWith(FAKE_WAKE_UNLOCK, "pervigil\n");
  });

  it("shutdown is idempotent — writes wake_unlock once across repeat calls", async () => {
    const driver = makeDriver({ forceBackend: "sysfs" });
    await driver.setState({ system: true, display: false }, "sysfs test");
    await driver.shutdown();
    await driver.shutdown();
    const unlockCalls = mockWriteFileSync.mock.calls.filter(([path]) => path === FAKE_WAKE_UNLOCK);
    expect(unlockCalls).toHaveLength(1);
  });

  it("engage logs warn on EACCES and no-ops", async () => {
    const warnSpy = vi.fn();
    mockWriteFileSync.mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    const driver = makeDriver({ forceBackend: "sysfs", logger: { warn: warnSpy } });
    await expect(driver.setState({ system: true, display: false }, "fail")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("LinuxDriver — noop backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setState and shutdown are no-ops, do not throw", async () => {
    const driver = makeDriver({ forceBackend: "noop" });
    await expect(
      driver.setState({ system: true, display: true }, "noop test"),
    ).resolves.toBeUndefined();
    await expect(driver.shutdown()).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});
