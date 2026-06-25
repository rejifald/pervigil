import type { LogLevel, Logger, LoggerFn } from "../types.js";

/** Numeric rank per level — higher emits strictly more. */
const RANK: Record<LogLevel, number> = {
  silent: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** Read + validate `PERVIGIL_LOG_LEVEL`; unknown values are ignored. */
function envLevel(): LogLevel | undefined {
  const raw = process.env["PERVIGIL_LOG_LEVEL"]?.toLowerCase();
  if (raw && raw in RANK) return raw as LogLevel;
  return undefined;
}

/**
 * Console-backed sink used when the caller wires no `logger`. Pino-shaped
 * `(obj, msg)` calls are rendered as a single `[pervigil] message` line plus
 * the structured object (omitted when empty, to keep output clean).
 */
const consoleSink: Logger = {
  warn: (obj, msg) => emit(console.warn, obj, msg),
  info: (obj, msg) => emit((console.info ?? console.log).bind(console), obj, msg),
  debug: (obj, msg) => emit((console.debug ?? console.log).bind(console), obj, msg),
};

function emit(fn: (...args: unknown[]) => void, obj: unknown, msg?: string): void {
  const head = `[pervigil] ${msg ?? ""}`.trimEnd();
  if (obj && typeof obj === "object" && Object.keys(obj).length > 0) {
    fn(head, obj);
  } else {
    fn(head);
  }
}

/** Coerce a sink argument to {@link LogRecord.fields} — always an object. */
function toFields(obj: unknown): Record<string, unknown> {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
}

/**
 * Adapt a {@link LoggerFn} to the internal method-shaped {@link Logger}, so the
 * rest of the pipeline (level gating, call sites) is identical for both sink
 * styles. Each method maps its `(fields, msg)` call into one {@link LogRecord}.
 */
function fromFunction(fn: LoggerFn): Logger {
  return {
    warn: (obj, msg) => fn({ level: "warn", msg, fields: toFields(obj) }),
    info: (obj, msg) => fn({ level: "info", msg, fields: toFields(obj) }),
    debug: (obj, msg) => fn({ level: "debug", msg, fields: toFields(obj) }),
  };
}

export interface ResolveLoggerOptions {
  /**
   * Sink for log lines — a method-shaped {@link Logger} or a {@link LoggerFn}.
   * Defaults to a built-in console sink.
   */
  logger?: Logger | LoggerFn;
  /** Emission threshold. See {@link LogLevel}. */
  logLevel?: LogLevel;
}

/**
 * Build the effective logger from the caller's `logger` + `logLevel` options
 * and the `PERVIGIL_LOG_LEVEL` env var.
 *
 * Level resolution: `logLevel` option → `PERVIGIL_LOG_LEVEL` → default. The
 * default is `silent` when no `logger` is supplied (pervigil stays quiet unless
 * you opt in) and `debug` when one is — forward everything and let your logger
 * do its own filtering, preserving prior behaviour.
 *
 * Returns `undefined` at `silent`, so call sites can keep using `logger?.warn`
 * and pay nothing when logging is off.
 */
export function resolveLogger(opts: ResolveLoggerOptions = {}): Logger | undefined {
  const level = opts.logLevel ?? envLevel() ?? (opts.logger ? "debug" : "silent");
  if (level === "silent") return undefined;

  const sink: Logger =
    typeof opts.logger === "function" ? fromFunction(opts.logger) : (opts.logger ?? consoleSink);
  const threshold = RANK[level];

  return {
    warn: (obj, msg) => {
      if (threshold >= RANK.warn) sink.warn(obj, msg);
    },
    info: (obj, msg) => {
      if (threshold >= RANK.info) sink.info?.(obj, msg);
    },
    debug: (obj, msg) => {
      if (threshold >= RANK.debug) sink.debug?.(obj, msg);
    },
  };
}
