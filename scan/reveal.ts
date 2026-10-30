/**
 * "Show in Explorer": a tile's folder (or file, selected in its folder) opened
 * in the system's file manager. What to start is decided by pure functions —
 * `revealCommand` per platform and kind of path — and `reveal` is the only
 * part that stats and spawns, so a test never opens a window.
 *
 * Only a path the latest scan reported is opened (`scannedPath`): the window
 * sends a path, and a path from a request is not to be trusted with a
 * program start.
 */

import { statSync } from "node:fs";
import { posix } from "node:path";
import { ON_WINDOWS, onWsl, WINDOWS_CWD, windowsProgram } from "./run";
import type { Scan } from "./types";
import { readDistro } from "./wsl";

/** Where this runs, as far as opening a folder cares. */
export type Host = {
  platform: NodeJS.Platform;
  /** Linux under Windows' WSL, with Windows reachable. */
  wsl: boolean;
  /** The WSL distro whose files are `/…` paths: this one under WSL, the default one from Windows. */
  distro: string | null;
};

export type Command = {
  program: "explorer" | "open" | "xdg-open";
  args: string[];
  /** Explorer answers 1 even when it worked, so its exit code says nothing. */
  ignoreExit: boolean;
};

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/** What the reader's file manager is called here: Explorer, Finder, or Files. */
export function fileManagerName(host: Host): string {
  if (host.platform === "win32" || host.wsl) return "Explorer";
  return host.platform === "darwin" ? "Finder" : "Files";
}

/** `path` if the scan listed it as something taking space, else why not. */
export function scannedPath(
  scan: Scan | null,
  path: unknown,
): { path: string } | { error: string } {
  if (typeof path !== "string" || path === "") return { error: "No path was given." };
  if (scan === null) return { error: "There is no scan yet, so there is nothing to open." };
  if (!scan.usage.some((item) => item.path === path))
    return { error: "That path is not in the last scan, so it is not opened." };
  return { path };
}

/** `/mnt/c/Users/x` as `C:\Users\x`; null for any other path. */
function mountToWindows(path: string): string | null {
  const match = /^\/mnt\/([a-z])(\/.*)?$/.exec(path);
  if (match?.[1] === undefined) return null;
  return `${match[1].toUpperCase()}:${(match[2] ?? "\\").replaceAll("/", "\\")}`;
}

/**
 * The path as Windows' Explorer names it, or why it has none here: a Windows
 * path as it is, `/mnt/c/…` as `C:\…`, and any other Linux path as
 * `\\wsl$\<distro>\…`.
 */
export function windowsPath(host: Host, path: string): { path: string } | { error: string } {
  if (WINDOWS_PATH.test(path)) return { path: path.replaceAll("/", "\\") };
  if (!path.startsWith("/")) return { error: `${path} is not an absolute path.` };
  const mounted = host.wsl ? mountToWindows(path) : null;
  if (mounted !== null) return { path: mounted };
  if (host.distro === null || host.distro === "")
    return {
      error: "The WSL distro that holds this folder is not known, so Explorer cannot reach it.",
    };
  return { path: `\\\\wsl$\\${host.distro}${path.replaceAll("/", "\\")}` };
}

/**
 * The path as this host's own file system names it, to look at: a Windows
 * path under WSL is `/mnt/<drive>/…`, a Linux path from Windows is the
 * `\\wsl$\…` one. Null where this host cannot reach it.
 */
export function localPath(host: Host, path: string): string | null {
  const windowsStyle = WINDOWS_PATH.test(path);
  if (host.platform === "win32") {
    const found = windowsPath(host, path);
    return "error" in found ? null : found.path;
  }
  if (!windowsStyle) return path;
  if (!host.wsl) return null;
  return `/mnt/${path[0]?.toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
}

/** What to start to show `path`: a file selected in its folder, a folder opened. */
export function revealCommand(
  host: Host,
  path: string,
  isFile: boolean,
): Command | { error: string } {
  if (host.platform === "win32" || host.wsl) {
    const found = windowsPath(host, path);
    if ("error" in found) return found;
    return {
      program: "explorer",
      args: isFile ? [`/select,${found.path}`] : [found.path],
      ignoreExit: true,
    };
  }
  if (WINDOWS_PATH.test(path))
    return { error: `${path} is a Windows path, and this is not Windows.` };
  if (host.platform === "darwin")
    // -R for folders too: a plain `open` would launch a .app or .photoslibrary bundle.
    return { program: "open", args: ["-R", path], ignoreExit: false };
  return { program: "xdg-open", args: [isFile ? posix.dirname(path) : path], ignoreExit: false };
}

/** This process's host, the distro read only where it is needed (from Windows). */
async function thisHost(): Promise<Host> {
  const wsl = onWsl();
  let distro: string | null = process.env["WSL_DISTRO_NAME"] ?? null;
  if (ON_WINDOWS) {
    const found = await readDistro();
    distro = "name" in found ? found.name : null;
  }
  return { platform: process.platform, wsl, distro };
}

/** The file manager's name, for the window's menu and button. */
export function thisFileManager(): string {
  return fileManagerName({ platform: process.platform, wsl: onWsl(), distro: null });
}

/** How long a file manager launcher may run before it counts as opened: xdg-open can stay on. */
const LAUNCH_MS = 3000;

/**
 * Opens `path`, which the scan listed: throws, with the reason, for a path it
 * did not list, one that is gone, one this host cannot reach, or a launcher
 * that failed.
 */
export async function reveal(scan: Scan | null, path: unknown): Promise<void> {
  const allowed = scannedPath(scan, path);
  if ("error" in allowed) throw new Error(allowed.error);
  const host = await thisHost();
  const local = localPath(host, allowed.path);
  if (local === null) throw new Error(`${allowed.path} cannot be reached from here.`);
  let isFile: boolean;
  try {
    isFile = statSync(local).isFile();
  } catch {
    throw new Error(`${allowed.path} is gone.`);
  }
  const command = revealCommand(host, allowed.path, isFile);
  if ("error" in command) throw new Error(command.error);
  const program = command.program === "explorer" ? windowsProgram("explorer.exe") : command.program;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    // No shell: the path is an argument, never a command line.
    child = Bun.spawn([program, ...command.args], {
      ...(host.wsl && WINDOWS_CWD !== undefined ? { cwd: WINDOWS_CWD } : {}),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe", // read only if it exits non-zero within LAUNCH_MS
    });
  } catch (error) {
    throw new Error(
      `${program} could not be started: ${error instanceof Error ? error.message : error}`,
    );
  }
  const code = await Promise.race([child.exited, Bun.sleep(LAUNCH_MS).then(() => null)]);
  if (code === null || command.ignoreExit || code === 0) return;
  const said = (await new Response(child.stderr as ReadableStream).text()).trim();
  throw new Error(`${program} failed (exit ${code})${said === "" ? "" : `: ${said}`}`);
}
