/**
 * WSL, seen from Windows: when prifly runs on Windows itself, the Linux
 * folders are another system's, reached through `wsl.exe`.
 *
 * The distro walked is the default one, and only while it runs: starting a
 * stopped distro boots WSL's virtual machine, which a scan should not do.
 * Its home folder and /tmp are walked inside it by fastdu's Linux build,
 * which is downloaded into the same `%LOCALAPPDATA%\prifly-disk` as the
 * Windows one and started from there through `/mnt/c` — with `-x`, so the
 * walk stays on the distro's own disk and never wanders into `/mnt/c`.
 */

import { join } from "node:path";
import { parseDf } from "./drives";
import { FASTDU_VERSION, fastduBinary, unixAsset } from "./fastdu-release";
import { fastduWalk } from "./linux/fastdu";
import { run, windowsProgram } from "./run";
import type { Drive } from "./types";
import type { WalkProgress } from "./walk";
import { toolFolder } from "./windows/fastdu";

const WSL = windowsProgram("System32/wsl.exe");

export type Distro = { name: string; running: boolean; isDefault: boolean };

/** `wsl.exe -l -v`, its UTF-16 NULs dropped: the distros, the default marked `*`. */
export function parseDistros(out: string): Distro[] {
  const distros: Distro[] = [];
  for (const line of out.replaceAll("\0", "").replace(/^﻿/, "").split(/\r?\n/).slice(1)) {
    const match = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+\d+\s*$/.exec(line);
    if (match?.[2] === undefined) continue;
    distros.push({ name: match[2], running: match[3] === "Running", isDefault: match[1] === "*" });
  }
  return distros;
}

/** Docker Desktop's distros hold Docker, which `docker.ts` reads; they are not a Linux to walk. */
function isDocker(distro: Distro): boolean {
  return distro.name.startsWith("docker-desktop");
}

/** The distro to walk, or why there is none. */
export function pickDistro(distros: Distro[]): { name: string } | { why: string } {
  const own = distros.filter((distro) => !isDocker(distro));
  const chosen = own.find((distro) => distro.isDefault) ?? own[0];
  if (chosen === undefined) return { why: "no WSL distro is installed" };
  if (!chosen.running) return { why: `${chosen.name} is stopped, and a scan does not start it` };
  return { name: chosen.name };
}

export async function readDistro(): Promise<{ name: string } | { why: string }> {
  try {
    return pickDistro(parseDistros(await run([WSL, "-l", "-v"], 30_000)));
  } catch (error) {
    return { why: `wsl.exe: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function inside(distro: string, argv: string[], timeoutMs = 30_000): Promise<string> {
  return run([WSL, "-d", distro, "--exec", ...argv], timeoutMs);
}

/** The distro's own disk, as the drive "WSL". */
export async function wslDrive(distro: string): Promise<Drive | null> {
  const out = await inside(distro, ["df", "-B1", "--output=target,size,used,avail", "/"]);
  return parseDf(out, true).find((drive) => drive.mount === "/") ?? null;
}

let fetched: Promise<string> | null = null;

/** fastdu's Linux build, as Windows names it; downloaded once. */
function linuxBuild(): Promise<string> {
  if (fetched === null) {
    const asset = unixAsset(process.arch, "linux");
    fetched = (
      asset === null
        ? Promise.reject(new Error(`no fastdu build for linux ${process.arch}`))
        : toolFolder().then((folder) =>
            fastduBinary(asset, join(folder.here, `${asset}-${FASTDU_VERSION}`)),
          )
    ).catch((error: unknown) => {
      fetched = null;
      throw error;
    });
  }
  return fetched;
}

/** The distro's home folder and /tmp, walked inside it; the roots are its own paths. */
export async function wslWalk(
  distro: string,
  onProgress: (progress: WalkProgress) => void,
  threads: number,
  minBytes = 1e6,
): Promise<{ roots: string[]; sizes: Map<string, number>; progress: WalkProgress }> {
  const exe = await linuxBuild();
  // The home folder and where the build is, in the distro's own terms, in one start.
  const said = await inside(distro, ["sh", "-c", 'echo "$HOME"; wslpath -u "$1"', "sh", exe]);
  const [home = "", linuxExe = ""] = said.trim().split("\n");
  if (home === "" || linuxExe === "") throw new Error(`wsl.exe said ${JSON.stringify(said)}`);
  const roots = [home, "/tmp"];
  const command = [WSL, "-d", distro, "--exec", linuxExe];
  const walked = await fastduWalk(command, roots, onProgress, threads, minBytes, undefined);
  return { roots, ...walked };
}
