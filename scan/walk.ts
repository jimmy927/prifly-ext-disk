/**
 * Folder sizes on this Linux, in one pass, on many threads.
 *
 * `walkFastest` runs fastdu in C (`linux/fastdu.c`), 1.2 s on ~/src (1.1 M
 * files) where gdu took 4.2 s and ncdu 2.8 s (2026-09-27, medians under
 * load). Where it cannot be built — no C compiler — `walk` below does the same
 * in TypeScript, about 7.9 s:
 *
 * A directory listing gives names and types but not sizes, so every file
 * needs an `lstat` — the slow part, and `du` does them one after another. Here
 * a thread per core (`walk-worker.ts`) lists and lstats with the synchronous
 * calls, taking folders from one queue. On ~/src `du` took 119 s with a cold
 * cache and 16 s warm; one thread of this took 24 s warm.
 *
 * The whole tree is walked once: every folder's size comes out of the same
 * pass, so the scratch folders, the worktrees and the biggest folders are all
 * looked up in it rather than walked again for each.
 *
 * Counted like `du -x`: allocated blocks, one file system only, and a file
 * with several hard links once — `node_modules` hard-linked between checkouts
 * is on the disk once (counting each name doubled ~/src to 98 GB).
 */

import { lstatSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname } from "node:path";
import { nativeWalk } from "./linux/fastdu";
import { duBytes } from "./run";
import type { WalkJob, WalkReply } from "./walk-worker";

/** The size of each of these folders: the parts of a scan that need sizes ask this. */
export type Sizer = (paths: string[]) => Promise<Map<string, number>>;

/**
 * Sizes looked up in a walk; a folder it did not cover — a worktree outside
 * the walked roots — is measured on its own.
 */
export function sizerOf(sizes: ReadonlyMap<string, number>): Sizer {
  return async (paths) => {
    const out = new Map<string, number>();
    const missing: string[] = [];
    for (const path of paths) {
      const known = sizes.get(path);
      if (known === undefined) missing.push(path);
      else out.set(path, known);
    }
    for (const [path, bytes] of await duBytes(missing)) out.set(path, bytes);
    return out;
  };
}

export type WalkProgress = { dirs: number; files: number; bytes: number };

export type Walked = {
  /** Allocated bytes under each folder walked, itself included. */
  sizes: Map<string, number>;
  progress: WalkProgress;
};

/**
 * The fastest walk this machine can do: fastdu in C (`linux/fastdu.c`), or,
 * when it cannot be built or run here, the TypeScript walk below — with why.
 */
export async function walkFastest(
  roots: string[],
  onProgress: (progress: WalkProgress) => void,
  threads = availableParallelism(),
  native: typeof nativeWalk = nativeWalk,
): Promise<Walked & { fellBack: string | null }> {
  try {
    return { ...(await native(roots, onProgress, threads)), fellBack: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...(await walk(roots, onProgress, threads)), fellBack: reason };
  }
}

type Pending = { dir: string; device: number };

/** Every folder's own bytes, summed into its parents, deepest first. */
function sumUp(own: Map<string, number>, roots: string[]): Map<string, number> {
  const sizes = new Map(own);
  const byDepth = [...own.keys()].sort((a, b) => b.split("/").length - a.split("/").length);
  const top = new Set(roots);
  for (const path of byDepth) {
    if (top.has(path)) continue;
    const parent = dirname(path);
    const mine = sizes.get(path) ?? 0;
    sizes.set(parent, (sizes.get(parent) ?? 0) + mine);
  }
  return sizes;
}

export async function walk(
  roots: string[],
  onProgress: (progress: WalkProgress) => void = () => undefined,
  threads = availableParallelism(),
): Promise<Walked> {
  const progress: WalkProgress = { dirs: 0, files: 0, bytes: 0 };
  const own = new Map<string, number>();
  const seen = new Set<string>();
  const queue: Pending[] = [];
  for (const root of roots) {
    const info = lstatSync(root);
    own.set(root, info.blocks * 512);
    queue.push({ dir: root, device: info.dev });
  }
  const devices = new Map(queue.map((job) => [job.dir, job.device]));
  const deviceOf = (dir: string): number => {
    for (const [root, device] of devices)
      if (dir === root || dir.startsWith(`${root}/`)) return device;
    return -1;
  };

  const take = (reply: WalkReply) => {
    for (const { path, bytes } of [...reply.dirs, ...reply.selves]) {
      own.set(path, (own.get(path) ?? 0) + bytes);
      progress.bytes += bytes;
    }
    for (const { dir, ino, bytes } of reply.linked) {
      const key = `${deviceOf(dir)}:${ino}`;
      if (seen.has(key)) continue;
      seen.add(key);
      own.set(dir, (own.get(dir) ?? 0) + bytes);
      progress.bytes += bytes;
      progress.files += 1;
    }
    progress.dirs += reply.dirs.length;
    progress.files += reply.files;
    for (const dir of reply.more) queue.push({ dir, device: deviceOf(dir) });
  };

  const workers = Array.from(
    { length: Math.max(1, threads) },
    () => new Worker(new URL("./walk-worker.ts", import.meta.url).href),
  );
  const timer = setInterval(() => onProgress({ ...progress }), 1000);
  try {
    await new Promise<void>((resolve, reject) => {
      const idle = new Set(workers);
      // Every idle thread gets a folder while there are any; done when none is
      // queued and none is out.
      const dispatch = () => {
        for (const worker of idle) {
          const job = queue.pop();
          if (job === undefined) break;
          idle.delete(worker);
          worker.postMessage({ dir: job.dir, device: job.device } satisfies WalkJob);
        }
        if (queue.length === 0 && idle.size === workers.length) resolve();
      };
      for (const worker of workers) {
        worker.onmessage = (event: MessageEvent<WalkReply>) => {
          take(event.data);
          idle.add(worker);
          dispatch();
        };
        worker.onerror = (event) => reject(new Error(event.message));
      }
      dispatch();
    });
  } finally {
    clearInterval(timer);
    for (const worker of workers) worker.terminate();
  }
  onProgress({ ...progress });
  return { sizes: sumUp(own, roots), progress };
}
