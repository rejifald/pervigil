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

describe("MacOSDriver", () => {
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
    caffeinatePath?: string;
    exists?: boolean;
    logger?: { warn: ReturnType<typeof vi.fn>; debug?: ReturnType<typeof vi.fn> };
  }) {
    mockExistsSync.mockImplementation((p: string) => {
      if (opts?.caffeinatePath) return p === opts.caffeinatePath;
      return opts?.exists ?? true;
    });
    const { MacOSDriver } = await import("./macos.js");
    return new MacOSDriver({
      caffeinatePath: opts?.caffeinatePath ?? "/usr/bin/caffeinate",
      logger: opts?.logger,
    });
  }

  it("existing caffeinatePath → available=true, platform=macos-caffeinate, not degraded", async () => {
    const driver = await makeDriver({ caffeinatePath: "/usr/bin/caffeinate", exists: true });
    expect(driver.available).toBe(true);
    expect(driver.platform).toBe("macos-caffeinate");
    expect(driver.degradedReason).toBe(null);
  });

  it("missing caffeinate → available=false, platform=macos-noop, degradedReason=missing-binary", async () => {
    mockExistsSync.mockReturnValue(false);
    const { MacOSDriver } = await import("./macos.js");
    const driver = new MacOSDriver({ caffeinatePath: "/nonexistent/caffeinate" });
    expect(driver.available).toBe(false);
    expect(driver.platform).toBe("macos-noop");
    expect(driver.degradedReason).toBe("missing-binary");
  });

  it("missing caffeinate logs one warning with operator-facing remediation", async () => {
    mockExistsSync.mockReturnValue(false);
    const warn = vi.fn();
    const { MacOSDriver } = await import("./macos.js");
    new MacOSDriver({ caffeinatePath: "/nonexistent/caffeinate", logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
    const [, msg] = warn.mock.calls[0]!;
    expect(String(msg)).toMatch(/caffeinate/i);
    expect(String(msg)).toMatch(/disabled/i);
  });

  it("unexpected child exit clears state, bumps restarts, and respawns on next setState", async () => {
    const firstChild = makeFakeChild();
    const secondChild = makeFakeChild();
    mockSpawn.mockReturnValueOnce(firstChild as unknown as ChildProcess);
    mockSpawn.mockReturnValueOnce(secondChild as unknown as ChildProcess);

    const warn = vi.fn();
    const driver = await makeDriver({ exists: true, logger: { warn } });
    await driver.setState({ system: true, display: false }, "first");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Simulate caffeinate dying externally (e.g. operator killall caffeinate).
    firstChild.exitCode = 0;
    firstChild.emit("exit", 0, null);

    expect(driver.restarts).toBe(1);
    const exitWarn = warn.mock.calls.find(([, msg]) => String(msg).includes("exited"));
    expect(exitWarn).toBeDefined();

    // Same flags as before should now respawn instead of short-circuiting.
    await driver.setState({ system: true, display: false }, "second");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("invokes a callback registered via onPrimitiveDied on unexpected exit", async () => {
    const driver = await makeDriver({ exists: true });
    const onDied = vi.fn();
    driver.onPrimitiveDied(onDied);

    await driver.setState({ system: true, display: false }, "first");

    // Simulate caffeinate dying externally.
    fakeChild.exitCode = 0;
    fakeChild.emit("exit", 0, null);

    expect(onDied).toHaveBeenCalledTimes(1);
    expect(driver.restarts).toBe(1);
  });

  it("setState({system:true}) spawns caffeinate -i", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: false }, "test reason");
    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-i"]);
  });

  it("setState({display:true}) spawns caffeinate -d", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: false, display: true }, "view reason");
    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-d"]);
  });

  it("setState({system:true,display:true}) spawns caffeinate -di", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: true }, "all reasons");
    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-di"]);
  });

  it("setState({system:false,display:false}) does not spawn", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: false, display: false }, "nothing");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("flag change spawns a second child and kills the first", async () => {
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

  it("shutdown SIGTERMs the spawned child", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: false }, "test reason");
    await driver.shutdown();
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("setState to all-off after engage kills the child", async () => {
    const driver = await makeDriver({ exists: true });
    await driver.setState({ system: true, display: false }, "test reason");
    await driver.setState({ system: false, display: false }, "");
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("shutdown with no child running is a no-op", async () => {
    const driver = await makeDriver({ exists: true });
    await expect(driver.shutdown()).resolves.toBeUndefined();
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });
});
