# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release: cross-platform host sleep / display-sleep inhibitor.
- `keepAwake()` / `keepAwake.while()` simple entry points, with
  `Symbol.asyncDispose` support.
- `createWakeLock()` supervised multi-reason controller with `status()`,
  counters, and events.
- macOS (`caffeinate`) and Linux (`systemd-inhibit`, `/sys/power/wake_lock`)
  drivers; graceful no-op in containers / on unsupported platforms.
- `pervigil/testing` mock driver.

### Not yet

- Windows support — see [ROADMAP.md](ROADMAP.md).
