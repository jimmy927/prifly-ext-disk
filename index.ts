/**
 * Disk space: how full each drive is, what takes the space, and what could
 * be cleaned — in a window of its own (`panel/`) — handed to the
 * `disk-cleanup` skill, which asks the reader what to clean and does it.
 *
 * A scan runs only when asked: the window's Rescan, whose progress it shows
 * part by part while it runs, and after a cleanup started from the window
 * ends. Nothing else reads a scan, so one on a timer was work for nobody —
 * and heavy work: the walk of ~ and /tmp lstats millions of files, and while
 * it ran the host's slow git reads came 6.4 times as often (2026-09-27). The
 * last scan is shown until the next one. Its result is kept in
 * `cache/scan.json`, with the sessions it judged by, so `bin/disk-scan` — what
 * the skill runs — answers at once and judges sessions the same way; a scan
 * it writes is taken up here too.
 *
 * The window's Clean up buttons start a session each, in a window of its own
 * (prifly's `prifly-launch`), through `launch` with the candidate's id or a
 * group as the key; when such a session ends the drives are scanned again.
 */

import { homedir } from "node:os";
import type { ExtensionApi, Launch, PanelRequest } from "./prifly-api";
import { readCache } from "./scan/cache";
import { type Running, ScanStopped, scanOffThread } from "./scan/off-thread";
import type { Part } from "./scan/progress";
import { cleanupPrompt } from "./scan/prompt";
import { isLive, withArchived } from "./scan/sessions";
import type { Scan } from "./scan/types";

/** How often the cleanup sessions this started are looked at, to rescan when one ends. */
const CLEANUPS_EVERY = 60_000;

type State = {
  api: ExtensionApi;
  last: Scan | null;
  running: Running | null;
  /** The running scan's parts, as far as each has got; the last scan's once it is over. */
  parts: Part[];
  error: string;
  /** The cleanup sessions started from here that were still running when last looked at. */
  cleanups: Set<string>;
};

let state: State | null = null;

/**
 * A scan, on a thread of its own (`scan/off-thread.ts`): it reads the
 * archived marks, scans and writes the cache there, and only its result and
 * its parts' progress come back here.
 */
function rescan(current: State): Promise<Scan> {
  if (current.running !== null) return current.running.done;
  const running = scanOffThread(
    { sessions: current.api.sessions(), folder: current.api.folder },
    (parts) => {
      current.parts = parts;
    },
  );
  current.running = running;
  return running.done
    .then((result) => {
      current.last = result;
      current.error = "";
      // `ms`, the field prifly's `perf:report` totals time by.
      current.api.log("scanned", { ms: result.took, candidates: result.candidates.length });
      return result;
    })
    .catch((error: unknown) => {
      // Stopped with the extension: nothing failed, and nobody is left to tell.
      if (error instanceof ScanStopped) throw error;
      current.error = error instanceof Error ? error.message : String(error);
      current.api.log("scan_failed", { error: current.error });
      throw error;
    })
    .finally(() => {
      current.running = null;
    });
}

/** A cleanup session that has ended is what the drives look like now: scan again. */
function watchCleanups(current: State): void {
  if (current.cleanups.size === 0) return;
  // Judged by prifly's own states alone: it knows its sessions whatever the system.
  const nobody = { ids: new Set<string>(), folders: [], known: true };
  // Archived or not makes no difference to running, so prifly's database is not read.
  const live = new Set(
    withArchived(current.api.sessions(), new Set())
      .filter((session) => isLive(session, nobody))
      .map((session) => session.id),
  );
  const ended = [...current.cleanups].filter((id) => !live.has(id));
  if (ended.length === 0) return;
  for (const id of ended) current.cleanups.delete(id);
  current.api.log("cleanup_ended", { sessions: ended.length });
  void rescan(current).catch(() => undefined);
}

export function activate(api: ExtensionApi): () => void {
  const cached = readCache(api.folder);
  const current: State = {
    api,
    last: cached?.scan ?? null,
    running: null,
    parts: [],
    error: "",
    cleanups: new Set(),
  };
  state = current;
  const watcher = setInterval(() => watchCleanups(current), CLEANUPS_EVERY);
  return () => {
    clearInterval(watcher);
    current.running?.stop();
    state = null;
  };
}

/** A scan `bin/disk-scan --fresh` wrote since, from a cleanup session, is the one to show. */
function adoptNewer(current: State): void {
  const cached = readCache(current.api.folder);
  if (cached === null || (current.last !== null && cached.scan.at <= current.last.at)) return;
  current.last = cached.scan;
}

function status(current: State) {
  adoptNewer(current);
  return {
    scan: current.last,
    scanning: current.running !== null,
    parts: current.parts,
    error: current.error,
  };
}

export async function panel(_panelId: string, request: PanelRequest): Promise<unknown> {
  const current = state;
  if (current === null) throw new Error("Disk space is not running.");
  switch (request.path) {
    case "status":
      return status(current);
    case "rescan":
      void rescan(current).catch(() => undefined);
      return status(current);
    default:
      throw new Error(`No such request: ${request.path}`);
  }
}

/** The session a window button starts: a candidate's id, or `group:<safety>` for a group. */
export function launch(_launchId: string, key: string): Launch {
  return {
    prompt: cleanupPrompt(state?.last ?? null, key),
    cwd: homedir(),
    name: "disk-cleanup",
  };
}

/** The session a cleanup became: watched, so the drives are scanned again when it ends. */
export function launched(_launchId: string, _key: string, sessionId: string): void {
  state?.cleanups.add(sessionId);
}
