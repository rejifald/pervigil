import type { WakeAxis, WakeLockDriver, WakeLockState, WakeReason } from "./types.js";

function joinedDescription(reasons: Iterable<WakeReason>): string {
  const descs = [...new Set([...reasons].map((r) => r.description ?? r.key))].sort();
  return descs.join(", ");
}

interface AxisState {
  reasons: Map<string, WakeReason>;
}

export interface EngineHooks {
  /**
   * Called after a real state transition (an axis flipped on or off). Not
   * called for description-only refreshes. `prev` is the state before the flip.
   */
  onFlush?(state: WakeLockState, prev: WakeLockState): void;
}

/**
 * The reconcile engine. Holds a desired reason set per axis and drives the
 * injected {@link WakeLockDriver} whenever the derived (system, display) state
 * or the joined description changes. Idempotent calls are coalesced.
 */
export class WakeLockEngine {
  private readonly system: AxisState = { reasons: new Map() };
  private readonly display: AxisState = { reasons: new Map() };
  private lastState: WakeLockState = { system: false, display: false };
  private lastDescription = "";
  private shutdown_ = false;

  constructor(
    private readonly driver: WakeLockDriver,
    private readonly hooks: EngineHooks = {},
  ) {}

  /** Replace the reason set for one axis and reconcile the driver. */
  async applyAxis(axis: WakeAxis, next: readonly WakeReason[]): Promise<void> {
    if (this.shutdown_) return;
    const target = axis === "system" ? this.system : this.display;
    this.replaceReasons(target, next);
    await this.flush();
  }

  /**
   * Replace BOTH axis reason sets and reconcile the driver exactly once. A
   * change that touches both axes therefore drives a single `setState`,
   * avoiding a wrong intermediate state and a needless OS-primitive respawn.
   */
  async applyAxes(
    system: readonly WakeReason[],
    display: readonly WakeReason[],
  ): Promise<void> {
    if (this.shutdown_) return;
    this.replaceReasons(this.system, system);
    this.replaceReasons(this.display, display);
    await this.flush();
  }

  private replaceReasons(target: AxisState, next: readonly WakeReason[]): void {
    target.reasons.clear();
    for (const r of next) {
      target.reasons.set(r.key, r);
    }
  }

  /** Whether the given axis currently holds at least one reason. */
  isEngaged(axis: WakeAxis): boolean {
    return (axis === "system" ? this.system : this.display).reasons.size > 0;
  }

  /**
   * Release every axis and tear down the driver. Idempotent: a second call is
   * a no-op. Always calls `driver.shutdown()` exactly once.
   */
  async shutdown(): Promise<void> {
    if (this.shutdown_) return;
    this.shutdown_ = true;
    const prev = this.lastState;
    this.system.reasons.clear();
    this.display.reasons.clear();
    this.lastState = { system: false, display: false };
    this.lastDescription = "";
    await this.driver.shutdown();
    if (prev.system || prev.display) {
      this.hooks.onFlush?.(this.lastState, prev);
    }
  }

  private async flush(): Promise<void> {
    const nextState: WakeLockState = {
      system: this.system.reasons.size > 0,
      display: this.display.reasons.size > 0,
    };

    const description = joinedDescription([
      ...this.system.reasons.values(),
      ...this.display.reasons.values(),
    ]);

    const stateChanged =
      nextState.system !== this.lastState.system || nextState.display !== this.lastState.display;
    const descriptionChanged = description !== this.lastDescription;

    if (!stateChanged && !descriptionChanged) return;

    const prev = this.lastState;
    this.lastState = nextState;
    this.lastDescription = description;
    await this.driver.setState(nextState, description);
    if (stateChanged) {
      this.hooks.onFlush?.(nextState, prev);
    }
  }
}
