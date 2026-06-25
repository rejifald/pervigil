import type { WakeLockStatus } from "./controller.js";

/**
 * `pervigil/metrics` — a tiny, dependency-free adapter that turns the cumulative
 * counters on {@link WakeLockStatus} into a neutral, framework-agnostic list of
 * metric samples, plus a Prometheus text-exposition renderer.
 *
 * It adds **no runtime dependency** (no `prom-client`): the Prometheus format is
 * simple enough to emit by hand, and the neutral {@link MetricSample} list lets
 * you adapt to OpenTelemetry, StatsD, JSON, or anything else without coupling
 * pervigil to a metrics vendor.
 *
 * @example Expose a `/metrics` endpoint (any HTTP framework).
 * ```ts
 * import { wakeLock } from "pervigil";
 * import { toPrometheus } from "pervigil/metrics";
 *
 * const lock = wakeLock();
 * // ...later, in a request handler:
 * res.setHeader("content-type", "text/plain; version=0.0.4");
 * res.end(toPrometheus(lock));
 * ```
 *
 * @example Adapt the neutral samples to another backend.
 * ```ts
 * import { collectMetrics } from "pervigil/metrics";
 *
 * for (const s of collectMetrics(lock)) {
 *   myBackend.record(s.name, s.value, { type: s.type, ...s.labels });
 * }
 * ```
 *
 * @module
 */

/** A single neutral metric reading, independent of any metrics backend. */
export interface MetricSample {
  /** Metric name, e.g. `"pervigil_awake"`. */
  name: string;
  /** The numeric reading. */
  value: number;
  /** Optional label set, e.g. `{ axis: "system" }`. */
  labels?: Record<string, string>;
  /** Prometheus-style metric kind. */
  type: "gauge" | "counter";
}

/** Either a live lock-like object or an already-captured status snapshot. */
export type MetricSource = { status(): WakeLockStatus } | WakeLockStatus;

/** Static help text per metric name, used by {@link toPrometheus}. */
const HELP: Record<string, string> = {
  pervigil_available: "Whether the driver is capable of a real OS wake-lock primitive (1) or degraded to a no-op (0).",
  pervigil_active: "Whether the host is actually being kept awake right now — a real OS assertion is in effect (1) or not (0).",
  pervigil_awake: "Whether the given axis currently has a reason desired (1) or idle (0).",
  pervigil_awake_ms_total: "Total wall-clock milliseconds the given axis has been held.",
  pervigil_engage_transitions_total: "Count of idle→engaged edges (real activations) for the given axis.",
  pervigil_primitive_restarts_total:
    "Times the OS primitive died unexpectedly and was recycled.",
};

const AXES = ["system", "display"] as const;

function isStatus(source: MetricSource): source is WakeLockStatus {
  return typeof (source as { status?: unknown }).status !== "function";
}

/** Resolve a {@link MetricSource} to a concrete {@link WakeLockStatus}. */
function toStatus(source: MetricSource): WakeLockStatus {
  return isStatus(source) ? source : source.status();
}

/**
 * Collect the wake-lock counters as a neutral list of {@link MetricSample}s.
 *
 * Emits, in order: `pervigil_available` (gauge), `pervigil_active` (gauge),
 * `pervigil_awake{axis}` (gauge, per axis), `pervigil_awake_ms_total{axis}`
 * (counter, per axis), `pervigil_engage_transitions_total{axis}` (counter, per
 * axis), and `pervigil_primitive_restarts_total` (counter).
 *
 * @param source A lock-like object exposing `status()`, or a captured
 *   {@link WakeLockStatus} snapshot.
 */
export function collectMetrics(source: MetricSource): MetricSample[] {
  const s = toStatus(source);
  const samples: MetricSample[] = [
    { name: "pervigil_available", value: s.available ? 1 : 0, type: "gauge" },
    { name: "pervigil_active", value: s.active ? 1 : 0, type: "gauge" },
  ];

  for (const axis of AXES) {
    samples.push({
      name: "pervigil_awake",
      value: s.engaged[axis] ? 1 : 0,
      labels: { axis },
      type: "gauge",
    });
  }
  for (const axis of AXES) {
    samples.push({
      name: "pervigil_awake_ms_total",
      value: s.counters.awakeMsTotal[axis],
      labels: { axis },
      type: "counter",
    });
  }
  for (const axis of AXES) {
    samples.push({
      name: "pervigil_engage_transitions_total",
      value: s.counters.engageTransitions[axis],
      labels: { axis },
      type: "counter",
    });
  }

  samples.push({
    name: "pervigil_primitive_restarts_total",
    value: s.counters.primitiveRestarts,
    type: "counter",
  });

  return samples;
}

/** Render a label set as Prometheus `{k="v",...}`, or `""` when empty. */
function renderLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return "";
  const pairs = Object.entries(labels);
  if (pairs.length === 0) return "";
  const body = pairs
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  return `{${body}}`;
}

/** Escape a label value per the Prometheus exposition format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/**
 * Render the wake-lock counters as Prometheus text exposition format, including
 * `# HELP` and `# TYPE` lines for each metric. The output ends with a trailing
 * newline, per Prometheus convention.
 *
 * @param source A lock-like object exposing `status()`, or a captured
 *   {@link WakeLockStatus} snapshot.
 */
export function toPrometheus(source: MetricSource): string {
  const samples = collectMetrics(source);

  // Group by metric name, preserving first-seen order, so each metric gets a
  // single `# HELP`/`# TYPE` header followed by all of its samples.
  const order: string[] = [];
  const groups = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    let group = groups.get(sample.name);
    if (!group) {
      group = [];
      groups.set(sample.name, group);
      order.push(sample.name);
    }
    group.push(sample);
  }

  const lines: string[] = [];
  for (const name of order) {
    const group = groups.get(name)!;
    const help = HELP[name];
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${group[0]!.type}`);
    for (const sample of group) {
      lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
    }
  }

  return lines.join("\n") + "\n";
}
