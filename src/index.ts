// ── Simple entry point ───────────────────────────────────────────────────
export { keepAwake } from "./keep-awake.js";
export type { KeepAwakeOptions, WakeLockHandle } from "./keep-awake.js";

// ── Auto-release on process exit ─────────────────────────────────────────
export { autoReleaseOnExit } from "./auto-release.js";
export type { AutoReleaseOnExitOptions } from "./auto-release.js";

// ── Supervised multi-reason controller ───────────────────────────────────
export { createWakeLock } from "./controller.js";
export type {
  AcquireOptions,
  CreateWakeLockOptions,
  WakeLock,
  WakeLockEvent,
  WakeLockStatus,
} from "./controller.js";

// ── Driver detection + concrete drivers (advanced wiring / testing) ───────
export { detectDriver } from "./detect.js";
export type { DetectDriverOptions } from "./detect.js";
export { NoopWakeLockDriver } from "./drivers/noop.js";
export { MacOSWakeLockDriver } from "./drivers/macos.js";
export type { MacOSWakeLockDriverOptions } from "./drivers/macos.js";
export { LinuxWakeLockDriver } from "./drivers/linux.js";
export type { LinuxWakeLockDriverOptions } from "./drivers/linux.js";
export { WindowsWakeLockDriver } from "./drivers/windows.js";
export type { WindowsWakeLockDriverOptions } from "./drivers/windows.js";

// ── Shared types ─────────────────────────────────────────────────────────
export type {
  DegradedReason,
  PervigilLogLevel,
  WakeAxis,
  WakeLockDriver,
  WakeLockLogger,
  WakeLockState,
  WakeReason,
} from "./types.js";
