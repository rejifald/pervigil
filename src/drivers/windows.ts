import { existsSync } from "node:fs";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { killChild } from "../internal/kill-child.js";
import type { DegradedReason, Driver, Logger, WakeLockState } from "../types.js";

export interface WindowsDriverOptions {
  /** Override the PowerShell binary path. Default: auto-probe. For tests. */
  powershellPath?: string;
  /** Optional logger. */
  logger?: Logger;
  /**
   * Accepted for API symmetry with the Linux driver; `SetThreadExecutionState`
   * has no equivalent of an identity string, so it is currently unused.
   */
  identity?: string;
  /** Invoked when the PowerShell child dies unexpectedly. */
  onPrimitiveDied?: () => void;
}

// SetThreadExecutionState flags (winbase.h). ES_CONTINUOUS keeps the assertion
// in effect until it is explicitly cleared (i.e. for the lifetime of the
// holding thread / process). These names map to PowerShell variables defined in
// the generated command, so the spawned program ORs them by their symbolic name.
const FLAG_VALUES: Record<string, string> = {
  ES_CONTINUOUS: "0x80000000",
  ES_SYSTEM_REQUIRED: "0x00000001",
  ES_DISPLAY_REQUIRED: "0x00000002",
};

function probePowershell(override?: string): { path: string; found: boolean } {
  if (override) {
    return { path: override, found: existsSync(override) };
  }
  // Prefer Windows PowerShell, then fall back to PowerShell Core (pwsh).
  const candidates = [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "powershell.exe",
    "pwsh",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { path: candidate, found: true };
    }
  }
  // Last resort: ask the shell to resolve one on PATH.
  for (const name of ["powershell.exe", "pwsh"]) {
    try {
      const result = execSync(`where ${name} 2>NUL`, { encoding: "utf8" })
        .split(/\r?\n/)[0]
        ?.trim();
      if (result) {
        return { path: result, found: true };
      }
    } catch {
      // `where` not available or binary not found
    }
  }
  return { path: "powershell.exe", found: false };
}

/**
 * Build the per-axis flag name set for `SetThreadExecutionState`. Returns the
 * ordered list of flag names (always starting with `ES_CONTINUOUS`), or `null`
 * when no axis is engaged.
 *
 * The joined names also act as the coalescing key: identical axis state yields
 * an identical list, so we can short-circuit re-spawns.
 */
function executionStateFlagNames(state: WakeLockState): string[] | null {
  if (!state.system && !state.display) return null;
  const names = ["ES_CONTINUOUS"];
  if (state.system) names.push("ES_SYSTEM_REQUIRED");
  if (state.display) names.push("ES_DISPLAY_REQUIRED");
  return names;
}

/**
 * Compose the PowerShell program that defines `SetThreadExecutionState` via
 * `Add-Type`, applies the OR of `flagNames`, and then blocks forever so the
 * assertion is held for the lifetime of the child (the same "supervise a
 * long-lived child" pattern as macOS `caffeinate` / Linux `systemd-inhibit`).
 * Killing the child lets the thread exit, which clears the execution-state
 * request.
 */
function powershellCommand(flagNames: string[]): string {
  // Define each flag as a named PowerShell variable, then OR them together by
  // name so the program reads like the Win32 contract it implements.
  const declarations = flagNames.map((name) => `$${name} = ${FLAG_VALUES[name]}`);
  const orExpression = flagNames.map((name) => `$${name}`).join(" -bor ");
  return [
    "$signature = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);';",
    "$type = Add-Type -MemberDefinition $signature -Name 'Pervigil' -Namespace 'Win32' -PassThru;",
    `${declarations.join("; ")};`,
    `[void]$type::SetThreadExecutionState(${orExpression});`,
    "while ($true) { Start-Sleep -Seconds 3600 }",
  ].join(" ");
}

/** Windows driver backed by `SetThreadExecutionState` via PowerShell. */
export class WindowsDriver implements Driver {
  readonly platform: string;
  readonly available: boolean;
  readonly degradedReason: DegradedReason;

  private readonly _powershellPath: string;
  private readonly _logger: Logger | undefined;
  private readonly _diedCallbacks: (() => void)[] = [];
  private _child: ChildProcess | null = null;
  private _currentFlags: string | null = null;
  private _restarts = 0;

  constructor(opts: WindowsDriverOptions = {}) {
    this._logger = opts.logger;
    if (opts.onPrimitiveDied) this._diedCallbacks.push(opts.onPrimitiveDied);

    const probe = probePowershell(opts.powershellPath);
    this._powershellPath = probe.path;

    if (probe.found) {
      this.platform = "windows-powershell";
      this.available = true;
      this.degradedReason = null;
    } else {
      this.platform = "windows-noop";
      this.available = false;
      this.degradedReason = "missing-binary";
      this._logger?.warn(
        { path: this._powershellPath },
        "PowerShell not found — sleep inhibitor disabled. Install Windows PowerShell or PowerShell (pwsh), or place it on PATH.",
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

    const flagNames = executionStateFlagNames(state);

    if (flagNames === null) {
      if (this._child !== null) {
        await this._killChild();
      }
      this._currentFlags = null;
      return;
    }

    const flagKey = flagNames.join("|");

    if (this._child !== null && this._currentFlags === flagKey) {
      // No work: the assertion already covers this axis state. `description` is
      // for debug logging only — SetThreadExecutionState carries no reason text.
      return;
    }

    // Spawn the new assertion first, then kill the previous one — so we never
    // drop the assertion across an axis flip.
    const previousChild = this._child;
    const args = ["-NoProfile", "-NonInteractive", "-Command", powershellCommand(flagNames)];
    const child = spawn(this._powershellPath, args, {
      detached: false,
      stdio: "ignore",
    });

    const clearIfCurrent = () => {
      if (this._child === child) {
        this._child = null;
        this._currentFlags = null;
      }
    };

    child.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        this._logger?.warn({ err }, "PowerShell not found — sleep inhibitor disabled");
      } else {
        this._logger?.warn({ err }, "PowerShell child error");
      }
      clearIfCurrent();
    });

    // Normal exit (operator killed it externally, OOM, etc.) must clear our
    // bookkeeping too — otherwise the same-flags short-circuit would silently
    // run with a dropped assertion.
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this._child === child) {
        this._restarts += 1;
        this._logger?.warn(
          { code, signal },
          "PowerShell exited unexpectedly — sleep inhibitor dropped, will re-engage on next change",
        );
        this._emitPrimitiveDied();
      }
      clearIfCurrent();
    });

    this._child = child;
    this._currentFlags = flagKey;
    this._logger?.debug?.({ description, flags: flagNames }, "SetThreadExecutionState engaged");

    if (previousChild !== null) {
      await killChild(previousChild);
    }
  }

  async shutdown(): Promise<void> {
    if (this._child === null) {
      this._currentFlags = null;
      return;
    }
    await this._killChild();
    this._currentFlags = null;
  }

  private async _killChild(): Promise<void> {
    const child = this._child;
    if (child === null) return;
    this._child = null;
    await killChild(child);
  }
}
