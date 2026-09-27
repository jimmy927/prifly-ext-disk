/**
 * fastdu for Linux and macOS: the walk in C, from fastdu's release
 * (`fastdu-release.ts`), downloaded on first use. Where it cannot be had,
 * `walk.ts` walks in TypeScript instead — about seven times slower on ~/src
 * (2026-09-27: 1.2 s against 7.9 s, with gdu at 4.2 s and ncdu at 2.8 s).
 */

import { join } from "node:path";
import { FASTDU_VERSION, fastduBinary, unixAsset } from "../fastdu-release";
import type { WalkProgress } from "../walk";
import { runStreaming, walkFailed } from "../windows/fastdu";

const CACHE = join(import.meta.dir, "..", "..", "cache");

let fetched: Promise<string> | null = null;

/** The walker; throws when it cannot be had here (offline, no build for this processor). */
export function linuxFastdu(): Promise<string> {
  if (fetched === null) {
    const asset = unixAsset();
    fetched = (
      asset === null
        ? Promise.reject(new Error(`no fastdu build for ${process.platform} ${process.arch}`))
        : fastduBinary(asset, join(CACHE, `fastdu-${FASTDU_VERSION}`))
    ).catch((error: unknown) => {
      fetched = null;
      throw error;
    });
  }
  return fetched;
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
  // du's options: -x one file system per root, -D a root given as a symbolic
  // link is followed, -B1 disk usage in bytes, --file-count the file-count
  // column, -t the smallest folder printed.
  const argv = [exe, "-p", "-x", "-D", "-B1", "--file-count", "-t", String(minBytes)];
  const done = await runStreaming(
    [...argv, "-j", String(threads), "--", ...roots],
    (progress) => {
      last = progress;
      onProgress(progress);
    },
    "/",
  );
  if (walkFailed(done)) {
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
