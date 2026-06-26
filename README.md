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
- **Two independent axes** — block _system_ sleep and _display_ sleep
  separately.
- **Fail-safe by default** — in containers, on unsupported platforms, or when
  the OS primitive is missing, it degrades to a silent no-op instead of
  throwing, so your job always runs. Opt into **fail-fast** with `strict`, or
  read `.active` for the truth.
- **Supervised** — if the OS primitive dies, it re-engages on the next change.
- **Self-cleaning** — releases the OS primitive automatically when the process
  exits, so a forgotten `release()` never leaks an orphaned `caffeinate` /
  `systemd-inhibit` child. Opt out with `autoRelease: false`.
- **Observable** — a `status()` snapshot plus counters and events answer _"is the
  host awake, why, on what backend, and for how long?"_
- **Typed & testable** — first-class TypeScript, an injectable driver, and a
  shipped mock (`pervigil/testing`).

| Platform | Mechanism                                                                    |
| -------- | ---------------------------------------------------------------------------- |
| macOS    | `caffeinate(1)`                                                              |
| Linux    | `systemd-inhibit(1)`, falling back to `/sys/power/wake_lock`                 |
| Windows  | `SetThreadExecutionState` via a spawned PowerShell process (no native addon) |

Every backend uses the same "supervise a long-lived child" pattern, so there is
**no native addon and no `node-gyp`** on any platform.

## Install

```sh
npm install pervigil
```

## Quick start

```ts
import { keepAwake } from "pervigil";

const lock = await keepAwake({ system: true, description: "nightly backup" });
try {
  await runLongJob();
} finally {
  await lock.release();
}
```

Scoped variant — auto-releases even if the callback throws:

```ts
import { keepAwake } from "pervigil";

await keepAwake.while({ system: true, description: "backup" }, runLongJob);
```

Or with explicit resource management (Node 20.4+ / TS 5.2+):

```ts
await using lock = await keepAwake({ display: true, description: "rendering preview" });
```

By default only **system** sleep is blocked. Pass `display: true` to also keep
the screen on. And if you ever forget the `finally` / `release()`, the lock is
still freed when the process exits — see
[Auto-release on process exit](#auto-release-on-process-exit).

### Timed windows

Hold the lock for a fixed duration, or until a wall-clock instant. The
auto-release runs on an `unref()`'d timer (so it never keeps the event loop
alive), and an early `release()` cancels it — it never double-releases:

```ts
const lock = await keepAwake.for({ system: true, description: "warm-up" }, 30_000);
const lock2 = await keepAwake.until({ display: true }, new Date(Date.now() + 60_000));
```

### Shared instance

When many independent callers each want "keep the host awake", `keepAwake.shared()`
coalesces them onto **one** OS primitive — N concurrent holds spawn one primitive,
not N. Each handle's `release()` removes only its own hold; call
`keepAwake.shutdownShared()` to tear the shared primitive down (e.g. on exit):

```ts
const a = await keepAwake.shared({ description: "task a" });
const b = await keepAwake.shared({ description: "task b" }); // reuses a's primitive
await a.release();
await b.release();
await keepAwake.shutdownShared();
```

`shared()` takes only the per-call axes (`system` / `display` / `description`) —
**not** controller config — so the shared instance is always default-configured
(no first-caller-wins surprise). If you need a custom `identity` / `logger` /
`strict` / injected `driver`, create your own `wakeLock()` and share the reference.

### Auto-release on process exit

You don't need to do anything for this. **By default, every lock releases its OS
primitive when the process exits** — so a forgotten `release()` / `shutdown()`
can't leave an orphaned `caffeinate` / `systemd-inhibit` / PowerShell child
keeping the machine awake. It's wired with a single shared `process` `"exit"`
handler (never a `SIGINT`/`SIGTERM` listener, so it can't interfere with Ctrl-C
or your own signal handling), covering normal exit, `process.exit()`, and Ctrl-C.

Opt out per lock with `autoRelease: false` if you want to own teardown entirely:

```ts
const wl = wakeLock({ autoRelease: false });
```

The default covers normal exit, `process.exit()`, and Ctrl-C. The one case it
can't is a `SIGTERM` delivered straight to the Node process — that bypasses the
`exit` event, and a library can't safely install a `SIGTERM` handler by default
without fighting your app's own shutdown logic. In practice it rarely bites:
under systemd / containers the whole process group is signalled, so the child
dies with it. For a bare `kill <pid>` daemon that needs it, opt in with
`releaseOnExit` — it releases on `SIGINT` / `SIGTERM` and then re-raises the
signal so the process still terminates normally:

```ts
import { wakeLock, releaseOnExit } from "pervigil";

const wl = wakeLock();
const stop = releaseOnExit(wl); // also shut down on SIGINT / SIGTERM
// ... later, if you take over signal handling yourself:
stop();
```

## Behaviour: fail-safe by default

pervigil is **fail-safe**: by default it **never throws**. When it can't keep the
host awake it degrades to a silent no-op and your job still runs. It no-ops when:

- running inside a container (`/.dockerenv`, the `container` env var, or
  `/run/.containerenv`);
- on a platform with no inhibitor backend (e.g. FreeBSD), or when the platform
  binary (`caffeinate` / `systemd-inhibit` / PowerShell) is missing;
- forced off via `PERVIGIL_FORCE_NOOP=1` or `forceNoop: true`.

The catch: because pervigil can silently no-op, **asking to keep the host awake
is not the same as the host actually staying awake.** Three status fields keep
those apart, each answering a distinct question:

| Field       | Question                                                       |
| ----------- | -------------------------------------------------------------- |
| `available` | Is the driver _capable_ of a real primitive? (`false` ⇒ no-op) |
| `engaged`   | Is a reason _desired_ on this axis? (intent)                   |
| `active`    | Is a real OS assertion in effect **right now**? (reality)      |

`active` is the truth — it's `false` when degraded, when nothing is held, **or**
when the OS primitive died and hasn't re-engaged yet, cases that `available` and
`engaged` can't distinguish.

**Stay fail-safe, but check `.active`:**

```ts
const lock = await keepAwake({ description: "backup" });
if (!lock.status().active) {
  log.warn("running without a wake lock — host may sleep");
}
```

**Or opt into fail-fast with `strict`** — when the job must not run unless the
host is genuinely kept awake, pervigil throws `WakeLockUnavailableError` instead
of no-op'ing:

```ts
import { keepAwake, WakeLockUnavailableError } from "pervigil";

try {
  await keepAwake({ description: "backup", strict: true });
} catch (err) {
  if (err instanceof WakeLockUnavailableError) {
    console.error(`can't keep awake: ${err.degradedReason} on ${err.platform}`);
    process.exit(1);
  }
}
```

`strict` is opt-in; the default stays a graceful, never-throwing no-op. For
long-running locks, watch the `degraded` / `primitiveDied` events (or `onEvent`)
to learn when `active` flips to `false`.

## Supervised, multi-reason controller

For daemons that hold several overlapping reasons, use `wakeLock`. It
reconciles reasons (by key) onto the two axes and drives one OS primitive:

```ts
import { wakeLock } from "pervigil";

const wl = wakeLock({ identity: "my-app" }); // identity shows in `systemd-inhibit --list`

wl.acquire("job:123", { system: true, description: "import job 123" });
wl.acquire("view:abc", { display: true, description: "live view abc" });

wl.release("job:123"); // system axis releases; display stays held
await wl.shutdown(); // release everything, tear down the primitive
```

If you already recompute the desired set each tick, `apply` replaces the
**entire** held set in one reconcile (the declarative, batch sibling of
`acquire`/`release` — same per-axis defaults, idempotent, one OS flush):

```ts
wl.apply([
  { key: "job:123", system: true, description: "import job 123" },
  { key: "view:abc", display: true, description: "live view abc" },
]);
// any previously-held key absent from this set is released, in a single flush
```

## Self-managing locks (supervisor)

`pervigil/supervisor` is a **declarative** layer over `wakeLock`: declare a
condition and forget it. Each lock states its impact (axes), an optional
`active` predicate ("should it hold right now?"), and optional eviction triggers
(`until` / `maxAge` / `stale`). The supervisor polls these, reconciles the
underlying wake lock, and reaps dead locks — so you never manually
`acquire`/`release` or track lifetimes:

```ts
import { supervise } from "pervigil/supervisor";

const sup = supervise({ identity: "my-app", poll: "auto" });

// conditional / standing — held while any download is running
sup.add({ key: "downloads", description: "Active downloads", active: () => downloads.size > 0 });

// scoped / one-time — held for one operation, auto-evicted when it settles
sup.add({ description: "Importing dataset", until: importDataset() });

// also keep the display awake while a preview is on screen
sup.add({
  key: "preview",
  axes: ["system", "display"],
  description: "Live preview",
  active: () => preview.visible,
});

// pinned override — held until you remove it
const override = sup.add({ axes: ["system", "display"], description: "Presentation mode" });

// granular control + introspection
sup.list().forEach((l) => console.log(l.key, l.state)); // holding | idle | unknown | paused | evicted
sup.get("downloads")?.pause();
sup.restrict("display"); // veto an axis — never engage the display, whatever the locks say
override.remove();
await sup.shutdown();
```

Lock shapes:

- **Conditional / standing** — `{ active }` auto-engages/disengages; lives until removed.
- **Scoped / one-time** — `{ until }` (a promise or a predicate) held until it settles, then evicted.
- **Pinned** — neither; held while registered.

The state machine is surfaced on every handle (`holding`, `idle`, `unknown`,
`paused`, `evicted`). If an `active` predicate **throws**, the lock is engaged
**defensively** (`unknown`, _fail-awake_) so the host can recover, and the
`stale` clock starts — keep erroring for `stale` ms (5 min by default) and the
lock is evicted; any successful evaluation resets it. `maxAge` is an opt-in hard
ceiling from registration. `poll` is `number` (ms), `"auto"` (60s, and **no
timer at all** when no lock needs polling — all pinned / promise-`until`), or
`() => number`; the timer is always `unref()`'d, so it never keeps the process
alive. `refresh()` forces an immediate re-reconcile.

## Observability

```ts
const wl = wakeLock();
wl.on("engaged", (s) => console.log("awake:", s.reasons));
wl.on("degraded", (s) => console.warn("no-op:", s.degradedReason));

wl.status();
// {
//   platform: "macos-caffeinate",
//   available: true,                       // the driver is capable
//   active: true,                          // a real assertion is in effect RIGHT NOW
//   degradedReason: null,
//   engaged: { system: true, display: false },  // intent (a reason is desired)
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
const wl = wakeLock({
  onEvent: (event, status) => metrics.record(event, status), // OTel/StatsD/logs
});
```

A throwing `onEvent` is swallowed, so a flaky telemetry backend can never break
the lock.

At the OS level you can also see the assertion directly — `pmset -g assertions`
on macOS, or `systemd-inhibit --list` (look for your `identity`) on Linux.

The `identity` you pass to `wakeLock` surfaces the assertion's owner on
Linux (`systemd-inhibit --who=`, or the sysfs wake-lock cookie) and tags it on
Windows, but has no effect on macOS — `caffeinate(1)` exposes no equivalent, so
the value is silently ignored there.

## Metrics

`pervigil/metrics` turns the cumulative counters into Prometheus text or a
neutral sample list — **no `prom-client` dependency**, so you can adapt the
samples to OpenTelemetry, StatsD, JSON, or anything else:

```ts
import { wakeLock } from "pervigil";
import { toPrometheus, collectMetrics } from "pervigil/metrics";

const wl = wakeLock();

// Expose a /metrics endpoint (any HTTP framework):
res.setHeader("content-type", "text/plain; version=0.0.4");
res.end(toPrometheus(wl));

// …or adapt the neutral samples to another backend:
for (const s of collectMetrics(wl)) {
  myBackend.record(s.name, s.value, { type: s.type, ...s.labels });
}
```

Emits `pervigil_available`, `pervigil_active`, `pervigil_awake{axis}`,
`pervigil_awake_ms_total{axis}`, `pervigil_engage_transitions_total{axis}`, and
`pervigil_primitive_restarts_total`. (`pervigil_active` is the "is the host
actually awake right now" gauge — the one to alert on.)

### OpenTelemetry

`collectMetrics()` adapts to OpenTelemetry without pervigil depending on the OTel
SDK — you bring `@opentelemetry/api` and read the samples from an observable
callback:

```ts
import { metrics } from "@opentelemetry/api";
import { wakeLock } from "pervigil";
import { collectMetrics } from "pervigil/metrics";

const wl = wakeLock();
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
import { wakeLock } from "pervigil";
import { MockDriver } from "pervigil/testing";

const driver = new MockDriver();
const wl = wakeLock({ driver });

await wl.acquire("job", { system: true });
expect(driver.engageTransitions).toBe(1);
```

## Logging

pervigil is **silent by default** — it never writes to your console unless you
opt in. Turn it on with a level, either per-call or via the environment:

```ts
const wl = wakeLock({ logLevel: "warn" }); // built-in console sink
```

```sh
PERVIGIL_LOG_LEVEL=debug node app.js
```

Levels are `silent` | `warn` | `info` | `debug`. Resolution is `logLevel` option
→ `PERVIGIL_LOG_LEVEL` → default (`silent`). At `warn` you see degraded-mode
warnings (container, missing binary, unsupported platform); `info` adds the
selected-backend line; `debug` adds per-assertion detail.

Prefer your own logger? Pass a `logger` and pervigil routes through it instead
of the console. Two shapes are accepted:

**A method sink** — any object with a `warn` method (and optional `info` /
`debug`), called `(fields, msg)`. pino, bunyan, roarr, and `console` drop in
directly:

```ts
import pino from "pino";
const wl = wakeLock({ logger: pino() }); // forwards everything; pino filters
```

**A function sink** — one `(record) => void` callback per line, so loggers with
a different argument order (winston, consola, …) map cleanly. `record.fields` is
always an object (`{}` when there's no structured data):

```ts
const wl = wakeLock({
  logger: (r) => winston.log(r.level, r.msg ?? "", r.fields),
});
```

A `LogRecord` is `{ level: "warn" | "info" | "debug"; msg?: string; fields: object }`.

`logLevel: "silent"` hard-mutes either kind of supplied logger.

## Security

pervigil has **zero runtime dependencies** and ships **no native addons** — it
only spawns the OS's own inhibitor (`caffeinate` / `systemd-inhibit` /
PowerShell), so the supply-chain surface is minimal. Releases from `v0.5.0`
onward are published from CI via npm Trusted Publishing (OIDC) with build
provenance, so you can verify a downloaded copy:

```sh
npm audit signatures
```

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Oleksandr Zhuravlov
