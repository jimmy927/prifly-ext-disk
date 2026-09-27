/**
 * fastdu for Linux (`fastdu.c`): the walk in C, compiled on first use with the
 * system's C compiler, under a name carrying the source's hash so a changed
 * source builds anew. Where there is no compiler, `walk.ts` walks in
 * TypeScript instead — about seven times slower on ~/src (2026-09-27: 1.2 s
 * against 7.9 s, with gdu at 4.2 s and ncdu at 2.8 s).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { run } from "../run";
import type { WalkProgress } from "../walk";
import { runStreaming } from "../windows/fastdu";

const SOURCE = join(import.meta.dir, "fastdu.c");
const CACHE = join(import.meta.dir, "..", "..", "cache");

let built: Promise<string> | null = null;

/** The compiled walker; throws when it cannot be built here (no `cc`, a compile error). */
export function linuxFastdu(): Promise<string> {
  if (built === null) {
    built = build().catch((error: unknown) => {
      built = null;
      throw error;
    });
  }
  return built;
}

async function build(): Promise<string> {
  const hash = createHash("sha256").update(readFileSync(SOURCE)).digest("hex").slice(0, 12);
  const exe = join(CACHE, `fastdu-${hash}`);
  if (existsSync(exe)) return exe;
  mkdirSync(CACHE, { recursive: true });
  // Built aside and renamed, so a scan never runs half a binary.
  const partial = `${exe}.${process.pid}`;
  await run(["cc", "-O2", "-pthread", "-o", partial, SOURCE], 120_000);
  renameSync(partial, exe);
  return exe;
}

/** "bytes<TAB>files<TAB>path" lines. */
export function parseSizes(out: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of out.split("\n")) {
    const first = line.indexOf("\t");
    const second = line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    sizes.set(line.slice(second + 1), Number(line.slice(0, first)));
  }
  return sizes;
}

/**
 * Every folder under the roots at least `minBytes`, with the running count. A
 * smaller folder anyone asks about is measured on its own (`sizerOf`).
 */
export async function nativeWalk(
  roots: string[],
  onProgress: (progress: WalkProgress) => void,
  threads: number,
  minBytes = 1e6,
): Promise<{ sizes: Map<string, number>; progress: WalkProgress }> {
  const exe = await linuxFastdu();
  let last: WalkProgress = { dirs: 0, files: 0, bytes: 0 };
  const done = await runStreaming(
    [exe, "-1", String(minBytes), String(threads), ...roots],
    (progress) => {
      last = progress;
      onProgress(progress);
    },
    "/",
  );
  if (done.code !== 0) {
    throw new Error(`fastdu exited ${done.code}: ${done.errors.trim().split("\n").at(-1) ?? ""}`);
  }
  const sizes = parseSizes(done.out);
  // The last tick can be up to a second old: the totals are the roots' own.
  const files = roots.reduce((sum, root) => sum + fileCount(done.out, root), 0);
  const bytes = roots.reduce((sum, root) => sum + (sizes.get(root) ?? 0), 0);
  return { sizes, progress: { dirs: last.dirs, files, bytes } };
}

function fileCount(out: string, root: string): number {
  const line = out.split("\n").find((each) => each.endsWith(`\t${root}`));
  return Number(line?.split("\t")[1] ?? 0);
}
