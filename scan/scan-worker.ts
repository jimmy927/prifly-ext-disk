/**
 * The thread a scan runs on in the host (`off-thread.ts`): the whole of it,
 * from the archived marks in prifly's database to the cache it writes.
 *
 * Everything a scan does that holds its thread stays here: starting ~900 git
 * processes (about 2 ms each, `Bun.spawn` is synchronous), `statSync` on every
 * worktree's changed files and top-level entries, the database read and the
 * parse of fastdu's output. On the calling thread the worktrees alone held
 * its event loop for up to 215 ms at a time; run from here, each step of the
 * scan held it 3 ms at most (2026-09-27).
 */

import type { ExtensionSession } from "../prifly-api";
import { writeCache } from "./cache";
import { readConfig } from "./config";
import type { Part } from "./progress";
import { scan } from "./scan";
import { readArchived, withArchived } from "./sessions";
import type { Scan } from "./types";

declare const self: Worker;

/** The sessions as the host sees them, and the extension's folder: its config and cache. */
export type ScanJob = { sessions: ExtensionSession[]; folder: string };

export type ScanReply =
  | { kind: "parts"; parts: Part[] }
  | { kind: "done"; scan: Scan }
  | { kind: "failed"; error: string };

async function scanAndKeep(job: ScanJob): Promise<Scan> {
  const sessions = withArchived(job.sessions, readArchived());
  const result = await scan({ sessions, config: readConfig(job.folder) }, (parts) =>
    self.postMessage({ kind: "parts", parts } satisfies ScanReply),
  );
  writeCache(job.folder, { scan: result, sessions });
  return result;
}

self.onmessage = (event: MessageEvent<ScanJob>) => {
  scanAndKeep(event.data).then(
    (result) => self.postMessage({ kind: "done", scan: result } satisfies ScanReply),
    (error: unknown) =>
      self.postMessage({
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
      } satisfies ScanReply),
  );
};
