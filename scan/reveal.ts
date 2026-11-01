/**
 * "Show in Explorer": a tile's folder (or file, selected in its folder) opened
 * in the system's file manager. What to start is decided by pure functions —
 * `revealCommand` per platform and kind of path — and `reveal` is the only
 * part that stats and spawns, through `RevealDeps` a test replaces, so a test
 * never opens a window.
 *
 * Only a path the latest scan reported is opened (`scannedPath`): the window
 * sends a path, and a path from a request is not to be trusted with a
 * program start.
 *
 * On Windows nothing here waits on `wsl.exe` for a Windows path: the distro
 * is needed only for a Linux path, and is then taken from the scan (its WSL
 * disk image's label) before `wsl.exe` is asked, briefly. WSL's interop
 * hangs at times (`UtilAcceptVsock: accept4 failed 110`), and a click must
 * not sit on "Opening…" for it.
 */

import { stat } from "node:fs/promises";
import { posix } from "node:path";
import { onWsl, WINDOWS_CWD, windowsProgram } from "./run";
import type { Drive, Scan } from "./types";
import { readDistro } from "./wsl";

/** Where this runs, as far as opening a folder cares. */
export type Host = {
  platform: NodeJS.Platform;
  /** Linux under Windows' WSL, with Windows reachable. */
  wsl: boolean;
  /** The WSL distro whose files are `/…` paths: this one under WSL, the scanned one from Windows. */
  distro: string | null;
};

export type Command = {
  program: "explorer" | "open" | "xdg-open";
  args: string[];
  /** Explorer answers 1 even when it worked, so its exit code says nothing. */
  ignoreExit: boolean;
  /**
   * The args are already quoted the way Explorer parses its own command line
   * (`/select,"C:\Program Files\x"`), to be passed as they are
   * (`windowsVerbatimArguments`): Bun would otherwise quote a whole argument
   * that holds a space, and Explorer reads `"/select,C:\Program Files\x"` as
   * no switch at all and opens Documents. Only when this runs on Windows.
   */
  verbatim: boolean;
};

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/** What the reader's file manager is called here: Explorer, Finder, or Files. */
export function fileManagerName(host: Host): string {
  if (host.platform === "win32" || host.wsl) return "Explorer";
  return host.platform === "darwin" ? "Finder" : "Files";
}

/**
 * The top of a drive as the window's remainder tiles name it: `C:\` for a
 * Windows drive, the mount (`/` for WSL) for any other.
 */
export function driveRoot(drive: Drive): string {
  return /^[A-Za-z]:$/.test(drive.label) ? `${drive.label}\\` : drive.mount;
}

/** `path` if the scan listed it as something taking space, or as the top of a drive, else why not. */
export function scannedPath(
  scan: Scan | null,
  path: unknown,
): { path: string } | { error: string } {
  if (typeof path !== "string" || path === "") return { error: "No path was given." };
  if (scan === null) return { error: "There is no scan yet, so there is nothing to open." };
  const listed =
    scan.usage.some((item) => item.path === path) ||
    scan.drives.some((drive) => driveRoot(drive) === path);
  if (!listed) return { error: "That path is not in the last scan, so it is not opened." };
  return { path };
}

/** A Linux path (`/home/…`, `/`), as the WSL drive's tiles name theirs. */
function isLinuxPath(path: string): boolean {
  return path.startsWith("/");
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
 * `\\wsl.localhost\<distro>\…` (current Windows' name for the older `\\wsl$`).
 */
export function windowsPath(host: Host, path: string): { path: string } | { error: string } {
  if (WINDOWS_PATH.test(path)) return { path: path.replaceAll("/", "\\") };
  if (!isLinuxPath(path)) return { error: `${path} is not an absolute path.` };
  const mounted = host.wsl ? mountToWindows(path) : null;
  if (mounted !== null) return { path: mounted };
  if (host.distro === null || host.distro === "")
    return {
      error: "The WSL distro that holds this folder is not known, so Explorer cannot reach it.",
    };
  return { path: `\\\\wsl.localhost\\${host.distro}${path.replaceAll("/", "\\")}` };
}

/**
 * The path as this host's own file system names it, to look at: a Windows
 * path under WSL is `/mnt/<drive>/…`, a Linux path from Windows is the
 * `\\wsl.localhost\…` one. Null where this host cannot reach it.
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

/**
 * A path as one of Explorer's own arguments: in double quotes when it holds
 * a space, or a comma or semicolon, which Explorer reads as separators.
 * Never otherwise, so `C:\` keeps its closing backslash unquoted.
 */
export function explorerQuote(path: string): string {
  return /[\s,;]/.test(path) ? `"${path}"` : path;
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
    // From WSL, wsl.exe builds the command line itself, and quotes as it does.
    const verbatim = host.platform === "win32";
    const target = verbatim ? explorerQuote(found.path) : found.path;
    return {
      program: "explorer",
      args: isFile ? [`/select,${target}`] : [target],
      ignoreExit: true,
      verbatim,
    };
  }
  if (WINDOWS_PATH.test(path))
    return { error: `${path} is a Windows path, and this is not Windows.` };
  if (host.platform === "darwin")
    // -R for folders too: a plain `open` would launch a .app or .photoslibrary bundle.
    return { program: "open", args: ["-R", path], ignoreExit: false, verbatim: false };
  return {
    program: "xdg-open",
    args: [isFile ? posix.dirname(path) : path],
    ignoreExit: false,
    verbatim: false,
  };
}

/**
 * The command line a Windows program receives for `argv` started with
 * `windowsVerbatimArguments`: the pieces joined by spaces, nothing quoted.
 * The program is `%SystemRoot%\explorer.exe`, which holds no space.
 */
export function windowsCommandLine(argv: string[]): string {
  return argv.join(" ");
}

/**
 * The WSL distro the scan read, from its disk image's label ("WSL disk image
 * (Ubuntu-20.04)"); null when the scan lists none, or several.
 */
export function distroFromScan(scan: Scan | null): string | null {
  const names = new Set<string>();
  for (const item of scan?.usage ?? []) {
    const match = /^WSL disk image \((.+)\)$/.exec(item.what);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names.size === 1 ? ([...names][0] ?? null) : null;
}

export type DistroLookup = () => Promise<{ name: string } | { why: string }>;

/** Where this runs, before any distro is looked up. */
export type Here = { platform: NodeJS.Platform; wsl: boolean; envDistro: string | null };

/**
 * The host to open `path` from. The distro is looked up only on Windows and
 * only for a Linux path: from the scan, else `lookup` (`wsl.exe`). Under WSL
 * it is this distro's own.
 */
export async function hostFor(
  here: Here,
  scan: Scan | null,
  path: string,
  lookup: DistroLookup,
): Promise<Host | { error: string }> {
  const host: Host = { platform: here.platform, wsl: here.wsl, distro: here.envDistro };
  if (here.platform !== "win32") return host;
  if (!isLinuxPath(path)) return { ...host, distro: null };
  const scanned = distroFromScan(scan);
  if (scanned !== null) return { ...host, distro: scanned };
  const found = await lookup();
  if ("name" in found) return { ...host, distro: found.name };
  return {
    error: `The WSL distro that holds ${path} is not known (${found.why}), so Explorer cannot reach it.`,
  };
}

/** How long `wsl.exe -l -v` may take before a click gives up on it. */
const DISTRO_MS = 5000;

/** `readDistro`, given up on after `DISTRO_MS`: a hanging wsl.exe answers in 30 s or more. */
function quickDistro(): ReturnType<DistroLookup> {
  return Promise.race([
    readDistro(),
    Bun.sleep(DISTRO_MS).then(() => ({
      why: `wsl.exe did not answer within ${DISTRO_MS / 1000} s`,
    })),
  ]);
}

/** The file manager's name, for the window's menu and button. */
export function thisFileManager(): string {
  return fileManagerName({ platform: process.platform, wsl: onWsl(), distro: null });
}

/**
 * How long a path may take to stat: `\\wsl.localhost\…` goes through WSL's
 * file share, which hangs while WSL's interop does.
 */
const STAT_MS = 2000;

/** How long a file manager launcher may run before it counts as opened: xdg-open can stay on. */
const LAUNCH_MS = 3000;

type Spawned = { exited: Promise<number>; stderr: unknown };

/** What `reveal` looks at and starts; a test replaces them. */
export type RevealDeps = {
  here: Here;
  lookup: DistroLookup;
  /** Whether `path` is a file, a folder, or gone (null). */
  kind: (path: string) => Promise<"file" | "folder" | null>;
  spawn: (
    argv: string[],
    options: { verbatim: boolean; cwd: string | undefined; detached: boolean },
  ) => Spawned;
};

async function statKind(path: string): Promise<"file" | "folder" | null> {
  try {
    return (await stat(path)).isFile() ? "file" : "folder";
  } catch {
    return null;
  }
}

function spawnProgram(
  argv: string[],
  options: { verbatim: boolean; cwd: string | undefined; detached: boolean },
): Spawned {
  // No shell: the path is an argument, never a command line. Never
  // `windowsHide` here: Explorer would honour it and open a hidden window.
  return Bun.spawn(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    windowsVerbatimArguments: options.verbatim,
    stdin: "ignore",
    stdout: "ignore",
    // A launcher's error is read only if it exits non-zero within LAUNCH_MS.
    stderr: options.detached ? "ignore" : "pipe",
  });
}

function defaultDeps(): RevealDeps {
  return {
    here: {
      platform: process.platform,
      wsl: onWsl(),
      envDistro: process.env["WSL_DISTRO_NAME"] ?? null,
    },
    lookup: quickDistro,
    kind: statKind,
    spawn: spawnProgram,
  };
}

/** A file, a folder, or gone (null); a path that takes over `STAT_MS` throws, with why. */
async function kindWithin(deps: RevealDeps, local: string): Promise<"file" | "folder" | null> {
  const kind = await Promise.race([
    deps.kind(local),
    Bun.sleep(STAT_MS).then(() => "slow" as const),
  ]);
  if (kind !== "slow") return kind;
  throw new Error(
    `${local} did not answer within ${STAT_MS / 1000} s` +
      (local.startsWith("\\\\wsl") ? ": WSL's file share is stopped or slow." : "."),
  );
}

/**
 * Opens `path`, which the scan listed: throws, with the reason, for a path it
 * did not list, one that is gone, one this host cannot reach, or a launcher
 * that failed.
 */
export async function reveal(
  scan: Scan | null,
  path: unknown,
  deps: RevealDeps = defaultDeps(),
): Promise<void> {
  const allowed = scannedPath(scan, path);
  if ("error" in allowed) throw new Error(allowed.error);
  const host = await hostFor(deps.here, scan, allowed.path, deps.lookup);
  if ("error" in host) throw new Error(host.error);
  const local = localPath(host, allowed.path);
  if (local === null) throw new Error(`${allowed.path} cannot be reached from here.`);
  const kind = await kindWithin(deps, local);
  if (kind === null) throw new Error(`${allowed.path} is gone.`);
  const command = revealCommand(host, allowed.path, kind === "file");
  if ("error" in command) throw new Error(command.error);
  const program = command.program === "explorer" ? windowsProgram("explorer.exe") : command.program;
  let child: Spawned;
  try {
    child = deps.spawn([program, ...command.args], {
      verbatim: command.verbatim,
      cwd: host.wsl ? WINDOWS_CWD : undefined,
      detached: command.ignoreExit,
    });
  } catch (error) {
    throw new Error(
      `${program} could not be started: ${error instanceof Error ? error.message : error}`,
    );
  }
  // Explorer's exit code says nothing, so there is nothing to wait for: it
  // started, and the window opens. It hands the path to the running Explorer and exits.
  if (command.ignoreExit) {
    child.exited.catch(() => undefined);
    return;
  }
  const code = await Promise.race([child.exited, Bun.sleep(LAUNCH_MS).then(() => null)]);
  if (code === null || code === 0) return;
  const said = (await new Response(child.stderr as ReadableStream).text()).trim();
  throw new Error(`${program} failed (exit ${code})${said === "" ? "" : `: ${said}`}`);
}
