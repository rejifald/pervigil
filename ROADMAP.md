# Roadmap

## Windows support (`SetThreadExecutionState`)

**Status: shipped.** Windows resolves to
[`WindowsWakeLockDriver`](src/drivers/windows.ts), backed by
`SetThreadExecutionState`, and is wired into `detectDriver()`'s
`process.platform === "win32"` branch — see [`src/detect.ts`](src/detect.ts).

How it works:

- `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` → system axis
- `ES_CONTINUOUS | ES_DISPLAY_REQUIRED` → display axis
- **Preserves the zero-native-dependency promise.** It spawns a small PowerShell
  command (`powershell.exe`, falling back to `pwsh`) that calls
  `SetThreadExecutionState` via `Add-Type`, then holds the assertion alive with a
  long-lived loop — the same "supervise a long-lived child" pattern as macOS
  `caffeinate` / Linux `systemd-inhibit`. No `ffi-napi` / `koffi`, no `node-gyp`.
- Mirrors the macOS/Linux driver contract: `available`, `degradedReason`,
  `restarts`, supervised re-engage, idempotent `setState`/`shutdown`.

When PowerShell is absent, the driver degrades gracefully to a no-op with
`available === false` and `degradedReason === "missing-binary"`. Other platforms
(e.g. freebsd) still resolve to `NoopWakeLockDriver` with
`degradedReason === "unsupported-platform"`; callers there should configure
host-side sleep prevention manually.

## Possible follow-ups

- Optional metrics adapter (Prometheus/OpenTelemetry) over the existing counters.
