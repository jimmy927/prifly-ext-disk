/**
 * The last scan, kept on disk: the window shows it at once after a restart,
 * and `bin/disk-scan` — run by sessions, outside the host — reads it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scan, SessionInfo } from "./types";

export type Cached = {
  scan: Scan;
  /** The sessions the scan judged by, archived marks included. */
  sessions: SessionInfo[];
};

function cacheFile(folder: string): string {
  return join(folder, "cache", "scan.json");
}

export function readCache(folder: string): Cached | null {
  const path = cacheFile(folder);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Cached;
}

export function writeCache(folder: string, cached: Cached): void {
  const path = cacheFile(folder);
  mkdirSync(join(folder, "cache"), { recursive: true });
  // Written aside and renamed, so a reader never sees half a file.
  writeFileSync(`${path}.tmp`, JSON.stringify(cached));
  renameSync(`${path}.tmp`, path);
}
