/**
 * Git worktrees no session needs any more.
 *
 * prifly makes a worktree per session and removes it on archive only when
 * asked, so they pile up: on 2026-09-25 there were 43 with no live session.
 * One is left out while a running session or process works in it, or it sits
 * in a running session's scratch folder. It is safe when clean, pushed and
 * untouched for a day; otherwise a person checks first — sessions also make
 * worktrees outside their own folder (`~/src/lc-*` next to liveconquest) and
 * nothing but recent changes tells those apart.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./run";
import { inUse, isLive, type Running, scratchOwner, sessionsIn } from "./sessions";
import type { Candidate, SessionInfo } from "./types";
import type { Sizer } from "./walk";

export type Worktree = {
  path: string;
  repo: string;
  branch: string;
  locked: boolean;
};

/** A worktree changed more recently than this may still be some running session's. */
const RECENT_MS = 24 * 60 * 60_000;

/** `git worktree list --porcelain` → the linked worktrees (the main checkout is not one). */
export function parseWorktrees(out: string, repo: string): Worktree[] {
  const trees: Worktree[] = [];
  for (const block of out.trim().split("\n\n").slice(1)) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const space = line.indexOf(" ");
      fields.set(space < 0 ? line : line.slice(0, space), space < 0 ? "" : line.slice(space + 1));
    }
    const path = fields.get("worktree");
    if (path === undefined || fields.has("bare")) continue;
    trees.push({
      path,
      repo,
      branch: (fields.get("branch") ?? "detached HEAD").replace("refs/heads/", ""),
      locked: fields.has("locked"),
    });
  }
  return trees;
}

/**
 * Main checkouts: every folder with a `.git` folder in the roots and one level
 * below, once each — a symlink to a repository is the same repository.
 */
export async function findRepos(roots: string[]): Promise<string[]> {
  const repos = new Map<string, string>();
  const consider = (path: string) => {
    if (!existsSync(join(path, ".git", "HEAD"))) return;
    const real = realpathSync(path);
    if (!repos.has(real)) repos.set(real, real);
  };
  for (const root of roots) {
    consider(root);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) consider(join(root, entry));
  }
  return [...repos.values()];
}

export function defaultRoots(): string[] {
  return [homedir(), join(homedir(), "src")];
}

export type TreeState = { dirty: number; unpushed: number; changedAt: number };

function mtime(path: string): number {
  return existsSync(path) ? statSync(path).mtimeMs : 0;
}

/**
 * When somebody last worked in it: its last commit, its HEAD reflog (moves on
 * commit and checkout), its changed files and its top-level entries. Not the
 * index — `git status` rewrites that, so a scan would count as work.
 */
async function treeState(tree: Worktree): Promise<TreeState> {
  const git = ["git", "--no-optional-locks", "-C", tree.path];
  const [status, unpushed, gitDir, lastCommit] = await Promise.all([
    run([...git, "status", "--porcelain"], 30_000),
    run([...git, "rev-list", "--count", "HEAD", "--not", "--remotes"], 30_000),
    run([...git, "rev-parse", "--absolute-git-dir"], 30_000),
    run([...git, "log", "-1", "--format=%ct"], 30_000),
  ]);
  const changed = status.split("\n").filter((line) => line.trim() !== "");
  const filesAt = changed.slice(0, 200).map((line) => mtime(join(tree.path, line.slice(3))));
  // A build or a new file moves its top-level folder's time, tracked or not.
  const topAt = (await readdir(tree.path)).map((entry) => mtime(join(tree.path, entry)));
  return {
    dirty: changed.length,
    unpushed: Number(unpushed.trim()),
    changedAt: Math.max(
      mtime(join(gitDir.trim(), "logs", "HEAD")),
      Number(lastCommit.trim()) * 1000,
      ...filesAt,
      ...topAt.filter((_, i) => i < 500),
    ),
  };
}

export async function readWorktrees(repos: string[]): Promise<Worktree[]> {
  const all = await Promise.all(
    repos.map(async (repo) => {
      try {
        return parseWorktrees(
          await run(["git", "-C", repo, "worktree", "list", "--porcelain"]),
          repo,
        );
      } catch {
        return [];
      }
    }),
  );
  return all.flat().filter((tree) => existsSync(tree.path));
}

/** Whether a running session or process has a claim on it. */
function claimed(tree: Worktree, sessions: SessionInfo[], running: Running): boolean {
  if (tree.locked || inUse(tree.path, running.folders)) return true;
  const owner = scratchOwner(tree.path);
  if (owner !== null && running.ids.has(owner)) return true;
  return sessionsIn(tree.path, sessions).some((session) => isLive(session, running));
}

/**
 * Worktrees read at once. Each is four `git` processes, and starting one
 * blocks the thread for about 2 ms: all 197 worktrees' 788 started together
 * held prifly's event loop for 1.5 s (2026-09-27). Eight at a time lets it
 * breathe between them and takes no longer — the git calls are quick.
 */
const TREES_AT_ONCE = 8;

/** `each` over `items` with at most `limit` running, results in order. */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  each: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await each(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

export async function worktreeCandidates(
  trees: Worktree[],
  sessions: SessionInfo[],
  running: Running,
  driveOf: (path: string) => string,
  size: Sizer,
): Promise<Candidate[]> {
  const idle = trees.filter((tree) => !claimed(tree, sessions, running));
  const [sizes, states] = await Promise.all([
    size(idle.map((tree) => tree.path)),
    mapLimited(idle, TREES_AT_ONCE, (tree) => treeState(tree).catch(() => null)),
  ]);
  const now = Date.now();
  return idle.flatMap((tree, i) => {
    const state = states[i];
    if (state === null || state === undefined) return [];
    const inside = sessionsIn(tree.path, sessions);
    return [
      worktreeCandidate(tree, state, inside, sizes.get(tree.path) ?? 0, driveOf(tree.path), now),
    ];
  });
}

function hoursAgo(at: number, now: number): string {
  const hours = Math.max(1, Math.round((now - at) / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

export function worktreeCandidate(
  tree: Worktree,
  state: TreeState,
  sessions: SessionInfo[],
  bytes: number,
  drive: string,
  now: number,
): Candidate {
  const blockers: string[] = [];
  if (state.dirty > 0)
    blockers.push(`${state.dirty} uncommitted change(s): save them before removing`);
  if (state.unpushed > 0)
    blockers.push(`${state.unpushed} commit(s) not pushed: push or bundle them first`);
  if (now - state.changedAt < RECENT_MS) {
    blockers.push(`changed ${hoursAgo(state.changedAt, now)}: a running session may still use it`);
  }
  const archived = sessions.length > 0 && sessions.every((session) => session.archived);
  const why =
    sessions.length === 0
      ? "no session works in it"
      : `its ${sessions.length} session(s) are not running${archived ? " and are archived" : ""}`;
  return {
    id: `worktree:${tree.path}`,
    kind: "worktree",
    title: `Worktree ${tree.path.split("/").at(-1)} (${tree.branch})`,
    path: tree.path,
    bytes,
    drive,
    safety: blockers.length === 0 ? "safe" : "check",
    why,
    blockers,
  };
}
