# pervigil

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
| Windows | _not yet — no-op with a warning (see [ROADMAP](ROADMAP.md))_ |

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

At the OS level you can also see the assertion directly — `pmset -g assertions`
on macOS, or `systemd-inhibit --list` (look for your `identity`) on Linux.

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
- on an unimplemented platform (Windows today);
- when the platform binary (`caffeinate` / `systemd-inhibit`) is absent.

Set `PERVIGIL_FORCE_NOOP=1` (or `forceNoop: true`) to force it. In every case the
job still runs — it just isn't kept awake — and you get exactly one warning.

## License

[MIT](LICENSE) © Oleksandr Zhuravlov
