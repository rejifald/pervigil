// ── Simple entry point ───────────────────────────────────────────────────
export { keepAwake } from "./keep-awake.js";
export type { KeepAwakeOptions, WakeLockHandle } from "./keep-awake.js";

// ── Auto-release on process exit ─────────────────────────────────────────
export { releaseOnExit } from "./auto-release.js";
export type { AutoReleaseOptions } from "./auto-release.js";

// ── Supervised multi-reason controller ───────────────────────────────────
export { wakeLock } from "./controller.js";
export type {
  AcquireOptions,
  WakeLockOptions,
  WakeLock,
  WakeLockEvent,
  WakeLockStatus,
} from "./controller.js";

// ── Driver detection + concrete drivers (advanced wiring / testing) ───────
export { detectDriver } from "./detect.js";
export type { DetectOptions } from "./detect.js";
export { NoopDriver } from "./drivers/noop.js";
export { MacOSDriver } from "./drivers/macos.js";
export type { MacOSDriverOptions } from "./drivers/macos.js";
export { LinuxDriver } from "./drivers/linux.js";
export type { LinuxDriverOptions } from "./drivers/linux.js";
export { WindowsDriver } from "./drivers/windows.js";
export type { WindowsDriverOptions } from "./drivers/windows.js";

// ── Shared types ─────────────────────────────────────────────────────────
export type {
  DegradedReason,
  Driver,
  Logger,
  LogLevel,
  WakeAxis,
  WakeLockState,
  WakeReason,
} from "./types.js";
