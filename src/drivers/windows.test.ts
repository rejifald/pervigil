import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// ---- helpers ----------------------------------------------------------------

type SpawnListener = (...args: unknown[]) => void;

function makeFakeChild() {
  const listeners: Record<string, SpawnListener[]> = {};
  const child = {
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    kill: vi.fn((sig: string) => {
      child.killed = true;
      if (sig === "SIGTERM" || sig === "SIGKILL") {
        child.signalCode = sig;
        setTimeout(() => {
          (listeners["exit"] ?? []).forEach((fn) => fn(null, sig));
        }, 0);
      }
    }),
    once: vi.fn((event: string, fn: SpawnListener) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]!.push(fn);
      return child;
    }),
    emit: (event: string, ...args: unknown[]) => {
      (listeners[event] ?? []).forEach((fn) => fn(...args));
    },
  };
  return child;
}

/** Flatten a spawn call's command + args into a single searchable string. */
function spawnCommandText(call: unknown[]): string {
  const [cmd, args] = call;
  const argText = Array.isArray(args) ? args.join(" ") : "";
  return `${String(cmd)} ${argText}`;
}

// ---- module mocks -----------------------------------------------------------

const mockSpawn = vi.fn();
const mockExistsSync = vi.fn();

import type * as ChildProcessNs from "node:child_process";
import type * as FsNs from "node:fs";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessNs>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => mockSpawn(...args),
    execSync: vi.fn(() => ""),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof FsNs>();
  return {
    ...original,
    existsSync: (p: string) => mockExistsSync(p),
  };
});

// ---- tests ------------------------------------------------------------------

describe("WindowsDriver", () => {
  let fakeChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.resetModules();
    fakeChild = makeFakeChild();
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
    mockSpawn.mockReturnValue(fakeChild as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function makeDriver(opts?: {
    powershellPath?: string;
    exists?: boolean;
    logger?: { warn: ReturnType<typeof vi.fn>; debug?: ReturnType<typeof vi.fn> };
  }) {
    mockExistsSync.mockImplementation((p: string) => {
      if (opts?.powershellPath) return p === opts.powershellPath;
      return opts?.exists ?? true;
    });
    const { WindowsDriver } = await import("./windows.js");
    return new WindowsDriver({
      powershellPath: opts?.powershellPath ?? "C:/Windows/System32/powershell.exe",
      logger: opts?.logger,
    });
  }

  it("existing powershellPath → available=true, platform=windows-powershell, not degraded", async () => {
    const driver = await makeDriver({
      powershellPath: "C:/Windows/System32/powershell.exe",
      exists: true,
    });
    expect(driver.available).toBe(true);
    expect(driver.platform).toBe("windows-powershell");
    expect(driver.degradedReason).toBe(null);
  });

  it("missing PowerShell → available=false, platform=windows-noop, degradedReason=missing-binary", async () => {
    mockExistsSync.mockReturnValue(false);
    const { WindowsDriver } = await import("./windows.js");
    const driver = new WindowsDriver({ powershellPath: "C:/nope/powershell.exe" });
    expect(driver.available).toBe(false);
    expect(driver.platform).toBe("windows-noop");
    expect(driver.degradedReason).toBe("missing-binary");
  });

  it("missing PowerShell logs exactly one warning with operator-facing remediation", async () => {
    mockExistsSync.mockReturnValue(false);
    const warn = vi.fn();
    const { WindowsDriver } = await import("./windows.js");
    new WindowsDriver({ powershellPath: "C:/nope/powershell.exe", logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
    const [, msg] = warn.mock.calls[0]!;
    expect(String(msg)).toMatch(/powershell|sleep inhibitor/i);
    expect(String(msg)).toMatch(/disabled/i);
  });

  it("setState({system:true}) spawns a command with ES_CONTINUOUS + ES_SYSTEM_REQUIRED, not ES_DISPLAY_REQUIRED", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: false }, "test reason");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const text = spawnCommandText(mockSpawn.mock.calls[0]!);
    expect(text).toContain("ES_CONTINUOUS");
    expect(text).toContain("ES_SYSTEM_REQUIRED");
    expect(text).not.toContain("ES_DISPLAY_REQUIRED");
    expect(text).toContain("SetThreadExecutionState");
  });

  it("setState({display:true}) adds ES_DISPLAY_REQUIRED", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: false, display: true }, "view reason");
    const text = spawnCommandText(mockSpawn.mock.calls[0]!);
    expect(text).toContain("ES_CONTINUOUS");
    expect(text).toContain("ES_DISPLAY_REQUIRED");
  });

  it("setState({system:true,display:true}) includes both axis flags", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: true }, "all reasons");
    const text = spawnCommandText(mockSpawn.mock.calls[0]!);
    expect(text).toContain("ES_CONTINUOUS");
    expect(text).toContain("ES_SYSTEM_REQUIRED");
    expect(text).toContain("ES_DISPLAY_REQUIRED");
  });

  it("setState({system:false,display:false}) does not spawn", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: false, display: false }, "nothing");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("setState to all-off after engage kills the child", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: false }, "test reason");
    await driver.setState({ system: false, display: false }, "");
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("flag change spawns a second child and SIGTERMs the first", async () => {
    const firstChild = makeFakeChild();
    const secondChild = makeFakeChild();
    mockSpawn.mockReturnValueOnce(firstChild as unknown as ChildProcess);
    mockSpawn.mockReturnValueOnce(secondChild as unknown as ChildProcess);

    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: false }, "first");
    await driver.setState({ system: true, display: true }, "second");

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("repeated setState with same flags does not spawn again", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: false }, "first");
    await driver.setState({ system: true, display: false }, "first again");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("unexpected child exit clears state, bumps restarts, warns, and respawns on next setState", async () => {
    const firstChild = makeFakeChild();
    const secondChild = makeFakeChild();
    mockSpawn.mockReturnValueOnce(firstChild as unknown as ChildProcess);
    mockSpawn.mockReturnValueOnce(secondChild as unknown as ChildProcess);

    const warn = vi.fn();
    const onPrimitiveDied = vi.fn();
    mockExistsSync.mockReturnValue(true);
    const { WindowsDriver } = await import("./windows.js");
    const driver = new WindowsDriver({
      powershellPath: "C:/Windows/System32/powershell.exe",
      logger: { warn },
      onPrimitiveDied,
    });

    await driver.setState({ system: true, display: false }, "first");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Simulate PowerShell dying externally.
    firstChild.exitCode = 0;
    firstChild.emit("exit", 0, null);

    expect(driver.restarts).toBe(1);
    expect(onPrimitiveDied).toHaveBeenCalledTimes(1);
    const exitWarn = warn.mock.calls.find(([, msg]) => String(msg).includes("exited"));
    expect(exitWarn).toBeDefined();

    // Same flags should now respawn instead of short-circuiting.
    await driver.setState({ system: true, display: false }, "second");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("shutdown SIGTERMs the spawned child", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: false }, "test reason");
    await driver.shutdown();
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("shutdown with no child running is a no-op and is idempotent", async () => {
    const driver = await makeDriver({ exists: true });
    await expect(driver.shutdown()).resolves.toBeUndefined();
    await expect(driver.shutdown()).resolves.toBeUndefined();
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });

  it("setState is a no-op when the driver is unavailable", async () => {
    mockExistsSync.mockReturnValue(false);
    const { WindowsDriver } = await import("./windows.js");
    const driver = new WindowsDriver({ powershellPath: "C:/nope/powershell.exe" });
    await driver.setState({ system: true, display: true }, "reason");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
