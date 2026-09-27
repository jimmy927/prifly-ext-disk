import { expect, test } from "bun:test";
import { ScanStopped, scanOffThread } from "../scan/off-thread";
import type { Part } from "../scan/progress";

const FAKE = new URL("./fixtures/scan-worker.ts", import.meta.url).href;
const SESSIONS = [{ id: "s1", title: "t", cwd: "/x", state: "ended" }];

function start(folder: string, parts: Part[][] = []) {
  return scanOffThread({ sessions: SESSIONS, folder }, (each) => parts.push(each), FAKE);
}

test("the scan's progress and result come back from its thread", async () => {
  const parts: Part[][] = [];
  const scan = await start("ok", parts).done;
  expect(scan.notes).toEqual(["s1"]);
  expect(parts.map((each) => each.map((part) => part.name))).toEqual([["Drives"]]);
});

test("a part the scan could not finish fails the scan with its reason", async () => {
  await expect(start("fail").done).rejects.toThrow("docker: not running");
});

test("a thread that throws fails the scan", async () => {
  await expect(start("throw").done).rejects.toThrow("broken");
});

test("stopping ends a scan that is still running", async () => {
  const running = start("hang");
  await Bun.sleep(50);
  running.stop();
  await expect(running.done).rejects.toBeInstanceOf(ScanStopped);
});

test("a thread held by the scan leaves this one free", async () => {
  let worst = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  await start("busy").done;
  clearInterval(probe);
  // The thread was held 300 ms; this one's timer never waited more than a few.
  expect(worst).toBeLessThan(100);
});
