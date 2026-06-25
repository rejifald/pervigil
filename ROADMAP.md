# Roadmap

## Windows support (`SetThreadExecutionState`)

**Status: not implemented.** Today Windows (and any non-macOS, non-Linux
platform) resolves to `NoopWakeLockDriver` with a warning — see
[`src/detect.ts`](src/detect.ts).

Plan:

- Add `WindowsWakeLockDriver` backed by `SetThreadExecutionState`:
  - `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` → system axis
  - `ES_CONTINUOUS | ES_DISPLAY_REQUIRED` → display axis
- **Implementation must preserve the zero-native-dependency promise.** Prefer
  spawning a small PowerShell command that calls `SetThreadExecutionState` via
  `Add-Type`, the same approach other pure-JS tools use. Do **not** reach for
  `ffi-napi` / `koffi` — a native addon would reintroduce `node-gyp` install
  friction, which is one of the library's core differentiators.
- Wire it into `detectDriver()`'s `process.platform === "win32"` branch.
- Mirror the macOS/Linux driver contract: `available`, `degradedReason`,
  `restarts`, supervised re-engage, idempotent `setState`/`shutdown`.
- Add a `windows.test.ts` mirroring the existing driver tests (mock the spawn).

Until then, `available === false` and `degradedReason === "unsupported-platform"`
on Windows, and callers should configure host-side sleep prevention manually.

## Possible follow-ups

- Optional metrics adapter (Prometheus/OpenTelemetry) over the existing counters.
- A timed-window helper (auto-release after a duration).
