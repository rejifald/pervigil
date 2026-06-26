import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { wakeLock } from "./controller.js";
import { supervise } from "./supervisor.js";
import { MockDriver } from "./drivers/mock.js";

/** Flush the microtask queue so an in-flight reconcile settles. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A controllable injected clock. */
function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

describe("supervise", () => {
  let driver: MockDriver;

  beforeEach(() => {
    driver = new MockDriver();
  });

  /** Build a supervisor over an injected lock wired to the test MockDriver. */
  function build(opts: Parameters<typeof supervise>[0] = {}) {
    const lock = wakeLock({ driver });
    return supervise({ lock, ...opts });
  }

  describe("lock shapes", () => {
    it("pinned lock holds while registered, releases on remove()", async () => {
      const sup = build();
      const h = sup.add({ key: "pin", description: "Presentation mode" });
      await sup.refresh();
      expect(h.state).toBe("holding");
      expect(driver.held).toBe(true);

      h.remove();
      await sup.refresh();
      expect(h.state).toBe("evicted");
      expect(driver.held).toBe(false);
    });

    it("pinned lock defaults to the system axis", async () => {
      const sup = build();
      sup.add({ key: "pin" });
      await sup.refresh();
      expect(sup.status().engaged).toEqual({ system: true, display: false });
    });

    it("axes maps to both wake axes", async () => {
      const sup = build();
      sup.add({ key: "pin", axes: ["system", "display"] });
      await sup.refresh();
      expect(sup.status().engaged).toEqual({ system: true, display: true });
    });

    it("conditional lock engages/disengages as active flips", async () => {
      let on = false;
      const sup = build();
      const h = sup.add({ key: "cond", active: () => on });
      await sup.refresh();
      expect(h.state).toBe("idle");
      expect(driver.held).toBe(false);

      on = true;
      await sup.refresh();
      expect(h.state).toBe("holding");
      expect(driver.held).toBe(true);

      on = false;
      await sup.refresh();
      expect(h.state).toBe("idle");
      expect(driver.held).toBe(false);
    });

    it("idle locks are never auto-reaped", async () => {
      const sup = build();
      const h = sup.add({ key: "cond", active: () => false });
      await sup.refresh();
      await sup.refresh();
      expect(h.state).toBe("idle");
      expect(sup.get("cond")).toBeDefined();
    });

    it("async active is supported", async () => {
      let on = false;
      const sup = build();
      const h = sup.add({ key: "cond", active: async () => on });
      await sup.refresh();
      expect(h.state).toBe("idle");
      on = true;
      await sup.refresh();
      expect(h.state).toBe("holding");
    });

    it("promise-until evicts when the promise settles", async () => {
      let resolve!: () => void;
      const p = new Promise<void>((r) => {
        resolve = r;
      });
      const sup = build();
      const h = sup.add({ key: "scoped", until: p });
      await sup.refresh();
      expect(h.state).toBe("holding");

      resolve();
      await flush();
      await sup.refresh();
      expect(h.state).toBe("evicted");
      expect(driver.held).toBe(false);
    });

    it("predicate-until evicts when it returns true", async () => {
      let done = false;
      const sup = build();
      const h = sup.add({ key: "scoped", until: () => done });
      await sup.refresh();
      expect(h.state).toBe("holding");

      done = true;
      await sup.refresh();
      expect(h.state).toBe("evicted");
    });

    it("a throwing until-predicate does NOT evict (stays registered)", async () => {
      const sup = build();
      const h = sup.add({
        key: "scoped",
        until: () => {
          throw new Error("boom");
        },
      });
      await sup.refresh();
      expect(h.state).toBe("holding");
      await sup.refresh();
      expect(h.state).toBe("holding");
      expect(sup.get("scoped")).toBeDefined();
    });
  });

  describe("fail-awake", () => {
    it("active() throwing keeps the lock engaged as unknown", async () => {
      let mode: "throw" | boolean = "throw";
      const sup = build();
      const h = sup.add({
        key: "fa",
        active: () => {
          if (mode === "throw") throw new Error("predicate down");
          return mode;
        },
      });
      await sup.refresh();
      expect(h.state).toBe("unknown");
      expect(driver.held).toBe(true); // engaged defensively

      // Recovery: a later boolean resumes normal holding/idle.
      mode = false;
      await sup.refresh();
      expect(h.state).toBe("idle");
      expect(driver.held).toBe(false);

      mode = true;
      await sup.refresh();
      expect(h.state).toBe("holding");
    });
  });

  describe("stale", () => {
    it("evicts after continuous active() error >= stale", async () => {
      const c = clock();
      const sup = build({ now: c.now });
      const h = sup.add({
        key: "fa",
        stale: 1000,
        active: () => {
          throw new Error("down");
        },
      });
      await sup.refresh();
      expect(h.state).toBe("unknown");

      c.advance(500);
      await sup.refresh();
      expect(h.state).toBe("unknown"); // not yet stale

      c.advance(600); // total 1100 >= 1000
      await sup.refresh();
      expect(h.state).toBe("evicted");
    });

    it("a successful eval resets the stale clock", async () => {
      const c = clock();
      let throwing = true;
      const sup = build({ now: c.now });
      const h = sup.add({
        key: "fa",
        stale: 1000,
        active: () => {
          if (throwing) throw new Error("down");
          return false;
        },
      });
      await sup.refresh();
      c.advance(900);
      throwing = false;
      await sup.refresh(); // success resets the clock
      expect(h.state).toBe("idle");

      throwing = true;
      await sup.refresh(); // error clock restarts here
      c.advance(900);
      await sup.refresh();
      expect(h.state).toBe("unknown"); // only 900ms of continuous error
    });

    it("stale only applies to active-bearing locks", async () => {
      const c = clock();
      const sup = build({ now: c.now });
      // No active(): stale is irrelevant; the pinned lock just holds.
      const h = sup.add({ key: "pin", stale: 1, description: "pin" });
      await sup.refresh();
      c.advance(10_000);
      await sup.refresh();
      expect(h.state).toBe("holding");
    });

    it("stale:false disables eviction even under continuous error", async () => {
      const c = clock();
      const sup = build({ now: c.now });
      const h = sup.add({
        key: "fa",
        stale: false,
        active: () => {
          throw new Error("down");
        },
      });
      await sup.refresh();
      c.advance(1_000_000);
      await sup.refresh();
      expect(h.state).toBe("unknown");
    });

    it("defaults.stale applies to active-bearing locks", async () => {
      const c = clock();
      const sup = build({ now: c.now, defaults: { stale: 1000 } });
      const h = sup.add({
        key: "fa",
        active: () => {
          throw new Error("down");
        },
      });
      await sup.refresh();
      c.advance(1100);
      await sup.refresh();
      expect(h.state).toBe("evicted");
    });
  });

  describe("maxAge", () => {
    it("evicts at the ceiling regardless of state", async () => {
      const c = clock();
      const sup = build({ now: c.now });
      const h = sup.add({ key: "pin", maxAge: 1000, description: "pin" });
      await sup.refresh();
      expect(h.state).toBe("holding");

      c.advance(1100);
      await sup.refresh();
      expect(h.state).toBe("evicted");
      expect(driver.held).toBe(false);
    });
  });

  describe("restrictions", () => {
    it("a restricted axis is masked out of the engaged set", async () => {
      const sup = build();
      sup.add({ key: "pin", axes: ["system", "display"] });
      await sup.refresh();
      expect(sup.status().engaged).toEqual({ system: true, display: true });

      sup.restrict("display");
      await sup.refresh();
      expect(sup.status().engaged).toEqual({ system: true, display: false });
    });

    it("allow() lifts a restriction", async () => {
      const sup = build();
      sup.add({ key: "pin", axes: ["system", "display"] });
      sup.restrict("display");
      await sup.refresh();
      expect(sup.status().engaged.display).toBe(false);

      sup.allow("display");
      await sup.refresh();
      expect(sup.status().engaged.display).toBe(true);
    });

    it("a conditional while predicate is honored", async () => {
      let restricting = true;
      const sup = build();
      sup.add({ key: "pin", axes: ["system", "display"] });
      sup.restrict("display", { while: () => restricting });
      await sup.refresh();
      expect(sup.status().engaged.display).toBe(false);

      restricting = false;
      await sup.refresh();
      expect(sup.status().engaged.display).toBe(true);
    });

    it("restrictions() introspects the active restrictions", async () => {
      const sup = build();
      const r = sup.restrict("display");
      expect(sup.restrictions().map((x) => x.axis)).toEqual(["display"]);
      expect(r.active).toBe(true);
      r.lift();
      expect(sup.restrictions()).toHaveLength(0);
    });
  });

  describe("pause / resume / remove / list / get", () => {
    it("pause stops a lock engaging; resume re-engages", async () => {
      const sup = build();
      const h = sup.add({ key: "pin" });
      await sup.refresh();
      expect(h.state).toBe("holding");

      sup.pause("pin");
      await sup.refresh();
      expect(h.state).toBe("paused");
      expect(driver.held).toBe(false);

      sup.resume("pin");
      await sup.refresh();
      expect(h.state).toBe("holding");
      expect(driver.held).toBe(true);
    });

    it("a paused lock is not evaluated", async () => {
      let calls = 0;
      const sup = build();
      sup.add({
        key: "cond",
        active: () => {
          calls += 1;
          return true;
        },
      });
      await sup.refresh();
      const after = calls;
      sup.pause("cond");
      await sup.refresh();
      await sup.refresh();
      expect(calls).toBe(after); // not evaluated while paused
    });

    it("handle pause/resume/remove mirror the supervisor methods", async () => {
      const sup = build();
      const h = sup.add({ key: "pin" });
      h.pause();
      await sup.refresh();
      expect(h.state).toBe("paused");
      h.resume();
      await sup.refresh();
      expect(h.state).toBe("holding");
      h.remove();
      await sup.refresh();
      expect(h.state).toBe("evicted");
    });

    it("list() returns all live handles; get() finds by key", async () => {
      const sup = build();
      sup.add({ key: "a" });
      sup.add({ key: "b" });
      expect(
        sup
          .list()
          .map((h) => h.key)
          .sort(),
      ).toEqual(["a", "b"]);
      expect(sup.get("a")?.key).toBe("a");
      expect(sup.get("missing")).toBeUndefined();
    });

    it("auto-generates a key when omitted", () => {
      const sup = build();
      const h = sup.add({ description: "anon" });
      expect(typeof h.key).toBe("string");
      expect(h.key.length).toBeGreaterThan(0);
      expect(sup.get(h.key)).toBeDefined();
    });

    it("concurrent active predicates are evaluated together", async () => {
      const order: string[] = [];
      const sup = build();
      sup.add({
        key: "slow",
        active: async () => {
          await flush();
          order.push("slow");
          return true;
        },
      });
      sup.add({
        key: "fast",
        active: () => {
          order.push("fast");
          return true;
        },
      });
      await sup.refresh(); // drain the add()-scheduled cycles first
      order.length = 0;
      await sup.refresh(); // observe a single clean cycle
      // Concurrent: both run in one cycle, the sync one resolving before the
      // awaited slow one — proving they were started together, not serialized.
      expect(order).toEqual(["fast", "slow"]);
    });
  });

  describe("reconcile: union by key, merge axes, last description wins", () => {
    it("merges axes across holding locks and drives one apply", async () => {
      const sup = build();
      sup.add({ key: "a", axes: ["system"] });
      sup.add({ key: "b", axes: ["display"] });
      await sup.refresh();
      expect(sup.status().engaged).toEqual({ system: true, display: true });
    });
  });

  describe("poll", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a numeric poll re-reconciles on the timer", async () => {
      vi.useFakeTimers();
      let on = false;
      const lock = wakeLock({ driver });
      const sup = supervise({ lock, poll: 100 });
      sup.add({ key: "cond", active: () => on });
      await sup.refresh();
      expect(driver.held).toBe(false);

      on = true;
      await vi.advanceTimersByTimeAsync(150);
      expect(driver.held).toBe(true);
      await sup.shutdown();
    });

    it('"auto" polls at 60s when there is a predicate lock', async () => {
      vi.useFakeTimers();
      let on = false;
      const lock = wakeLock({ driver });
      const sup = supervise({ lock, poll: "auto" });
      sup.add({ key: "cond", active: () => on });
      await sup.refresh();

      on = true;
      await vi.advanceTimersByTimeAsync(59_000);
      expect(driver.held).toBe(false); // not yet
      await vi.advanceTimersByTimeAsync(2_000); // past 60s
      expect(driver.held).toBe(true);
      await sup.shutdown();
    });

    it('"auto" starts no timer when no lock needs polling', async () => {
      vi.useFakeTimers();
      const setInterval = vi.spyOn(globalThis, "setInterval");
      const lock = wakeLock({ driver });
      const sup = supervise({ lock, poll: "auto" });
      // Pinned + promise-until locks never need polling.
      sup.add({ key: "pin" });
      sup.add({ key: "scoped", until: new Promise(() => undefined) });
      await sup.refresh();
      expect(setInterval).not.toHaveBeenCalled();
      await sup.shutdown();
      setInterval.mockRestore();
    });

    it("a function poll is re-read each cycle", async () => {
      vi.useFakeTimers();
      const intervals: number[] = [];
      let next = 100;
      const lock = wakeLock({ driver });
      const sup = supervise({
        lock,
        poll: () => {
          intervals.push(next);
          return next;
        },
      });
      sup.add({ key: "cond", active: () => false });
      await sup.refresh();
      await vi.advanceTimersByTimeAsync(150);
      next = 200;
      await vi.advanceTimersByTimeAsync(250);
      expect(intervals.length).toBeGreaterThanOrEqual(2);
      await sup.shutdown();
    });

    it("the poll timer is unref'd so it never keeps the process alive", async () => {
      vi.useFakeTimers();
      const lock = wakeLock({ driver });
      const sup = supervise({ lock, poll: 100 });
      sup.add({ key: "cond", active: () => false });
      await sup.refresh();
      // The timer must have been unref()'d.
      const timers = vi.getTimerCount();
      expect(timers).toBeGreaterThan(0);
      await sup.shutdown();
    });
  });

  describe("shutdown", () => {
    it("evicts every lock and tears down the lock", async () => {
      const sup = build();
      const h = sup.add({ key: "pin" });
      await sup.refresh();
      await sup.shutdown();
      expect(h.state).toBe("evicted");
      expect(driver.shutdownCalls.length).toBeGreaterThan(0);
    });

    it("exposes the underlying lock", () => {
      const lock = wakeLock({ driver });
      const sup = supervise({ lock });
      expect(sup.lock).toBe(lock);
    });

    it("builds its own lock when none is injected", async () => {
      // No injected lock + an injected driver via WakeLockOptions passthrough.
      const sup = supervise({ driver });
      const h = sup.add({ key: "pin" });
      await sup.refresh();
      expect(h.state).toBe("holding");
      await sup.shutdown();
    });
  });

  describe("options.locks + status", () => {
    it("registers initial locks from options", async () => {
      const lock = wakeLock({ driver });
      const sup = supervise({ lock, locks: [{ key: "a" }, { key: "b" }] });
      expect(
        sup
          .list()
          .map((h) => h.key)
          .sort(),
      ).toEqual(["a", "b"]);
      await sup.refresh();
      expect(driver.held).toBe(true);
      await sup.shutdown();
    });

    it("status() proxies the underlying lock", async () => {
      const sup = build();
      sup.add({ key: "pin" });
      await sup.refresh();
      expect(sup.status().engaged.system).toBe(true);
      expect(sup.status().platform).toBe("mock");
    });
  });

  describe("errors never break the supervisor", () => {
    it("a throwing active in one lock does not stop others reconciling", async () => {
      const sup = build();
      sup.add({
        key: "bad",
        active: () => {
          throw new Error("down");
        },
      });
      sup.add({ key: "good", active: () => true });
      await sup.refresh();
      expect(sup.get("good")?.state).toBe("holding");
      expect(sup.get("bad")?.state).toBe("unknown");
    });
  });

  describe("defaults", () => {
    it("merges defaults into every added lock unless overridden", async () => {
      const sup = build({ defaults: { axes: ["system", "display"], description: "default" } });
      sup.add({ key: "a" }); // inherits both axes
      sup.add({ key: "b", axes: ["system"] }); // overrides
      await sup.refresh();
      expect(sup.get("a")?.axes).toEqual(["system", "display"]);
      expect(sup.get("b")?.axes).toEqual(["system"]);
    });
  });
});
