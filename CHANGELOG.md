# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
