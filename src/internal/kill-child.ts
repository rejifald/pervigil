import type { ChildProcess } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 1000;

/**
 * SIGTERM the child, wait up to `timeoutMs`, then SIGKILL if it hasn't
 * exited. Safe to call on a child that has already exited.
 */
export async function killChild(
  child: ChildProcess,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  // Loose-equality covers test mocks that don't populate signalCode.
  if (child.exitCode != null || child.signalCode != null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    child.once("exit", finish);
    child.once("error", finish);

    const timer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      finish();
    }, timeoutMs);

    try {
      child.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}
