import { describe, expect, test } from "bun:test";
import { type Desktop, newWindow, RAISE_MS, startRaise } from "../scan/raise";

describe("raising Explorer's new window", () => {
  test("the new window is the one not open before", () => {
    expect(newWindow(new Set([1, 2]), [2, 1, 7])).toBe(7);
    expect(newWindow(new Set([1, 2]), [1, 2])).toBeNull();
    expect(newWindow(new Set(), [])).toBeNull();
  });

  /** A desktop whose Explorer windows are `before`, then `later` after `after` looks. */
  function desktop(before: number[], later: number[], after: number, raised: Desktop["raise"]) {
    let looks = 0;
    const asked: number[] = [];
    const d: Desktop = {
      explorers: () => (looks++ > after ? later : before),
      raise: (window) => {
        asked.push(window);
        return raised(window);
      },
    };
    return { d, asked };
  }

  test("raises the window that appears after Explorer starts, once, not an old one", async () => {
    const { d, asked } = desktop([10, 11], [10, 11, 12], 2, () => "alt key");
    expect(await startRaise(() => d).opened()).toBe("raised (alt key)");
    expect(asked).toEqual([12]);
  });

  test("says when Windows refused", async () => {
    const { d } = desktop([], [5], 0, () => null);
    expect(await startRaise(() => d).opened()).toBe(
      "not raised: Windows kept the foreground where it was",
    );
  });

  test("gives up after RAISE_MS with no new window, and raises nothing later", async () => {
    const { d, asked } = desktop([10], [10], 0, () => "alt key");
    const begun = Date.now();
    expect(await startRaise(() => d).opened()).toBe(
      `not raised: no new Explorer window within ${RAISE_MS / 1000} s`,
    );
    expect(Date.now() - begun).toBeGreaterThanOrEqual(RAISE_MS);
    expect(Date.now() - begun).toBeLessThan(RAISE_MS + 500);
    expect(asked).toEqual([]);
  });

  test("off Windows the real desktop throws, which reveal logs", () => {
    if (process.platform === "win32") return;
    expect(() => startRaise()).toThrow("Windows' user32 is only on Windows.");
  });
});
