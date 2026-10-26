/**
 * Claude Code's per-session scratch folders: `/tmp/claude-<uid>/<project>/<session id>`,
 * on Windows `%TEMP%\claude\<project>\<session id>`.
 *
 * They are never cleaned by Claude Code. On 2026-09-26 they held 86 GB, 43 GB
 * of it one live session's. A folder is offered when its session is archived
 * (safe) or ended and not archived (check); a live session's is only counted.
 */

import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inUse, isLive, type Running } from "./sessions";
import type { Candidate, SessionInfo, Usage } from "./types";
import type { Sizer } from "./walk";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Folders smaller than this are left out of the list, though still counted. */
const LISTED = 200e6;

/** `/tmp/claude-<uid>`; on Windows, which has no uid, `%TEMP%\claude`. */
export function scratchRoot(): string {
  if (process.platform === "win32") return join(tmpdir(), "claude");
  return `/tmp/claude-${process.getuid?.() ?? 1000}`;
}

/** The last name in a path, either way it is separated: the session id of a scratch folder. */
function lastName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? "";
}

async function sessionFolders(root: string): Promise<string[]> {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    let entries: string[];
    try {
      entries = await readdir(join(root, project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SESSION_ID.test(entry)) out.push(join(root, project, entry));
    }
  }
  return out;
}

export type ScratchFolder = { path: string; bytes: number; session: SessionInfo | null };

export async function readScratch(sessions: SessionInfo[], size: Sizer): Promise<ScratchFolder[]> {
  const folders = await sessionFolders(scratchRoot());
  const sizes = await size(folders);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return folders.map((path) => ({
    path,
    bytes: sizes.get(path) ?? 0,
    session: byId.get(lastName(path)) ?? null,
  }));
}

export function scratchFindings(
  folders: ScratchFolder[],
  running: Running,
  drive: string,
): { usage: Usage; candidates: Candidate[] } {
  const total = folders.reduce((sum, folder) => sum + folder.bytes, 0);
  const candidates: Candidate[] = [];
  for (const folder of folders) {
    const candidate = scratchCandidate(folder, running, drive);
    if (candidate !== null && candidate.bytes >= LISTED) candidates.push(candidate);
  }
  return {
    usage: { drive, path: scratchRoot(), bytes: total, what: "Claude session scratch folders" },
    candidates,
  };
}

function scratchCandidate(
  folder: ScratchFolder,
  running: Running,
  drive: string,
): Candidate | null {
  const { session } = folder;
  if (inUse(folder.path, running.folders)) return null;
  if (running.ids.has(lastName(folder.path))) return null;
  if (session !== null && isLive(session, running)) return null;
  const archived = session?.archived === true;
  const title = session === null ? "a session prifly has no record of" : `“${session.title}”`;
  return {
    id: `scratch:${folder.path}`,
    kind: "scratch",
    title: `Scratch folder of ${title}`,
    path: folder.path,
    bytes: folder.bytes,
    drive,
    safety: archived ? "safe" : "check",
    why: archived ? "the session is archived" : "the session is not running and not archived",
    blockers: archived ? [] : ["resuming the session later finds its scratch files gone"],
  };
}
