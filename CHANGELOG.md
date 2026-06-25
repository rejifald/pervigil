# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-06-25

### Added

- **Function log sinks.** `logger` now also accepts a `(record) => void`
  callback, not just a method-shaped object. Each line arrives as a normalised
  `LogRecord` (`{ level, msg?, fields }`, with `fields` always an object), so
  loggers whose argument order isn't `(fields, msg)` — winston, consola — map
  cleanly: `wakeLock({ logger: (r) => winston.log(r.level, r.msg ?? "", r.fields) })`.
  Method sinks (pino / bunyan / `console`) are unchanged. Level gating and
  `logLevel: "silent"` apply identically to both shapes. New exported types
  `LoggerFn` and `LogRecord`.

### Changed

- Broadened npm `keywords` and sharpened the package `description` for
  discoverability. No API change.

### Fixed

- `releaseOnExit` now **re-raises** the signal after releasing, so a process
  that opts into `SIGINT` / `SIGTERM` coverage still terminates. Previously the
  installed signal listener suppressed Node's default exit and the process could
  hang after release instead of exiting.

## [0.4.0] - 2026-06-25

### Added

- `status().active` — the truth of whether a real OS assertion is in effect
  **right now**, distinct from `available` (the driver is capable) and `engaged`
  (a reason is desired). Goes `false` when degraded, when nothing is held, or
  when the primitive died and hasn't re-engaged. Backed by a new optional
  `Driver.held` getter (implemented by all built-in drivers + the mock).
- `strict` option on `wakeLock` / `keepAwake`. When `true`, `acquire` rejects
  with the new `WakeLockUnavailableError` (carrying `degradedReason` + `platform`)
  instead of degrading to a silent no-op — for jobs that must not run unless the
  host is genuinely kept awake. Default stays a graceful, never-throwing no-op.
- `pervigil_active` gauge in `pervigil/metrics` — the "is the host actually
  awake right now" signal to alert on.

### Changed

- **Auto-release on process exit is now the default.** A forgotten `shutdown()`
  no longer leaks an orphaned `caffeinate` / `systemd-inhibit` / PowerShell
  child: every lock tears its primitive down via a single shared `process`
  `"exit"` handler (no signal listeners, so Ctrl-C is unaffected). Opt out with
  `autoRelease: false`. The `releaseOnExit()` helper remains for explicit
  `SIGINT` / `SIGTERM` coverage.
- **BREAKING:** `keepAwake`'s human-text option is now `description` (was
  `reason`), unifying on one term — `reason`/`WakeReason` is the keyed entry,
  `description` is its label (as `acquire` already used).
- **BREAKING:** `keepAwake.shared()` now accepts only the per-call axes
  (`system` / `display` / `description`), not controller config. The shared
  instance is always default-configured, removing the first-caller-wins config
  footgun. Need a configured controller? Create your own `wakeLock()` and share
  the reference.

## [0.3.0] - 2026-06-25

### Changed

- **BREAKING: concise public API names.** Redundant `WakeLock` / `Pervigil`
  prefixes were dropped before the first npm publish:
  - `createWakeLock` → `wakeLock`
  - `autoReleaseOnExit` → `releaseOnExit`
  - `NoopWakeLockDriver` / `MacOSWakeLockDriver` / `LinuxWakeLockDriver` /
    `WindowsWakeLockDriver` → `NoopDriver` / `MacOSDriver` / `LinuxDriver` /
    `WindowsDriver` (and their `*Options` types)
  - `MockWakeLockDriver` (`pervigil/testing`) → `MockDriver`
  - `WakeLockDriver` → `Driver`, `WakeLockLogger` → `Logger`,
    `PervigilLogLevel` → `LogLevel`
  - `CreateWakeLockOptions` → `WakeLockOptions`,
    `DetectDriverOptions` → `DetectOptions`,
    `AutoReleaseOnExitOptions` → `AutoReleaseOptions`

  `keepAwake`, `detectDriver`, and the `WakeLock` / `WakeLockStatus` /
  `WakeLockState` / `WakeLockEvent` / `WakeLockHandle` / `WakeReason` /
  `WakeAxis` types are unchanged.

### Added

- Configurable logging. A new `logLevel` option (`"silent" | "warn" | "info" |
"debug"`) and `PERVIGIL_LOG_LEVEL` env var control pervigil's own verbosity,
  with a built-in console sink so you get useful output (e.g. the container
  no-op warning) without wiring a logger. pervigil stays **silent by default**;
  a supplied `logger` is used as the sink, and `logLevel: "silent"` hard-mutes
  it. Exposed on `keepAwake`, `wakeLock`, and `detectDriver`.
- `onEvent` telemetry hook on `wakeLock` / `keepAwake`: a single callback fired
  on every lifecycle event with a fresh status snapshot — one place to forward
  to OpenTelemetry, StatsD, or logs without subscribing to each event. A
  throwing handler is swallowed so it can never break the lock.
- `LogLevel` exported from the package root.
- README: an OpenTelemetry recipe over `collectMetrics()` (no OTel SDK
  dependency) and a Logging section.

## [0.2.0] - 2026-06-25

### Added

- `pervigil/metrics`: a dependency-free adapter exposing `collectMetrics()` (a
  neutral metric-sample list) and `toPrometheus()` (text exposition) over the
  cumulative wake-lock counters — adapt the samples to OpenTelemetry, StatsD,
  JSON, or anything else without coupling to a metrics vendor. (#16)
- `keepAwake.shared()` / `keepAwake.shutdownShared()`: a lazily-created,
  module-level controller that coalesces overlapping simple locks onto **one**
  OS primitive (N concurrent holds spawn one primitive, not N). (#17)
- `autoReleaseOnExit(target)`: release any lock-like object on `beforeExit` /
  `SIGINT` / `SIGTERM`, exactly once, returning an unregister function. (#17)
- Startup info-level log naming the selected driver/backend on detection. (#15)

### Fixed

- `primitiveDied` now fires for **injected** drivers, not only self-built ones,
  so the controller's restart counter and event are accurate in tests and custom
  wiring. (#18)
- CommonJS type resolution: the `require` condition now resolves to `.d.cts`
  declarations, so CJS/TypeScript consumers get correct types (no more
  "masquerading as ESM"). `publint` and `are-the-types-wrong` are clean across
  all entry points and resolution modes.

### Changed

- Packaging: added `sideEffects: false` (better tree-shaking), `typesVersions`
  (fixes `node10`/classic subpath type resolution for `./testing` and
  `./metrics`), `publishConfig.access: public`, and a `./package.json` export.
- Documented that the macOS driver intentionally ignores `identity` —
  `caffeinate(1)` exposes no owner/identity equivalent. (#18)

## [0.1.0] - 2026-06-25

### Added

- Cross-platform host sleep / display-sleep inhibitor with two independent axes.
- `keepAwake()` / `keepAwake.while()` simple entry points, with
  `Symbol.asyncDispose` support.
- `keepAwake.for(opts, ms)` / `keepAwake.until(opts, when)` timed-window helpers
  that auto-release on an `unref()`'d timer (early `release()` cancels it).
- `createWakeLock()` supervised multi-reason controller with `status()`,
  counters, and events. Both-axes changes reconcile in a single driver call, and
  all state operations are serialized so concurrent `acquire`/`release` can't
  interleave.
- Drivers: macOS (`caffeinate`), Linux (`systemd-inhibit`,
  `/sys/power/wake_lock`), and Windows (`SetThreadExecutionState` via PowerShell,
  no native deps). Graceful no-op in containers / on unsupported platforms.
- `pervigil/testing` mock driver.
