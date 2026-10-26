/** Running the programs a scan reads from. */

import { existsSync } from "node:fs";

/** Running on Windows itself, not under WSL: Windows programs start directly, WSL through `wsl.exe`. */
export const ON_WINDOWS = process.platform === "win32";

const SYSTEM_ROOT = process.env["SystemRoot"] ?? "C:\\Windows";

/** A program under `C:\Windows`, as this host reaches it. */
export function windowsProgram(path: string): string {
  return ON_WINDOWS ? `${SYSTEM_ROOT}\\${path.replaceAll("/", "\\")}` : `/mnt/c/Windows/${path}`;
}

export const POWERSHELL = windowsProgram("System32/WindowsPowerShell/v1.0/powershell.exe");

/**
 * The folder a Windows program starts from: under WSL a Windows one, or it
 * warns about UNC paths; on Windows wherever this runs.
 */
export const WINDOWS_CWD = ON_WINDOWS ? undefined : "/mnt/c";

/** Under WSL, with Windows reachable: the disk images and Windows drives can be read. */
export function onWsl(): boolean {
  return !ON_WINDOWS && existsSync(POWERSHELL);
}

export class CommandFailed extends Error {}

/**
 * WSL failing to start a Windows program at all — the interop socket not
 * answering, seen when several start at once on a busy machine (2026-09-27:
 * `UtilAcceptVsock:273: accept4 failed 110` from cmd.exe). The program never
 * ran, so starting it again is safe.
 */
export function interopFailed(message: string): boolean {
  return message.includes("UtilAcceptVsock");
}

/**
 * Tries a Windows program gets while WSL fails to start it. One more was not
 * always enough: the Windows folders' part failed with fastdu and then its
 * PowerShell fallback both refused (2026-09-27), while a scan started several.
 */
const INTEROP_TRIES = 3;

/** `start` again, a second longer each time, while WSL could not start the program. */
export async function interopRetry<T>(
  start: () => Promise<T>,
  failed: (result: T) => string | null,
): Promise<T> {
  let result = await start();
  for (let attempt = 1; attempt < INTEROP_TRIES; attempt++) {
    const why = failed(result);
    if (why === null || !interopFailed(why)) return result;
    await Bun.sleep(1000 * attempt);
    result = await start();
  }
  return result;
}

/** A program's standard output; a non-zero exit or a timeout throws `CommandFailed`. */
export async function run(argv: string[], timeoutMs = 120_000, cwd?: string): Promise<string> {
  const outcome = await interopRetry(
    () =>
      runOnce(argv, timeoutMs, cwd).then(
        (out) => ({ out, error: null as CommandFailed | null }),
        (error: unknown) => {
          if (error instanceof CommandFailed) return { out: "", error };
          throw error;
        },
      ),
    (result) => result.error?.message ?? null,
  );
  if (outcome.error !== null) throw outcome.error;
  return outcome.out;
}

async function runOnce(argv: string[], timeoutMs: number, cwd?: string): Promise<string> {
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
    WINDOWS_CWD,
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
