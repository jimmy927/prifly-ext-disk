/**
 * The Windows drives' folder sizes without fastdu: PowerShell's Get-ChildItem,
 * when fastdu can neither be downloaded nor built, or cannot start (a blocked program).
 *
 * The same folders, two levels below each drive's root, and the same progress
 * lines on standard error, so the window shows the walk moving either way —
 * about nine times slower (C:\Program Files: 28.6 s against 3.3 s,
 * 2026-09-27), which the part says.
 */

import { POWERSHELL } from "../run";
import type { WalkProgress } from "../walk";
import { parseFolders, runStreaming, type WindowsFolder, windowsFolders } from "./fastdu";

/** Each drive's folders one and two levels down, and the drive itself, as fastdu prints them. */
export function slowScript(drives: string[]): string {
  const roots = drives.map((drive) => `"${drive}"`).join(",");
  return `
$ErrorActionPreference = "SilentlyContinue"
$files = [long]0; $bytes = [long]0
function Tell { [Console]::Error.WriteLine("progress\`t0\`t$files\`t$bytes") }
foreach ($root in @(${roots})) {
  $rootBytes = [long]0; $rootFiles = [long]0
  foreach ($file in Get-ChildItem -LiteralPath "$root\\" -Force -File) { $rootBytes += $file.Length; $rootFiles += 1 }
  foreach ($top in Get-ChildItem -LiteralPath "$root\\" -Force -Directory -Attributes !ReparsePoint) {
    $topBytes = [long]0; $topFiles = [long]0
    foreach ($file in Get-ChildItem -LiteralPath $top.FullName -Force -File) { $topBytes += $file.Length; $topFiles += 1 }
    foreach ($sub in Get-ChildItem -LiteralPath $top.FullName -Force -Directory -Attributes !ReparsePoint) {
      $sum = Get-ChildItem -LiteralPath $sub.FullName -Recurse -Force -File -Attributes !ReparsePoint | Measure-Object Length -Sum
      $subBytes = [long]$sum.Sum; $subFiles = [long]$sum.Count
      "{0}\`t{1}\`t{2}" -f $subBytes, $subFiles, $sub.FullName
      $topBytes += $subBytes; $topFiles += $subFiles
      $files += $subFiles; $bytes += $subBytes
      Tell
    }
    "{0}\`t{1}\`t{2}" -f $topBytes, $topFiles, $top.FullName
    $rootBytes += $topBytes; $rootFiles += $topFiles
  }
  "{0}\`t{1}\`t{2}" -f $rootBytes, $rootFiles, $root
}
`;
}

type Walker = (
  drives: string[],
  onProgress: (progress: WalkProgress) => void,
) => Promise<WindowsFolder[]>;

/**
 * fastdu, or PowerShell when fastdu fails for any reason: the folders, and
 * why the slow way was taken (null when it was not).
 */
export async function windowsFoldersOrSlow(
  drives: string[],
  onProgress: (progress: WalkProgress) => void,
  /** Told before the slow walk starts, so what is shown while it runs says so. */
  onSlow: (reason: string) => void = () => undefined,
  fast: Walker = (list, progress) => windowsFolders(list, progress),
  slow: Walker = (list, progress) => slowFolders(list, progress),
): Promise<{ folders: WindowsFolder[]; fellBack: string | null }> {
  try {
    return { folders: await fast(drives, onProgress), fellBack: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onSlow(reason);
    return { folders: await slow(drives, onProgress), fellBack: reason };
  }
}

/** Folders two levels below each drive's root and at least `minBytes`, with the running count. */
export async function slowFolders(
  drives: string[],
  onProgress: (progress: WalkProgress) => void,
  minBytes = 1e9,
): Promise<WindowsFolder[]> {
  if (drives.length === 0) return [];
  const argv = [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", slowScript(drives)];
  const done = await runStreaming(argv, onProgress);
  if (done.code !== 0) {
    throw new Error(
      `PowerShell exited ${done.code}: ${done.errors.trim().split("\n").at(-1) ?? ""}`,
    );
  }
  return parseFolders(done.out.replaceAll("\0", "")).filter((folder) => folder.bytes >= minBytes);
}
