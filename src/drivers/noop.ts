import type { DegradedReason, Driver, WakeLockState } from "../types.js";

/** A driver that does nothing — used on unsupported platforms / in containers. */
export class NoopDriver implements Driver {
  readonly platform = "noop";
  readonly available = false;
  readonly degradedReason: DegradedReason;
  readonly restarts = 0;
  /** A no-op driver never holds a real assertion. */
  readonly held = false;

  constructor(reason: Exclude<DegradedReason, null> = "unsupported-platform") {
    this.degradedReason = reason;
  }

  async setState(_state: WakeLockState, _description: string): Promise<void> {
    // no-op
  }

  async shutdown(): Promise<void> {
    // no-op
  }

  onPrimitiveDied(_cb: () => void): void {
    // The no-op driver has no OS primitive that can die, so registered
    // callbacks are never invoked.
  }
}
