/**
 * A stand-in for `scan/scan-worker.ts`: what it does is named by the job's
 * folder — "ok", "fail", "throw", "busy" (holds its thread 300 ms) or "hang".
 */

import type { ScanJob, ScanReply } from "../../scan/scan-worker";
import type { Scan } from "../../scan/types";

declare const self: Worker;

const SCAN: Scan = { at: 1, took: 2, drives: [], usage: [], candidates: [], notes: [] };

function reply(message: ScanReply): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<ScanJob>) => {
  const { folder, sessions } = event.data;
  const part = { name: "Drives", state: "done", detail: "", startedAt: 1, ms: 1 } as const;
  reply({ kind: "parts", parts: [part] });
  if (folder === "fail") return reply({ kind: "failed", error: "docker: not running" });
  if (folder === "throw") throw new Error("broken");
  if (folder === "hang") return;
  if (folder === "busy") {
    const until = performance.now() + 300;
    while (performance.now() < until) {
      // Held, as a synchronous call would hold it.
    }
  }
  reply({ kind: "done", scan: { ...SCAN, notes: sessions.map((session) => session.id) } });
};
