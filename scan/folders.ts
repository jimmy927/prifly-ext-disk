/**
 * The biggest folders: the "what takes the space" view, read from the walks
 * the scan already made rather than by walking again.
 */

import type { Usage } from "./types";
import type { WindowsFolder } from "./windows/fastdu";

/** Folders under this size are not worth a row. */
const SHOWN = 1e9;

/** How far below each root a folder is still listed on its own. */
const DEPTH = 2;

/** Folders down to two levels below each walked root, from the Linux walk's sizes. */
export function linuxFolders(
  sizes: ReadonlyMap<string, number>,
  roots: string[],
  driveOf: (path: string) => string,
): Usage[] {
  const out: Usage[] = [];
  for (const [path, bytes] of sizes) {
    if (bytes < SHOWN) continue;
    const root = roots.find((each) => path.startsWith(`${each}/`));
    if (root === undefined) continue;
    const depth = path.slice(root.length + 1).split("/").length;
    if (depth <= DEPTH) out.push({ drive: driveOf(path), path, bytes, what: "folder" });
  }
  return out;
}

/** The Windows walk's folders, the drive roots themselves left to the drive bars. */
export function windowsUsage(folders: WindowsFolder[]): Usage[] {
  return folders
    .filter((folder) => folder.depth >= 1 && folder.bytes >= SHOWN)
    .map((folder) => ({
      drive: `${folder.path.slice(0, 1).toUpperCase()}:`,
      path: folder.path,
      bytes: folder.bytes,
      what: "folder",
    }));
}
