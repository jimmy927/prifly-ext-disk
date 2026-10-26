/**
 * The drives: this Linux's own disk and, under WSL, each Windows drive; on
 * Windows itself, its drives and the WSL distro's disk (`wsl.ts`).
 */

import { powershell, run } from "./run";
import type { Drive } from "./types";

/** Windows drives appear as `/mnt/<letter>`; the rest of `/mnt` is WSL's own plumbing. */
const WINDOWS_MOUNT = /^\/mnt\/([a-z])$/;

/** How a person names a mount: "C:" for `/mnt/c`, "WSL" for `/` under WSL, else the path. */
export function driveLabel(mount: string, wsl: boolean): string {
  const letter = WINDOWS_MOUNT.exec(mount)?.[1];
  if (letter !== undefined) return `${letter.toUpperCase()}:`;
  if (mount === "/") return wsl ? "WSL" : "/";
  return mount;
}

/** `df -B1 --output=target,size,used,avail` → the drives worth showing. */
export function parseDf(out: string, wsl: boolean): Drive[] {
  const drives: Drive[] = [];
  for (const line of out.trim().split("\n").slice(1)) {
    const [mount, size, used, avail] = line.trim().split(/\s+/);
    if (mount === undefined || size === undefined || used === undefined || avail === undefined) {
      continue;
    }
    if (mount !== "/" && !WINDOWS_MOUNT.test(mount)) continue;
    drives.push({
      mount,
      label: driveLabel(mount, wsl),
      sizeBytes: Number(size),
      usedBytes: Number(used),
      freeBytes: Number(avail),
    });
  }
  return drives;
}

type LogicalDisk = { DeviceID: string; Size: number; FreeSpace: number };

/** `Win32_LogicalDisk` as JSON → the fixed drives, "C:" mounted at `C:\`. */
export function parseLogicalDisks(out: string): Drive[] {
  if (out.trim() === "") return [];
  return (JSON.parse(out) as LogicalDisk[]).map((disk) => ({
    mount: `${disk.DeviceID}\\`,
    label: disk.DeviceID,
    sizeBytes: disk.Size,
    usedBytes: disk.Size - disk.FreeSpace,
    freeBytes: disk.FreeSpace,
  }));
}

/**
 * The fixed drives, read on Windows itself — not with `df`, which Git for
 * Windows brings and which takes its own install folder for `/`.
 */
export async function readWindowsDrives(): Promise<Drive[]> {
  return parseLogicalDisks(
    (
      await powershell(
        "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, Size, FreeSpace)",
        30_000,
      )
    ).trim(),
  );
}

/** This system's drives with `df`: Linux or macOS, and the Windows drives under WSL. */
export async function readDrives(wsl: boolean): Promise<Drive[]> {
  // A Windows drive that is asleep or unplugged makes df complain and exit 1
  // while still printing the others, so its exit code is not trusted.
  const proc = Bun.spawn(["df", "-B1", "--output=target,size,used,avail"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (out.trim() === "") return parseDf(await run(["df", "-B1", "/"]), wsl);
  return parseDf(out, wsl);
}

/** The drive a Linux or Windows path lives on, by the longest mount that holds it. */
export function driveOf(path: string, drives: Drive[]): string {
  const windows = /^([A-Za-z]):[\\/]/.exec(path);
  if (windows?.[1] !== undefined) return `${windows[1].toUpperCase()}:`;
  let best: Drive | undefined;
  for (const drive of drives) {
    const inside =
      drive.mount === "/" || path === drive.mount || path.startsWith(`${drive.mount}/`);
    if (inside && (best === undefined || drive.mount.length > best.mount.length)) best = drive;
  }
  return best?.label ?? "?";
}
