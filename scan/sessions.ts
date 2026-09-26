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

/** What is running now: session ids, and the folders any process works in. */
export type Running = { ids: Set<string>; folders: string[] };

/** prifly states whose process is gone; any other has one, idle or not. */
const GONE = new Set(["ended", "unknown"]);

export function isLive(session: SessionInfo, running: Running): boolean {
  return running.ids.has(session.id) || !GONE.has(session.state);
}

type ProcessFile = { pid: number; sessionId: string; cwd: string };

async function runningIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let files: string[];
  try {
    files = await readdir(PROCESS_FILES);
  } catch {
    return ids;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(join(PROCESS_FILES, file), "utf8")) as ProcessFile;
      if (existsSync(`/proc/${entry.pid}`)) ids.add(entry.sessionId);
    } catch {
      // Half written by a process starting up; the next scan reads it whole.
    }
  }
  return ids;
}

/** The folders running processes work in. */
async function processFolders(): Promise<string[]> {
  const out = new Set<string>();
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      out.add(await readlink(`/proc/${pid}/cwd`));
    } catch {
      // Ended between the listing and the read, or another user's.
    }
  }
  return [...out];
}

export async function readRunning(): Promise<Running> {
  const [ids, folders] = await Promise.all([runningIds(), processFolders()]);
  return { ids, folders };
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

/** The sessions whose working folder is `folder` or inside it. */
export function sessionsIn(folder: string, sessions: SessionInfo[]): SessionInfo[] {
  return sessions.filter(
    (session) => session.cwd === folder || session.cwd.startsWith(`${folder}/`),
  );
}

/** Whether any of `folders` is `path` or inside it. */
export function inUse(path: string, folders: string[]): boolean {
  return folders.some((folder) => folder === path || folder.startsWith(`${path}/`));
}

/** The session id a path sits under, when it is inside a scratch folder `/tmp/claude-<uid>/<project>/<id>/…`. */
export function scratchOwner(path: string): string | null {
  const match = /^\/tmp\/claude-\d+\/[^/]+\/([0-9a-f-]{36})(?:\/|$)/.exec(path);
  return match?.[1] ?? null;
}
