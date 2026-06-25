import { existsSync } from "node:fs";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { killChild } from "../internal/kill-child.js";
import type { DegradedReason, WakeLockDriver, WakeLockLogger, WakeLockState } from "../types.js";

export interface MacOSWakeLockDriverOptions {
  /** Override the caffeinate binary path. Default: auto-probe. For tests. */
  caffeinatePath?: string;
  /** Optional logger. */
  logger?: WakeLockLogger;
  /**
   * No-op on macOS. Accepted for API symmetry with the Linux and Windows
   * drivers, but `caffeinate(1)` exposes no equivalent of an identity string,
   * so this value is ignored and never surfaced to the OS. (On Linux it becomes
   * `systemd-inhibit --who=` / the sysfs cookie; on Windows it tags the
   * assertion.)
   */
  identity?: string;
  /** Invoked when the caffeinate child dies unexpectedly. */
  onPrimitiveDied?: () => void;
}

function probeCaffeinate(override?: string): { path: string; found: boolean } {
  if (override) {
    return { path: override, found: existsSync(override) };
  }
  if (existsSync("/usr/bin/caffeinate")) {
    return { path: "/usr/bin/caffeinate", found: true };
  }
  try {
    const result = execSync("which caffeinate 2>/dev/null", { encoding: "utf8" }).trim();
    if (result) {
      return { path: result, found: true };
    }
  } catch {
    // which not available or caffeinate not found
  }
  return { path: "/usr/bin/caffeinate", found: false };
}

function caffeinateArgs(state: WakeLockState): string[] | null {
  // -i: prevent system idle sleep. -d: prevent display sleep.
  // The two are independent caffeinate assertions and may be combined as -di.
  if (state.system && state.display) return ["-di"];
  if (state.system) return ["-i"];
  if (state.display) return ["-d"];
  return null;
}

/** macOS driver backed by `caffeinate(1)`. */
export class MacOSWakeLockDriver implements WakeLockDriver {
  readonly platform: string;
  readonly available: boolean;
  readonly degradedReason: DegradedReason;

  private readonly _caffeinatePath: string;
  private readonly _logger: WakeLockLogger | undefined;
  private readonly _diedCallbacks: (() => void)[] = [];
  private _child: ChildProcess | null = null;
  private _currentArgs: string[] | null = null;
  private _restarts = 0;

  constructor(opts: MacOSWakeLockDriverOptions = {}) {
    this._logger = opts.logger;
    if (opts.onPrimitiveDied) this._diedCallbacks.push(opts.onPrimitiveDied);

    const probe = probeCaffeinate(opts.caffeinatePath);
    this._caffeinatePath = probe.path;

    if (probe.found) {
      this.platform = "macos-caffeinate";
      this.available = true;
      this.degradedReason = null;
    } else {
      this.platform = "macos-noop";
      this.available = false;
      this.degradedReason = "missing-binary";
      this._logger?.warn(
        { path: this._caffeinatePath },
        "caffeinate binary not found — sleep inhibitor disabled. Install macOS command-line tools or place a caffeinate binary on PATH.",
      );
    }
  }

  get restarts(): number {
    return this._restarts;
  }

  onPrimitiveDied(cb: () => void): void {
    this._diedCallbacks.push(cb);
  }

  private _emitPrimitiveDied(): void {
    for (const cb of this._diedCallbacks) {
      try {
        cb();
      } catch {
        // A misbehaving death callback must never break the driver.
      }
    }
  }

  async setState(state: WakeLockState, description: string): Promise<void> {
    if (!this.available) return;

    const args = caffeinateArgs(state);

    if (args === null) {
      if (this._child !== null) {
        await this._killChild();
      }
      this._currentArgs = null;
      return;
    }

    const sameFlags =
      this._currentArgs !== null &&
      this._currentArgs.length === args.length &&
      this._currentArgs.every((a, i) => a === args[i]);

    if (this._child !== null && sameFlags) {
      // No work: caffeinate has no inline reason update, so re-spawning would
      // just churn the assertion. `description` is for debug logging only.
      return;
    }

    // Spawn the new assertion first, then kill the previous one — so we never
    // drop the assertion across an axis flip.
    const previousChild = this._child;
    const child = spawn(this._caffeinatePath, args, {
      detached: false,
      stdio: "ignore",
    });

    const clearIfCurrent = () => {
      if (this._child === child) {
        this._child = null;
        this._currentArgs = null;
      }
    };

    child.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        this._logger?.warn({ err }, "caffeinate not found — sleep inhibitor disabled");
      } else {
        this._logger?.warn({ err }, "caffeinate child error");
      }
      clearIfCurrent();
    });

    // Normal exit (operator killed it externally, OOM, etc.) must clear our
    // bookkeeping too — otherwise sameFlags would short-circuit the next call
    // and we'd silently run with a dropped assertion.
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this._child === child) {
        this._restarts += 1;
        this._logger?.warn(
          { code, signal },
          "caffeinate exited unexpectedly — sleep inhibitor dropped, will re-engage on next change",
        );
        this._emitPrimitiveDied();
      }
      clearIfCurrent();
    });

    this._child = child;
    this._currentArgs = args;
    this._logger?.debug?.({ description, args }, "caffeinate spawned");

    if (previousChild !== null) {
      await killChild(previousChild);
    }
  }

  async shutdown(): Promise<void> {
    if (this._child === null) {
      this._currentArgs = null;
      return;
    }
    await this._killChild();
    this._currentArgs = null;
  }

  private async _killChild(): Promise<void> {
    const child = this._child;
    if (child === null) return;
    this._child = null;
    await killChild(child);
  }
}
