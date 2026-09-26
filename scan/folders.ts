/**
 * The biggest folders: the "what takes the space" view.
 *
 * The Linux side is `du` one level down under the home folder and /tmp. The
 * Windows drives are read by PowerShell, one level down from each drive's
 * root; walking terabytes through it takes minutes, so it runs only when
 * asked and its answer is kept.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { duBytes, powershell } from "./run";
import type { Usage } from "./types";

/** Folders under this size are not worth a row. */
const SHOWN = 1e9;

async function children(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(folder, entry.name));
  } catch {
    return [];
  }
}

export async function linuxFolders(roots: string[], drive: string): Promise<Usage[]> {
  const paths = (await Promise.all(roots.map(children))).flat();
  const sizes = await duBytes(paths);
  return [...sizes]
    .filter(([, bytes]) => bytes >= SHOWN)
    .map(([path, bytes]) => ({ drive, path, bytes, what: "folder" }));
}

const WINDOWS_TOP = (drives: string[]) => `
$ErrorActionPreference = "SilentlyContinue"
$out = @()
foreach ($root in @(${drives.map((d) => `"${d}\\"`).join(",")})) {
  Get-ChildItem -LiteralPath $root -Force -Directory -Attributes !ReparsePoint | ForEach-Object {
    $sum = (Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -Attributes !ReparsePoint |
      Measure-Object Length -Sum).Sum
    if ($sum -gt ${SHOWN}) { $out += [pscustomobject]@{ path = $_.FullName; bytes = [long]$sum } }
  }
}
ConvertTo-Json -Compress -InputObject @($out)
`;

/** Each Windows drive's top-level folders, by size. Takes minutes on big drives. */
export async function windowsFolders(driveLabels: string[]): Promise<Usage[]> {
  if (driveLabels.length === 0) return [];
  const out = (await powershell(WINDOWS_TOP(driveLabels), 60 * 60_000)).trim();
  if (out === "") return [];
  return (JSON.parse(out) as { path: string; bytes: number }[]).map((row) => ({
    drive: `${row.path.slice(0, 1).toUpperCase()}:`,
    path: row.path,
    bytes: row.bytes,
    what: "folder",
  }));
}
