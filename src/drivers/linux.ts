import * as fs from "node:fs";
import * as cp from "node:child_process";
import { killChild } from "../internal/kill-child.js";
import type { DegradedReason, Driver, Logger, WakeLockState } from "../types.js";

export interface LinuxDriverOptions {
  /** Override systemd-inhibit binary path. For tests. */
  systemdInhibitPath?: string;
  /** Override sysfs paths. For tests. */
  sysfsWakeLockPath?: string;
  sysfsWakeUnlockPath?: string;
  /** Force a specific backend for tests. */
  forceBackend?: "systemd-inhibit" | "sysfs" | "noop";
  /** Optional logger. */
  logger?: Logger;
  /** Identity surfaced to logind (`--who=`) and used as the sysfs cookie. */
  identity?: string;
  /** Invoked when the systemd-inhibit child dies unexpectedly. */
  onPrimitiveDied?: () => void;
}

type Backend = "systemd-inhibit" | "sysfs" | "noop";

function detectBackend(systemdInhibitPath: string, sysfsWakeLockPath: string): Backend {
  const inhibitPaths = [systemdInhibitPath, "/usr/bin/systemd-inhibit"];
  for (const p of inhibitPaths) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return "systemd-inhibit";
    } catch {
      // not found / not executable at this path
    }
  }

  try {
    // NOTE: probes writability for the current uid. If the host process later
    // drops privileges this probe lies — fine while the process keeps its
    // launching uid for its whole lifetime.
    fs.accessSync(sysfsWakeLockPath, fs.constants.W_OK);
    return "sysfs";
  } catch {
    // not writable
  }

  return "noop";
}

function inhibitWhat(state: WakeLockState): string | null {
  // logind --what= takes a colon-separated list of locks.
  // "sleep" blocks system sleep; "idle" blocks idle handling (display blank
  // and dpms); "handle-lid-switch" blocks the lid action on laptops which
  // would otherwise dim/sleep the display.
  const parts: string[] = [];
  if (state.system) parts.push("sleep");
  if (state.display) {
    parts.push("idle", "handle-lid-switch");
  }
  if (parts.length === 0) return null;
  return parts.join(":");
}

const NOOP_LOGGER: Logger = { warn: () => undefined };

/** Linux driver backed by `systemd-inhibit(1)` or `/sys/power/wake_lock`. */
export class LinuxDriver implements Driver {
  readonly platform: string;
  readonly available: boolean;
  readonly degradedReason: DegradedReason;

  private readonly backend: Backend;
  private readonly systemdInhibitPath: string;
  private readonly sysfsWakeLockPath: string;
  private readonly sysfsWakeUnlockPath: string;
  private readonly logger: Logger;
  private readonly identity: string;
  private readonly diedCallbacks: (() => void)[] = [];

  private child: cp.ChildProcess | null = null;
  private currentWhat: string | null = null;
  private currentDescription = "";
  private sysfsEngaged = false;
  private _restarts = 0;

  constructor(opts: LinuxDriverOptions = {}) {
    this.systemdInhibitPath = opts.systemdInhibitPath ?? "/usr/bin/systemd-inhibit";
    this.sysfsWakeLockPath = opts.sysfsWakeLockPath ?? "/sys/power/wake_lock";
    this.sysfsWakeUnlockPath = opts.sysfsWakeUnlockPath ?? "/sys/power/wake_unlock";
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.identity = opts.identity ?? "pervigil";
    if (opts.onPrimitiveDied) this.diedCallbacks.push(opts.onPrimitiveDied);

    const backend =
      opts.forceBackend ?? detectBackend(this.systemdInhibitPath, this.sysfsWakeLockPath);
    this.backend = backend;

    switch (backend) {
      case "systemd-inhibit":
        this.platform = "linux-systemd-inhibit";
        this.available = true;
        this.degradedReason = null;
        break;
      case "sysfs":
        this.platform = "linux-syspower-wakelock";
        this.available = true;
        this.degradedReason = null;
        break;
      default:
        this.platform = "linux-noop";
        this.available = false;
        this.degradedReason = "missing-binary";
        this.logger.warn(
          {},
          "Neither systemd-inhibit nor /sys/power/wake_lock is available — install systemd or configure the host BIOS / OS to never suspend.",
        );
    }
  }

  get restarts(): number {
    return this._restarts;
  }

  /**
   * The assertion is in effect when the systemd-inhibit child is alive, or the
   * sysfs wake_lock cookie is written. The no-op backend never holds.
   */
  get held(): boolean {
    if (this.backend === "systemd-inhibit") return this.child !== null;
    if (this.backend === "sysfs") return this.sysfsEngaged;
    return false;
  }

  onPrimitiveDied(cb: () => void): void {
    this.diedCallbacks.push(cb);
  }

  private emitPrimitiveDied(): void {
    for (const cb of this.diedCallbacks) {
      try {
        cb();
      } catch {
        // A misbehaving death callback must never break the driver.
      }
    }
  }

  async setState(state: WakeLockState, description: string): Promise<void> {
    switch (this.backend) {
      case "systemd-inhibit":
        await this._setStateSystemd(state, description);
        break;
      case "sysfs":
        this._setStateSysfs(state);
        break;
      // noop: do nothing
    }
  }

  async shutdown(): Promise<void> {
    switch (this.backend) {
      case "systemd-inhibit":
        await this._killChild();
        this.currentWhat = null;
        this.currentDescription = "";
        break;
      case "sysfs":
        this._disengageSysfs();
        break;
      // noop
    }
  }

  // --- systemd-inhibit backend ---

  private async _setStateSystemd(state: WakeLockState, description: string): Promise<void> {
    const what = inhibitWhat(state);

    if (what === null) {
      if (this.child !== null) {
        await this._killChild();
      }
      this.currentWhat = null;
      this.currentDescription = "";
      return;
    }

    if (
      this.child !== null &&
      what === this.currentWhat &&
      description === this.currentDescription
    ) {
      return;
    }

    let inhibitBin = this.systemdInhibitPath;
    try {
      fs.accessSync(inhibitBin, fs.constants.X_OK);
    } catch {
      inhibitBin = "/usr/bin/systemd-inhibit";
    }

    let child: cp.ChildProcess;
    try {
      child = cp.spawn(
        inhibitBin,
        [
          `--what=${what}`,
          `--who=${this.identity}`,
          `--why=${description}`,
          "--mode=block",
          "sleep",
          "infinity",
        ],
        { stdio: "ignore", detached: false },
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.logger.warn({ err }, "systemd-inhibit not found — sleep inhibitor no-op");
        return;
      }
      throw err;
    }

    const clearIfCurrent = () => {
      if (this.child === child) {
        this.child = null;
        this.currentWhat = null;
        this.currentDescription = "";
      }
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        this.logger.warn({ err }, "systemd-inhibit not found — sleep inhibitor no-op");
      } else {
        this.logger.warn({ err }, "systemd-inhibit child error");
      }
      clearIfCurrent();
    });

    // Normal exit (operator killed it externally, systemd restart, etc.) must
    // clear bookkeeping — otherwise the same-flags short-circuit at the top of
    // _setStateSystemd would silently run with a dropped lock.
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child === child) {
        this._restarts += 1;
        this.logger.warn(
          { code, signal },
          "systemd-inhibit exited unexpectedly — sleep inhibitor dropped, will re-engage on next change",
        );
        this.emitPrimitiveDied();
      }
      clearIfCurrent();
    });

    const previous = this.child;
    this.child = child;
    this.currentWhat = what;
    this.currentDescription = description;

    if (previous !== null) {
      await killChild(previous);
    }
  }

  private async _killChild(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    this.currentWhat = null;
    this.currentDescription = "";
    await killChild(child);
  }

  // --- sysfs backend ---

  private _setStateSysfs(state: WakeLockState): void {
    // The sysfs wake_lock primitive is a single boolean — it cannot
    // distinguish system vs display sleep. Either axis being engaged maps
    // to writing the wake_lock; releasing both unlocks it.
    const engaged = state.system || state.display;
    if (engaged && !this.sysfsEngaged) {
      this._engageSysfs();
    } else if (!engaged && this.sysfsEngaged) {
      this._disengageSysfs();
    }
  }

  private _engageSysfs(): void {
    try {
      fs.writeFileSync(this.sysfsWakeLockPath, `${this.identity}\n`);
      this.sysfsEngaged = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "ENOENT") {
        this.logger.warn({ err }, "Failed to write /sys/power/wake_lock — no-op");
      } else {
        this.logger.warn({ err }, "Unexpected error writing /sys/power/wake_lock");
      }
    }
  }

  private _disengageSysfs(): void {
    if (!this.sysfsEngaged) return;
    try {
      fs.writeFileSync(this.sysfsWakeUnlockPath, `${this.identity}\n`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "ENOENT") {
        this.logger.warn({ err }, "Failed to write /sys/power/wake_unlock — no-op");
      } else {
        this.logger.warn({ err }, "Unexpected error writing /sys/power/wake_unlock");
      }
    } finally {
      this.sysfsEngaged = false;
    }
  }
}
