/**
 * Which sessions exist, which are archived, and which are running now.
 *
 * - Running: Claude Code writes `~/.claude/sessions/<pid>.json` (session id,
 *   cwd, name) for each process; a file whose process is alive is a running
 *   session, whatever started it — prifly, a terminal, an IDE.
 * - Archived: the extension API does not say, so the marks are read from
 *   prifly's database, as the window stores them (`prifly.archivedSessions`).
 * - Known: the extension has `api.sessions()`; `bin/disk-scan`, outside the
 *   host, reads prifly's list of transcripts (`history_files`) instead.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionSession } from "../prifly-api";
import type { SessionInfo } from "./types";

export const PRIFLY_DB = join(homedir(), ".local", "share", "prifly", "prifly.db");
const PROCESS_FILES = join(homedir(), ".claude", "sessions");

/**
 * What is running now: session ids, and the folders any process works in.
 * `known` is false where that cannot be read — no `/proc`, as on macOS — and
 * then nothing that depends on it may be offered for cleaning: every session
 * would look ended, and a running one's folders would look safe to remove.
 */
export type Running = { ids: Set<string>; folders: string[]; known: boolean };

/** prifly states whose process is gone; any other has one, idle or not. */
const GONE = new Set(["ended", "unknown"]);

export function isLive(session: SessionInfo, running: Running): boolean {
  return running.ids.has(session.id) || !GONE.has(session.state);
}

type ProcessFile = { pid: number; sessionId: string; cwd: string };

async function runningIds(proc: string, processFiles: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let files: string[];
  try {
    files = await readdir(processFiles);
  } catch {
    return ids;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(join(processFiles, file), "utf8")) as ProcessFile;
      if (existsSync(`${proc}/${entry.pid}`)) ids.add(entry.sessionId);
    } catch {
      // Half written by a process starting up; the next scan reads it whole.
    }
  }
  return ids;
}

/** The folders running processes work in. */
async function processFolders(proc: string): Promise<string[]> {
  const out = new Set<string>();
  for (const pid of await readdir(proc)) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      out.add(await readlink(`${proc}/${pid}/cwd`));
    } catch {
      // Ended between the listing and the read, or another user's.
    }
  }
  return [...out];
}

/** Whether a Windows process lives: signal 0 asks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Someone else's, still running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * On Windows, which has no `/proc`: the sessions whose process lives, and the
 * folders they work in. Other programs' folders cannot be read, which a
 * worktree's "changed N hours ago" still guards against.
 */
async function runningOnWindows(processFiles: string): Promise<Running> {
  const ids = new Set<string>();
  const folders: string[] = [];
  let files: string[] = [];
  try {
    files = await readdir(processFiles);
  } catch {
    // No session has run here yet.
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(join(processFiles, file), "utf8")) as ProcessFile;
      if (!alive(entry.pid)) continue;
      ids.add(entry.sessionId);
      folders.push(entry.cwd);
    } catch {
      // Half written by a process starting up; the next scan reads it whole.
    }
  }
  return { ids, folders, known: true };
}

/**
 * The running sessions and processes, from `/proc` — on Windows from the
 * sessions' own process files. Where neither can be read, the answer says it
 * does not know rather than that nothing runs.
 */
export async function readRunning(
  proc: string | null = process.platform === "win32" ? null : "/proc",
  processFiles = PROCESS_FILES,
): Promise<Running> {
  if (proc === null) return runningOnWindows(processFiles);
  if (!existsSync(`${proc}/self`)) return { ids: new Set(), folders: [], known: false };
  const [ids, folders] = await Promise.all([runningIds(proc, processFiles), processFolders(proc)]);
  return { ids, folders, known: true };
}

function openDb(dbPath: string): Database | null {
  return existsSync(dbPath) ? new Database(dbPath, { readonly: true }) : null;
}

export function readArchived(dbPath = PRIFLY_DB): Set<string> {
  const db = openDb(dbPath);
  if (db === null) return new Set();
  try {
    const row = db
      .query<{ value: string }, [string]>("select value from settings where key = ?")
      .get("prifly.archivedSessions");
    if (row === null) return new Set();
    return new Set(Object.keys(JSON.parse(row.value) as Record<string, number>));
  } finally {
    db.close();
  }
}

export function withArchived(sessions: ExtensionSession[], archived: Set<string>): SessionInfo[] {
  return sessions.map((session) => ({ ...session, archived: archived.has(session.id) }));
}

/** Every session prifly has a transcript of, for `bin/disk-scan`; their state is not known here. */
export function readKnown(dbPath = PRIFLY_DB): SessionInfo[] {
  const db = openDb(dbPath);
  if (db === null) return [];
  try {
    const archived = readArchived(dbPath);
    return db
      .query<{ id: string; title: string; cwd: string }, []>(
        "select session_id as id, title, cwd from history_files",
      )
      .all()
      .map((row) => ({ ...row, state: "unknown", archived: archived.has(row.id) }));
  } finally {
    db.close();
  }
}

/**
 * A path as two Windows paths compare alike: `/` for `\`, lower case. git
 * writes `C:/Users/…` where prifly and Windows write `C:\Users\…`.
 */
function same(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) ? path.replaceAll("\\", "/").toLowerCase() : path;
}

/** Whether `path` is `folder` or inside it. */
export function within(path: string, folder: string): boolean {
  const [inner, outer] = [same(path), same(folder).replace(/\/$/, "")];
  return inner === outer || inner.startsWith(`${outer}/`);
}

/** The sessions whose working folder is `folder` or inside it. */
export function sessionsIn(folder: string, sessions: SessionInfo[]): SessionInfo[] {
  return sessions.filter((session) => within(session.cwd, folder));
}

/** Whether any of `folders` is `path` or inside it. */
export function inUse(path: string, folders: string[]): boolean {
  return folders.some((folder) => within(folder, path));
}

/**
 * The session id a path sits under, when it is inside a scratch folder:
 * `/tmp/claude-<uid>/<project>/<id>/…`, or on Windows `%TEMP%\claude\<project>\<id>\…`.
 */
export function scratchOwner(path: string): string | null {
  const match =
    /^\/tmp\/claude-\d+\/[^/]+\/([0-9a-f-]{36})(?:\/|$)/.exec(path) ??
    /[\\/]claude[\\/][^\\/]+[\\/]([0-9a-f-]{36})(?:[\\/]|$)/.exec(same(path));
  return match?.[1] ?? null;
}
