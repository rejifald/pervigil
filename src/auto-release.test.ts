import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { releaseOnExit } from "./auto-release.js";

describe("releaseOnExit", () => {
  it("calls shutdown once when a registered signal fires", () => {
    const emitter = new EventEmitter();
    const target = { shutdown: vi.fn() };

    releaseOnExit(target, { emitter, signals: ["SIGTERM"] });
    emitter.emit("SIGTERM");

    expect(target.shutdown).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across multiple signals", () => {
    const emitter = new EventEmitter();
    const target = { shutdown: vi.fn() };

    releaseOnExit(target, { emitter, signals: ["SIGINT", "SIGTERM"] });
    emitter.emit("SIGTERM");
    emitter.emit("SIGTERM");
    emitter.emit("SIGINT");

    expect(target.shutdown).toHaveBeenCalledTimes(1);
  });

  it("also fires on beforeExit", () => {
    const emitter = new EventEmitter();
    const target = { shutdown: vi.fn() };

    releaseOnExit(target, { emitter });
    emitter.emit("beforeExit", 0);

    expect(target.shutdown).toHaveBeenCalledTimes(1);
  });

  it("the returned unregister removes all listeners", () => {
    const emitter = new EventEmitter();
    const target = { shutdown: vi.fn() };

    const unregister = releaseOnExit(target, {
      emitter,
      signals: ["SIGINT", "SIGTERM"],
    });

    expect(emitter.listenerCount("SIGTERM")).toBe(1);
    expect(emitter.listenerCount("SIGINT")).toBe(1);
    expect(emitter.listenerCount("beforeExit")).toBe(1);

    unregister();

    expect(emitter.listenerCount("SIGTERM")).toBe(0);
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("beforeExit")).toBe(0);

    emitter.emit("SIGTERM");
    expect(target.shutdown).not.toHaveBeenCalled();
  });

  it("defaults to SIGINT and SIGTERM when no signals are given", () => {
    const emitter = new EventEmitter();
    const target = { shutdown: vi.fn() };

    releaseOnExit(target, { emitter });
    emitter.emit("SIGINT");

    expect(target.shutdown).toHaveBeenCalledTimes(1);
  });
});
