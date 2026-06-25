// Process-exit cleanup registry.
//
// A single, shared `process.on("exit")` handler tears down every live wake lock
// synchronously when the process exits — so a forgotten `release()` / `shutdown()`
// can't leak the spawned OS primitive (caffeinate / systemd-inhibit / PowerShell)
// as an orphaned child.
//
// We deliberately use ONLY the `exit` event, never signal listeners: adding a
// `SIGINT` listener would suppress Node's default "exit on Ctrl-C", hanging the
// process. `exit` fires on normal completion, `process.exit()`, and after
// Node's default SIGINT handling — and `exit` handlers must be synchronous,
// which is fine because a driver's `shutdown()` sends its child `SIGTERM`
// synchronously. (SIGTERM/SIGKILL that bypass `exit` are an inherent gap; use
// the explicit `releaseOnExit()` helper or your own handler for those.)

type Cleanup = () => void;

const live = new Set<Cleanup>();
let installed = false;

/**
 * Run every registered cleanup once, best-effort. Wired to `process` `"exit"`;
 * also exported so tests can drive it without exiting the process.
 */
export function runExitCleanup(): void {
  for (const fn of [...live]) {
    try {
      fn();
    } catch {
      // Best-effort teardown — a throwing cleanup must not block the others.
    }
  }
}

/**
 * Register a synchronous cleanup to run on process exit. Installs the single
 * shared `exit` handler on first use. Returns an unregister function.
 */
export function registerExitCleanup(fn: Cleanup): () => void {
  if (!installed) {
    installed = true;
    process.once("exit", runExitCleanup);
  }
  live.add(fn);
  return () => {
    live.delete(fn);
  };
}
