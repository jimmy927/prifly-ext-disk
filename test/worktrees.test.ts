import { expect, test } from "bun:test";
import { mapLimited } from "../scan/worktrees";

test("mapLimited keeps the order and never runs more than the limit at once", async () => {
  let running = 0;
  let most = 0;
  const out = await mapLimited([5, 1, 4, 2, 3, 0], 2, async (n) => {
    running += 1;
    most = Math.max(most, running);
    await Bun.sleep(n);
    running -= 1;
    return n * 10;
  });
  expect(out).toEqual([50, 10, 40, 20, 30, 0]);
  expect(most).toBe(2);
});

test("mapLimited over nothing is nothing", async () => {
  expect(await mapLimited([], 8, async () => 1)).toEqual([]);
});
