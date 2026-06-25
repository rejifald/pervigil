import { describe, it, expect, vi } from "vitest";
import { registerExitCleanup, runExitCleanup } from "./exit-cleanup.js";

describe("exit-cleanup registry", () => {
  it("runs every registered cleanup", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerExitCleanup(a);
    const offB = registerExitCleanup(b);
    try {
      runExitCleanup();
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    } finally {
      offA();
      offB();
    }
  });

  it("unregister removes a cleanup", () => {
    const a = vi.fn();
    registerExitCleanup(a)(); // register then immediately unregister
    runExitCleanup();
    expect(a).not.toHaveBeenCalled();
  });

  it("a throwing cleanup does not block the others", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const offBad = registerExitCleanup(bad);
    const offGood = registerExitCleanup(good);
    try {
      expect(() => runExitCleanup()).not.toThrow();
      expect(good).toHaveBeenCalledTimes(1);
    } finally {
      offBad();
      offGood();
    }
  });
});
