import type { DegradedReason, WakeLockDriver, WakeLockState } from "../types.js";

export interface MockSetStateCall {
  state: WakeLockState;
  description: string;
}

/**
 * In-memory driver for tests.
 *
 * Tracking surface:
 *   - `setStateCalls`     — every setState call, in order.
 *   - `engageCalls`       — descriptions of setState calls whose post-call
 *                           state has at least one axis engaged. Note: same
 *                           state re-called bumps this — use
 *                           `engageTransitions` if you want false→true edges.
 *   - `engageTransitions` — count of transitions where some axis went from
 *                           false→true. The clean signal for "the driver
 *                           was activated N times".
 *   - `disengageCalls`    — timestamps of every all-axes-off transition,
 *                           including the implicit one inside `shutdown()`.
 *   - `shutdownCalls`     — timestamps of every `shutdown()` call.
 */
export class MockWakeLockDriver implements WakeLockDriver {
  readonly platform = "mock";
  readonly available = true;
  readonly degradedReason: DegradedReason = null;
  readonly restarts = 0;

  readonly setStateCalls: MockSetStateCall[] = [];
  readonly engageCalls: string[] = [];
  readonly disengageCalls: number[] = [];
  readonly shutdownCalls: number[] = [];

  private _engageTransitions = 0;
  private lastState: WakeLockState = { system: false, display: false };

  get engageTransitions(): number {
    return this._engageTransitions;
  }

  async setState(state: WakeLockState, description: string): Promise<void> {
    this.setStateCalls.push({ state, description });

    const wasEngaged = this.lastState.system || this.lastState.display;
    const isEngaged = state.system || state.display;

    if (isEngaged) {
      this.engageCalls.push(description);
    }
    if (!wasEngaged && isEngaged) {
      this._engageTransitions += 1;
    }
    if (wasEngaged && !isEngaged) {
      this.disengageCalls.push(Date.now());
    }

    this.lastState = state;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls.push(Date.now());
    if (this.lastState.system || this.lastState.display) {
      this.disengageCalls.push(Date.now());
    }
    this.lastState = { system: false, display: false };
  }
}
