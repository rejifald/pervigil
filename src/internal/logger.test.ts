import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveLogger } from "./logger.js";
import type { Logger } from "../types.js";

function spySink(): Logger & {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe("resolveLogger", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is silent by default — no logger, no level, no env → undefined", () => {
    expect(resolveLogger({})).toBeUndefined();
  });

  it("a provided logger with no level forwards every method (back-compat)", () => {
    const sink = spySink();
    const logger = resolveLogger({ logger: sink })!;
    logger.warn({ a: 1 }, "w");
    logger.info?.({ b: 2 }, "i");
    logger.debug?.({ c: 3 }, "d");
    expect(sink.warn).toHaveBeenCalledWith({ a: 1 }, "w");
    expect(sink.info).toHaveBeenCalledWith({ b: 2 }, "i");
    expect(sink.debug).toHaveBeenCalledWith({ c: 3 }, "d");
  });

  it("logLevel:'warn' forwards warn but gates info and debug", () => {
    const sink = spySink();
    const logger = resolveLogger({ logger: sink, logLevel: "warn" })!;
    logger.warn({}, "w");
    logger.info?.({}, "i");
    logger.debug?.({}, "d");
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.debug).not.toHaveBeenCalled();
  });

  it("logLevel:'info' forwards warn+info but gates debug", () => {
    const sink = spySink();
    const logger = resolveLogger({ logger: sink, logLevel: "info" })!;
    logger.warn({}, "w");
    logger.info?.({}, "i");
    logger.debug?.({}, "d");
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.info).toHaveBeenCalledTimes(1);
    expect(sink.debug).not.toHaveBeenCalled();
  });

  it("logLevel:'silent' hard-mutes even a provided logger", () => {
    const sink = spySink();
    expect(resolveLogger({ logger: sink, logLevel: "silent" })).toBeUndefined();
  });

  it("logLevel without a logger logs to the console sink at the chosen level", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = resolveLogger({ logLevel: "warn" })!;
    logger.warn({ degraded: true }, "container no-op");
    logger.debug?.({}, "noisy");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });

  it("PERVIGIL_LOG_LEVEL drives the level when no option is given", () => {
    vi.stubEnv("PERVIGIL_LOG_LEVEL", "debug");
    const sink = spySink();
    const logger = resolveLogger({ logger: sink })!;
    logger.debug?.({}, "d");
    expect(sink.debug).toHaveBeenCalledTimes(1);
  });

  it("an explicit logLevel option overrides PERVIGIL_LOG_LEVEL", () => {
    vi.stubEnv("PERVIGIL_LOG_LEVEL", "debug");
    const sink = spySink();
    const logger = resolveLogger({ logger: sink, logLevel: "warn" })!;
    logger.info?.({}, "i");
    expect(sink.info).not.toHaveBeenCalled();
  });

  it("an unrecognised PERVIGIL_LOG_LEVEL is ignored (falls back to default)", () => {
    vi.stubEnv("PERVIGIL_LOG_LEVEL", "loud");
    // No logger + unrecognised env ⇒ default silent.
    expect(resolveLogger({})).toBeUndefined();
  });

  it("does not throw when the sink omits optional info/debug methods", () => {
    const warn = vi.fn();
    const logger = resolveLogger({ logger: { warn }, logLevel: "debug" })!;
    expect(() => {
      logger.info?.({}, "i");
      logger.debug?.({}, "d");
    }).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a function sink receives one normalised LogRecord per line", () => {
    const fn = vi.fn();
    const logger = resolveLogger({ logger: fn })!;
    logger.warn({ a: 1 }, "w");
    logger.info?.({ b: 2 }, "i");
    logger.debug?.({ c: 3 }, "d");
    expect(fn).toHaveBeenNthCalledWith(1, { level: "warn", msg: "w", fields: { a: 1 } });
    expect(fn).toHaveBeenNthCalledWith(2, { level: "info", msg: "i", fields: { b: 2 } });
    expect(fn).toHaveBeenNthCalledWith(3, { level: "debug", msg: "d", fields: { c: 3 } });
  });

  it("a function sink always gets a fields object — `{}` when none and msg-only", () => {
    const fn = vi.fn();
    const logger = resolveLogger({ logger: fn })!;
    logger.warn(undefined, "just a message");
    expect(fn).toHaveBeenCalledWith({ level: "warn", msg: "just a message", fields: {} });
  });

  it("level filtering applies to a function sink just like a method sink", () => {
    const fn = vi.fn();
    const logger = resolveLogger({ logger: fn, logLevel: "warn" })!;
    logger.warn({}, "w");
    logger.info?.({}, "i");
    logger.debug?.({}, "d");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ level: "warn", msg: "w", fields: {} });
  });

  it("logLevel:'silent' hard-mutes a function sink (never invoked)", () => {
    const fn = vi.fn();
    expect(resolveLogger({ logger: fn, logLevel: "silent" })).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
});
