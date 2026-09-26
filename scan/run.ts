/** Running the programs a scan reads from. */

import { existsSync } from "node:fs";

export const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/** Under WSL, with Windows reachable: the disk images and Windows drives can be read. */
export function onWsl(): boolean {
  return existsSync(POWERSHELL);
}

export class CommandFailed extends Error {}

/** A program's standard output; a non-zero exit or a timeout throws `CommandFailed`. */
export async function run(argv: string[], timeoutMs = 120_000, cwd?: string): Promise<string> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd === undefined ? {} : { cwd }),
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) {
    const last = err.trim().split("\n").at(-1) ?? "";
    throw new CommandFailed(`${argv[0]} exited ${code}: ${last}`);
  }
  return out;
}

/**
 * A PowerShell script's output, run from a Windows folder: started from a
 * WSL path PowerShell warns about UNC paths. Output is UTF-16 on some hosts,
 * so NULs are dropped.
 */
export async function powershell(script: string, timeoutMs = 120_000): Promise<string> {
  const out = await run(
    [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", script],
    timeoutMs,
    "/mnt/c",
  );
  return out.replaceAll("\0", "");
}

/** Bytes used under each path, `du -sx`; paths that vanish are left out. */
export async function duBytes(paths: string[], timeoutMs = 600_000): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (paths.length === 0) return sizes;
  const proc = Bun.spawn(["du", "-sx", "--block-size=1", "--", ...paths], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)));
  }
  return sizes;
}

/** "42.59GB" → bytes, as Docker writes sizes. */
export function parseSize(text: string): number {
  const match = /^([\d.]+)\s*([kKMGT]?B)/.exec(text.trim());
  if (match === null) return 0;
  const units: Record<string, number> = {
    B: 1,
    kB: 1e3,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
  };
  return Number(match[1]) * (units[match[2] ?? "B"] ?? 1);
}
