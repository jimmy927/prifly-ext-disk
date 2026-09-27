/**
 * Disk space: how full each drive is, what takes the space, and what could
 * be cleaned — in a window of its own (`panel/`) — handed to the
 * `disk-cleanup` skill, which asks the reader what to clean and does it.
 *
 * A scan runs ten minutes after start and every half hour, and on demand from the window,
 * whose progress it shows part by part while it runs. Its result is kept in
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
import { readCache, writeCache } from "./scan/cache";
import { readConfig } from "./scan/config";
import type { Part } from "./scan/progress";
import { cleanupPrompt } from "./scan/prompt";
import { scan } from "./scan/scan";
import { isLive, readArchived, withArchived } from "./scan/sessions";
import type { Scan } from "./scan/types";

const EVERY = 30 * 60_000;
/**
 * The first scan waits until the host has settled. Ten seconds in it landed
 * in prifly's own start (index pass, history reading) and made it worse: the
 * walk of ~ and /tmp lstats 6.25 M files, 83 s and 12 GB read from disk with
 * a cold cache (2026-09-27). The cached scan is shown until then, and the
 * window's Rescan runs one at once.
 */
const FIRST_AFTER = 10 * 60_000;
/** How often the cleanup sessions this started are looked at, to rescan when one ends. */
const CLEANUPS_EVERY = 60_000;

type State = {
  api: ExtensionApi;
  last: Scan | null;
  running: Promise<Scan> | null;
  /** The running scan's parts, as far as each has got; the last scan's once it is over. */
  parts: Part[];
  error: string;
  /** The cleanup sessions started from here that were still running when last looked at. */
  cleanups: Set<string>;
};

let state: State | null = null;

function sessions(api: ExtensionApi) {
  return withArchived(api.sessions(), readArchived());
}

function rescan(current: State): Promise<Scan> {
  if (current.running !== null) return current.running;
  const info = sessions(current.api);
  current.running = scan({ sessions: info, config: readConfig(current.api.folder) }, (parts) => {
    current.parts = parts;
  })
    .then((result) => {
      current.last = result;
      current.error = "";
      writeCache(current.api.folder, { scan: result, sessions: info });
      // `ms`, the field prifly's `perf:report` totals time by.
      current.api.log("scanned", { ms: result.took, candidates: result.candidates.length });
      return result;
    })
    .catch((error: unknown) => {
      current.error = error instanceof Error ? error.message : String(error);
      current.api.log("scan_failed", { error: current.error });
      throw error;
    })
    .finally(() => {
      current.running = null;
    });
  return current.running;
}

/** A cleanup session that has ended is what the drives look like now: scan again. */
function watchCleanups(current: State): void {
  if (current.cleanups.size === 0) return;
  // Judged by prifly's own states alone: it knows its sessions whatever the system.
  const nobody = { ids: new Set<string>(), folders: [], known: true };
  const live = new Set(
    sessions(current.api)
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
  const soon = setTimeout(() => void rescan(current).catch(() => undefined), FIRST_AFTER);
  const timer = setInterval(() => void rescan(current).catch(() => undefined), EVERY);
  const watcher = setInterval(() => watchCleanups(current), CLEANUPS_EVERY);
  return () => {
    clearTimeout(soon);
    clearInterval(timer);
    clearInterval(watcher);
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
