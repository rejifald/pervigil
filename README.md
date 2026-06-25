# pervigil

[![npm version](https://img.shields.io/npm/v/pervigil.svg)](https://www.npmjs.com/package/pervigil)
[![CI](https://github.com/rejifald/pervigil/actions/workflows/ci.yml/badge.svg)](https://github.com/rejifald/pervigil/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/pervigil.svg)](https://www.npmjs.com/package/pervigil)
[![license: MIT](https://img.shields.io/npm/l/pervigil.svg)](LICENSE)
[![types: included](https://img.shields.io/npm/types/pervigil.svg)](https://www.npmjs.com/package/pervigil)

> _Latin **pervigil**: ever-wakeful, keeping watch all night long._

Cross-platform host **sleep / display-sleep inhibitor** for Node — keeps the
machine awake while long jobs run.

- **Zero runtime dependencies. No native addons, no `node-gyp`** — it spawns the
  OS's own mechanism, so it installs cleanly on Alpine/musl, ARM, Docker and CI
  with no build toolchain.
- **Two independent axes** — block *system* sleep and *display* sleep
  separately.
- **Graceful no-op** — in containers, on unsupported platforms, or when the OS
  primitive is missing, it degrades to a single warning instead of throwing.
- **Supervised** — if the OS primitive dies, it re-engages on the next change.
- **Observable** — a `status()` snapshot plus counters and events answer *"is the
  host awake, why, on what backend, and for how long?"*
- **Typed & testable** — first-class TypeScript, an injectable driver, and a
  shipped mock (`pervigil/testing`).

| Platform | Mechanism |
| --- | --- |
| macOS | `caffeinate(1)` |
| Linux | `systemd-inhibit(1)`, falling back to `/sys/power/wake_lock` |
| Windows | `SetThreadExecutionState` via a spawned PowerShell process (no native addon) |

Every backend uses the same "supervise a long-lived child" pattern, so there is
**no native addon and no `node-gyp`** on any platform.

## Install

```sh
npm install pervigil
```

## Quick start

```ts
import { keepAwake } from "pervigil";

const lock = await keepAwake({ system: true, reason: "nightly backup" });
try {
  await runLongJob();
} finally {
  await lock.release();
}
```

Scoped variant — auto-releases even if the callback throws:

```ts
import { keepAwake } from "pervigil";

await keepAwake.while({ system: true, reason: "backup" }, runLongJob);
```

Or with explicit resource management (Node 20.4+ / TS 5.2+):

```ts
await using lock = await keepAwake({ display: true, reason: "rendering preview" });
```

By default only **system** sleep is blocked. Pass `display: true` to also keep
the screen on.

### Timed windows

Hold the lock for a fixed duration, or until a wall-clock instant. The
auto-release runs on an `unref()`'d timer (so it never keeps the event loop
alive), and an early `release()` cancels it — it never double-releases:

```ts
const lock = await keepAwake.for({ system: true, reason: "warm-up" }, 30_000);
const lock2 = await keepAwake.until({ display: true }, new Date(Date.now() + 60_000));
```

### Shared instance

When many independent callers each want "keep the host awake", `keepAwake.shared()`
coalesces them onto **one** OS primitive — N concurrent holds spawn one primitive,
not N. Each handle's `release()` removes only its own hold; call
`keepAwake.shutdownShared()` to tear the shared primitive down (e.g. on exit):

```ts
const a = await keepAwake.shared({ reason: "task a" });
const b = await keepAwake.shared({ reason: "task b" }); // reuses a's primitive
await a.release();
await b.release();
await keepAwake.shutdownShared();
```

### Auto-release on process exit

`autoReleaseOnExit` releases any lock-like object (anything with `shutdown()`)
on `beforeExit` and on `SIGINT` / `SIGTERM`, exactly once. It returns an
unregister function so you can hand teardown back to your own signal handlers:

```ts
import { createWakeLock, autoReleaseOnExit } from "pervigil";

const wl = createWakeLock();
const stop = autoReleaseOnExit(wl); // wl.shutdown() runs on exit / Ctrl-C
// ... later, if you take over shutdown yourself:
stop();
```

## Supervised, multi-reason controller

For daemons that hold several overlapping reasons, use `createWakeLock`. It
reconciles reasons (by key) onto the two axes and drives one OS primitive:

```ts
import { createWakeLock } from "pervigil";

const wl = createWakeLock({ identity: "my-app" }); // identity shows in `systemd-inhibit --list`

wl.acquire("job:123", { system: true, description: "import job 123" });
wl.acquire("view:abc", { display: true, description: "live view abc" });

wl.release("job:123");      // system axis releases; display stays held
await wl.shutdown();        // release everything, tear down the primitive
```

## Observability

```ts
const wl = createWakeLock();
wl.on("engaged", (s) => console.log("awake:", s.reasons));
wl.on("degraded", (s) => console.warn("no-op:", s.degradedReason));

wl.status();
// {
//   platform: "macos-caffeinate",
//   available: true,
//   degradedReason: null,
//   engaged: { system: true, display: false },
//   reasons: { system: [{ key: "job:123", description: "import job 123" }], display: [] },
//   since: { system: 1718900000000, display: null },
//   counters: {
//     engageTransitions: { system: 1, display: 0 },
//     awakeMsTotal: { system: 42000, display: 0 },
//     primitiveRestarts: 0,
//   },
// }
```

Events: `engaged`, `disengaged`, `reasonsChanged`, `primitiveDied`, `degraded`.

For telemetry, `onEvent` is a single hook that fires on **every** event with a
fresh snapshot — wire it once at construction instead of subscribing to each:

```ts
const wl = createWakeLock({
  onEvent: (event, status) => metrics.record(event, status), // OTel/StatsD/logs
});
```

A throwing `onEvent` is swallowed, so a flaky telemetry backend can never break
the lock.

At the OS level you can also see the assertion directly — `pmset -g assertions`
on macOS, or `systemd-inhibit --list` (look for your `identity`) on Linux.

The `identity` you pass to `createWakeLock` surfaces the assertion's owner on
Linux (`systemd-inhibit --who=`, or the sysfs wake-lock cookie) and tags it on
Windows, but has no effect on macOS — `caffeinate(1)` exposes no equivalent, so
the value is silently ignored there.

## Metrics

`pervigil/metrics` turns the cumulative counters into Prometheus text or a
neutral sample list — **no `prom-client` dependency**, so you can adapt the
samples to OpenTelemetry, StatsD, JSON, or anything else:

```ts
import { createWakeLock } from "pervigil";
import { toPrometheus, collectMetrics } from "pervigil/metrics";

const wl = createWakeLock();

// Expose a /metrics endpoint (any HTTP framework):
res.setHeader("content-type", "text/plain; version=0.0.4");
res.end(toPrometheus(wl));

// …or adapt the neutral samples to another backend:
for (const s of collectMetrics(wl)) {
  myBackend.record(s.name, s.value, { type: s.type, ...s.labels });
}
```

Emits `pervigil_available`, `pervigil_awake{axis}`, `pervigil_awake_ms_total{axis}`,
`pervigil_engage_transitions_total{axis}`, and `pervigil_primitive_restarts_total`.

### OpenTelemetry

`collectMetrics()` adapts to OpenTelemetry without pervigil depending on the OTel
SDK — you bring `@opentelemetry/api` and read the samples from an observable
callback:

```ts
import { metrics } from "@opentelemetry/api";
import { createWakeLock } from "pervigil";
import { collectMetrics } from "pervigil/metrics";

const wl = createWakeLock();
const meter = metrics.getMeter("pervigil");

for (const name of ["pervigil_awake", "pervigil_awake_ms_total"]) {
  meter.createObservableGauge(name).addCallback((result) => {
    for (const s of collectMetrics(wl).filter((m) => m.name === name)) {
      result.observe(s.value, s.labels);
    }
  });
}
```

## Testing

A deterministic in-memory driver lives at `pervigil/testing` so it never ships
in production bundles:

```ts
import { createWakeLock } from "pervigil";
import { MockWakeLockDriver } from "pervigil/testing";

const driver = new MockWakeLockDriver();
const wl = createWakeLock({ driver });

await wl.acquire("job", { system: true });
expect(driver.engageTransitions).toBe(1);
```

## Behaviour when unsupported

`detectDriver()` returns a no-op driver — and `available` / `degradedReason`
report why — in these cases:

- inside a container (`/.dockerenv`, `container` env, `/run/.containerenv`);
- on a platform with no inhibitor backend (e.g. FreeBSD);
- when the platform binary (`caffeinate` / `systemd-inhibit` / PowerShell) is
  absent.

Set `PERVIGIL_FORCE_NOOP=1` (or `forceNoop: true`) to force it. In every case the
job still runs — it just isn't kept awake — and, **if you've enabled logging**
(see below), you get exactly one warning explaining why.

## Logging

pervigil is **silent by default** — it never writes to your console unless you
opt in. Turn it on with a level, either per-call or via the environment:

```ts
const wl = createWakeLock({ logLevel: "warn" }); // built-in console sink
```

```sh
PERVIGIL_LOG_LEVEL=debug node app.js
```

Levels are `silent` | `warn` | `info` | `debug`. Resolution is `logLevel` option
→ `PERVIGIL_LOG_LEVEL` → default (`silent`). At `warn` you see degraded-mode
warnings (container, missing binary, unsupported platform); `info` adds the
selected-backend line; `debug` adds per-assertion detail.

Prefer your own logger? Pass any pino-shaped sink (`warn`, optional `info` /
`debug`) and pervigil routes through it instead of the console:

```ts
import pino from "pino";
const wl = createWakeLock({ logger: pino() }); // forwards everything; pino filters
```

`logLevel: "silent"` hard-mutes even a supplied logger.

## License

[MIT](LICENSE) © Oleksandr Zhuravlov
