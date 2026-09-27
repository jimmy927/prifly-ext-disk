/**
 * One of `walk.ts`'s threads: lists folders and lstats their entries with the
 * synchronous calls, which cost a fraction of a promise each.
 *
 * It is handed a folder, walks down from it until it has looked at `BUDGET`
 * entries, and sends back what it counted and the folders it did not get to,
 * which go back in the shared queue — so one huge folder is spread over every
 * thread instead of keeping one busy while the rest wait.
 */

import { lstatSync, readdirSync, type Stats } from "node:fs";

declare const self: Worker;

/** Entries looked at before handing the rest back. */
const BUDGET = 4000;

export type WalkJob = { dir: string; device: number };

export type WalkReply = {
  /** Folders listed, each with the bytes of the files directly in it. */
  dirs: { path: string; bytes: number }[];
  /** Folders found, each with the blocks of the folder itself. */
  selves: { path: string; bytes: number }[];
  /** Files with more than one name: counted once, by the main thread. */
  linked: { dir: string; ino: number; bytes: number }[];
  /** Folders found but not yet listed. */
  more: string[];
  files: number;
};

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    // Unreadable, or gone since it was found: counted as empty.
    return [];
  }
}

/** One folder's own entries: its bytes, with subfolders pushed and linked files handed up. */
function listOne(dir: string, device: number, stack: string[], reply: WalkReply): number {
  const names = namesIn(dir);
  let bytes = 0;
  for (const name of names) {
    const path = `${dir}/${name}`;
    let info: Stats;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    // Another file system mounted inside: not this drive's space.
    if (info.dev !== device) continue;
    const size = info.blocks * 512;
    if (info.isDirectory()) {
      // A folder's own blocks are counted in it, as du does, not in its parent.
      reply.selves.push({ path, bytes: size });
      stack.push(path);
    } else if (info.nlink > 1) {
      reply.linked.push({ dir, ino: info.ino, bytes: size });
    } else {
      bytes += size;
      reply.files += 1;
    }
  }
  reply.dirs.push({ path: dir, bytes });
  return names.length;
}

function walk(job: WalkJob): WalkReply {
  const reply: WalkReply = { dirs: [], selves: [], linked: [], more: [], files: 0 };
  const stack = [job.dir];
  let looked = 0;
  while (stack.length > 0) {
    if (looked >= BUDGET) {
      reply.more.push(...stack);
      break;
    }
    looked += listOne(stack.pop() as string, job.device, stack, reply);
  }
  return reply;
}

self.onmessage = (event: MessageEvent<WalkJob>) => {
  self.postMessage(walk(event.data));
};
