/**
 * A scan on a thread of its own (`scan-worker.ts`), so prifly's host — whose
 * one event loop also serves the window — keeps answering while it runs.
 *
 * The extension is imported into the host's main thread. All 11 of its
 * `perf.loop_stall`s between 15:43 and 15:45 on 2026-09-27 fell inside one
 * 117 s scan; run on its own, the scan held a thread up to 215 ms, where every
 * worktree's git processes are started (`Bun.spawn` takes ~2 ms of the thread
 * each) and its files stat'ed. The thread is started per scan and ended after it: a
 * scan runs only when asked, and between them it would only hold memory.
 */

import type { Part } from "./progress";
import type { ScanJob, ScanReply } from "./scan-worker";
import type { Scan } from "./types";

export type Running = {
  done: Promise<Scan>;
  /** End the thread now; `done` rejects. */
  stop: () => void;
};

export class ScanStopped extends Error {}

const WORKER = new URL("./scan-worker.ts", import.meta.url).href;

export function scanOffThread(
  job: ScanJob,
  onParts: (parts: Part[]) => void,
  /** The thread's module; tests hand in their own. */
  module: string = WORKER,
): Running {
  const worker = new Worker(module);
  const { promise, resolve, reject } = Promise.withResolvers<Scan>();
  const end = (settle: () => void) => {
    worker.terminate();
    settle();
  };
  worker.onmessage = (event: MessageEvent<ScanReply>) => {
    const reply = event.data;
    if (reply.kind === "parts") onParts(reply.parts);
    else if (reply.kind === "done") end(() => resolve(reply.scan));
    else end(() => reject(new Error(reply.error)));
  };
  worker.onerror = (event) => end(() => reject(new Error(event.message)));
  worker.postMessage(job);
  return {
    done: promise,
    stop: () => end(() => reject(new ScanStopped("The scan was stopped."))),
  };
}
