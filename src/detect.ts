import { existsSync } from "node:fs";
import type { WakeLockDriver, WakeLockLogger } from "./types.js";
import { NoopWakeLockDriver } from "./drivers/noop.js";
import { MacOSWakeLockDriver } from "./drivers/macos.js";
import { LinuxWakeLockDriver } from "./drivers/linux.js";

function isContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env["container"]) return true;
  if (process.platform === "linux" && existsSync("/run/.containerenv")) return true;
  return false;
}

function logSelectedDriver(driver: WakeLockDriver, logger?: WakeLockLogger): WakeLockDriver {
  if (driver.available) {
    logger?.info?.(
      { platform: driver.platform, available: driver.available },
      "Selected wake-lock backend.",
    );
  }
  return driver;
}

export interface DetectDriverOptions {
  /** Force the no-op driver (also honoured via `PERVIGIL_FORCE_NOOP=1`). */
  forceNoop?: boolean;
  /** Optional logger — used for fallback / unsupported-platform warnings. */
  logger?: WakeLockLogger;
  /** Stable identity surfaced to the OS (systemd `--who=`, sysfs cookie). */
  identity?: string;
  /** Invoked when the underlying OS primitive dies unexpectedly. */
  onPrimitiveDied?: () => void;
}

/**
 * Pick the best wake-lock driver for the current platform. Returns a
 * {@link NoopWakeLockDriver} (with a warning on the supplied logger) inside
 * containers or on unsupported platforms — it never throws.
 */
export function detectDriver(opts: DetectDriverOptions = {}): WakeLockDriver {
  const { logger, identity, onPrimitiveDied } = opts;

  if (opts.forceNoop || process.env["PERVIGIL_FORCE_NOOP"] === "1") {
    return new NoopWakeLockDriver("forced");
  }

  if (isContainer()) {
    logger?.warn(
      { platform: process.platform },
      "Running in a container — host sleep primitives unreachable; pervigil is a no-op.",
    );
    return new NoopWakeLockDriver("container");
  }

  if (process.platform === "darwin") {
    return logSelectedDriver(
      new MacOSWakeLockDriver({ logger, identity, onPrimitiveDied }),
      logger,
    );
  }

  if (process.platform === "linux") {
    return logSelectedDriver(
      new LinuxWakeLockDriver({ logger, identity, onPrimitiveDied }),
      logger,
    );
  }

  // win32 and other platforms are not yet implemented — see ROADMAP.md
  // (Windows via SetThreadExecutionState). Warn so it isn't silently lost.
  logger?.warn(
    { platform: process.platform },
    "No sleep-inhibitor backend for this platform — pervigil is a no-op. Configure host-side sleep prevention manually.",
  );
  return new NoopWakeLockDriver("unsupported-platform");
}
