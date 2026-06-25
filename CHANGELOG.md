# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-06-25

### Added

- Configurable logging. A new `logLevel` option (`"silent" | "warn" | "info" |
  "debug"`) and `PERVIGIL_LOG_LEVEL` env var control pervigil's own verbosity,
  with a built-in console sink so you get useful output (e.g. the container
  no-op warning) without wiring a logger. pervigil stays **silent by default**;
  a supplied `logger` is used as the sink, and `logLevel: "silent"` hard-mutes
  it. Exposed on `keepAwake`, `createWakeLock`, and `detectDriver`.
- `onEvent` telemetry hook on `createWakeLock` / `keepAwake`: a single callback
  fired on every lifecycle event with a fresh status snapshot — one place to
  forward to OpenTelemetry, StatsD, or logs without subscribing to each event.
  A throwing handler is swallowed so it can never break the lock.
- `PervigilLogLevel` exported from the package root.
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
