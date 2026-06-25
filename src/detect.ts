import { existsSync } from "node:fs";
import type { LogLevel, Driver, Logger } from "./types.js";
import { resolveLogger } from "./internal/logger.js";
import { NoopDriver } from "./drivers/noop.js";
import { MacOSDriver } from "./drivers/macos.js";
import { LinuxDriver } from "./drivers/linux.js";
import { WindowsDriver } from "./drivers/windows.js";

function isContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env["container"]) return true;
  if (process.platform === "linux" && existsSync("/run/.containerenv")) return true;
  return false;
}

export interface DetectOptions {
  /** Force the no-op driver (also honoured via `PERVIGIL_FORCE_NOOP=1`). */
  forceNoop?: boolean;
  /**
   * Sink for pervigil's log lines (warnings about degraded/no-op modes, plus
   * an info line naming the selected backend). Defaults to a built-in console
   * sink, but only emits once {@link DetectOptions.logLevel} (or
   * `PERVIGIL_LOG_LEVEL`) opts in — pervigil is silent by default.
   */
  logger?: Logger;
  /**
   * Emission threshold for pervigil's own logs. Defaults to `silent` (no
   * output) unless a `logger` is supplied. Also settable via the
   * `PERVIGIL_LOG_LEVEL` env var.
   */
  logLevel?: LogLevel;
  /** Stable identity surfaced to the OS (systemd `--who=`, sysfs cookie). */
  identity?: string;
  /** Invoked when the underlying OS primitive dies unexpectedly. */
  onPrimitiveDied?: () => void;
}

/**
 * Pick the best wake-lock driver for the current platform. Returns a
 * {@link NoopDriver} (with a warning on the resolved logger) inside
 * containers or on unsupported platforms — it never throws.
 */
export function detectDriver(opts: DetectOptions = {}): Driver {
  const { identity, onPrimitiveDied } = opts;
  const logger = resolveLogger({ logger: opts.logger, logLevel: opts.logLevel });

  if (opts.forceNoop || process.env["PERVIGIL_FORCE_NOOP"] === "1") {
    return new NoopDriver("forced");
  }

  if (isContainer()) {
    logger?.warn(
      { platform: process.platform },
      "Running in a container — host sleep primitives unreachable; pervigil is a no-op.",
    );
    return new NoopDriver("container");
  }

  if (process.platform === "darwin") {
    const driver = new MacOSDriver({ logger, identity, onPrimitiveDied });
    logger?.info?.({ platform: driver.platform, available: driver.available }, "pervigil: using " + driver.platform);
    return driver;
  }

  if (process.platform === "linux") {
    const driver = new LinuxDriver({ logger, identity, onPrimitiveDied });
    logger?.info?.({ platform: driver.platform, available: driver.available }, "pervigil: using " + driver.platform);
    return driver;
  }

  if (process.platform === "win32") {
    const driver = new WindowsDriver({ logger, identity, onPrimitiveDied });
    logger?.info?.({ platform: driver.platform, available: driver.available }, "pervigil: using " + driver.platform);
    return driver;
  }

  // Remaining platforms (e.g. freebsd) have no sleep-inhibitor backend. Warn so
  // it isn't silently lost.
  logger?.warn(
    { platform: process.platform },
    "No sleep-inhibitor backend for this platform — pervigil is a no-op. Configure host-side sleep prevention manually.",
  );
  return new NoopDriver("unsupported-platform");
}
