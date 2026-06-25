import type { DegradedReason, WakeLockDriver, WakeLockState } from "../types.js";

/** A driver that does nothing — used on unsupported platforms / in containers. */
export class NoopWakeLockDriver implements WakeLockDriver {
  readonly platform = "noop";
  readonly available = false;
  readonly degradedReason: DegradedReason;
  readonly restarts = 0;

  constructor(reason: Exclude<DegradedReason, null> = "unsupported-platform") {
    this.degradedReason = reason;
  }

  async setState(_state: WakeLockState, _description: string): Promise<void> {
    // no-op
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}
