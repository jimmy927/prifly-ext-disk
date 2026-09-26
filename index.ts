/**
 * Disk space: how full each drive is, what takes the space, and what could
 * be cleaned — in a window of its own (`panel/`), summed up in the status bar,
 * and handed to the `disk-cleanup` skill, which asks the reader what to clean
 * and does it.
 *
 * A scan runs at start and every half hour, and on demand from the window.
 * Its result is kept in `cache/scan.json`, with the sessions it judged by, so
 * `bin/disk-scan` — what the skill runs — answers at once and judges sessions
 * the same way; a scan it writes is taken up here too. The Windows folder
 * sizes take minutes to read, so they are read only when the window asks.
 *
 * The window's Clean up buttons start a session each, in a window of its own
 * (prifly's `prifly-launch`), through `launch` with the candidate's id or a
 * group as the key; when such a session ends the drives are scanned again.
 */

import { homedir } from "node:os";
import type { Decoration, ExtensionApi, Launch, LaunchChoice, PanelRequest } from "./prifly-api";
import { readCache, writeCache } from "./scan/cache";
import { readConfig } from "./scan/config";
import { windowsFolders } from "./scan/folders";
import { summary } from "./scan/format";
import { cleanupPrompt } from "./scan/prompt";
import { scan } from "./scan/scan";
import { isLive, readArchived, withArchived } from "./scan/sessions";
import type { Scan, Usage } from "./scan/types";

const EVERY = 30 * 60_000;
/** How often the cleanup sessions this started are looked at, to rescan when one ends. */
const CLEANUPS_EVERY = 60_000;

type State = {
  api: ExtensionApi;
  last: Scan | null;
  running: Promise<Scan> | null;
  windows: { at: number; usage: Usage[] } | null;
  deep: Promise<void> | null;
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
  current.running = scan({
    sessions: info,
    config: readConfig(current.api.folder),
    windowsFolders: current.windows?.usage ?? [],
  })
    .then((result) => {
      current.last = result;
      current.error = "";
      writeCache(current.api.folder, { scan: result, sessions: info, windows: current.windows });
      current.api.show({}, chips(result));
      current.api.log("scanned", { took: result.took, candidates: result.candidates.length });
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

function deepScan(current: State): Promise<void> {
  if (current.deep !== null) return current.deep;
  const letters = (current.last?.drives ?? [])
    .map((drive) => drive.label)
    .filter((label) => /^[A-Z]:$/.test(label));
  current.deep = windowsFolders(letters)
    .then(async (usage) => {
      current.windows = { at: Date.now(), usage };
      await rescan(current);
    })
    .finally(() => {
      current.deep = null;
    });
  return current.deep;
}

/** One chip for the status bar: free space on every drive, warning when one runs low. */
export function chips(result: Scan): Decoration[] {
  const low = result.drives.map((drive) => drive.freeBytes / drive.sizeBytes);
  const worst = Math.min(...low);
  const text = summary(result);
  return [
    {
      key: "drives",
      icon: "hard-drive",
      label: text.label,
      tone: worst < 0.05 ? "critical" : worst < 0.1 ? "warning" : "muted",
      details: text.details,
      launcher: "cleanup",
    },
  ];
}

/** A cleanup session that has ended is what the drives look like now: scan again. */
function watchCleanups(current: State): void {
  if (current.cleanups.size === 0) return;
  const nobody = { ids: new Set<string>(), folders: [] };
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
    windows: cached?.windows ?? null,
    deep: null,
    error: "",
    cleanups: new Set(),
  };
  state = current;
  if (current.last !== null) api.show({}, chips(current.last));
  const soon = setTimeout(() => void rescan(current).catch(() => undefined), 10_000);
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
  current.api.show({}, chips(cached.scan));
}

function status(current: State) {
  adoptNewer(current);
  return {
    scan: current.last,
    scanning: current.running !== null,
    deepScanning: current.deep !== null,
    windowsAt: current.windows?.at ?? 0,
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
    case "deep":
      void deepScan(current).catch((error: unknown) => {
        current.error = error instanceof Error ? error.message : String(error);
      });
      return status(current);
    default:
      throw new Error(`No such request: ${request.path}`);
  }
}

export function choices(): LaunchChoice[] {
  const result = state?.last;
  const detail =
    result === undefined || result === null
      ? "Scans the drives first"
      : `${summary(result).cleanable} could be cleaned, by the last scan`;
  return [{ key: "cleanup", title: "Clean up disk space", detail }];
}

/**
 * The session a launch key starts: `cleanup` from the launcher looks at
 * everything; a candidate's id or `group:<safety>` from the window's buttons
 * cleans just that.
 */
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

/** A click on the status chip opens the cleanup launcher's one item. */
export function open(): { title: string; markdown: string } {
  const result = state?.last;
  if (result === undefined || result === null) {
    return { title: "Disk space", markdown: "No scan yet: it runs a few seconds after start." };
  }
  return { title: "Disk space", markdown: summary(result).markdown };
}
