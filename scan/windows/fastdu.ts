/**
 * The Windows drives' folder sizes, from `fastdu.cs` — the directory listings
 * alone, on several threads. On 2026-09-27 it read `C:\Program Files` in 3.3 s
 * where PowerShell's Get-ChildItem took 28.6 s, same bytes to the byte, and
 * all of C: and D: (2.0 M files, 2.3 TB) in 76 s.
 *
 * It is compiled on first use with the C# compiler every Windows has, into
 * `%LOCALAPPDATA%\prifly-disk\`, under a name carrying the source's hash so a
 * changed source builds anew. Run from there, not from a WSL path, which
 * Windows would treat as a network location.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { interopFailed, run } from "../run";
import type { WalkProgress } from "../walk";

const SOURCE = join(import.meta.dir, "fastdu.cs");
const CSC = "/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";
const CMD = "/mnt/c/Windows/System32/cmd.exe";

export type WindowsFolder = { path: string; bytes: number; files: number; depth: number };

async function toolFolder(): Promise<{ linux: string; windows: string }> {
  const local = (await run([CMD, "/d", "/c", "echo %LOCALAPPDATA%"], 30_000, "/mnt/c")).trim();
  const windows = `${local}\\prifly-disk`;
  const linux = (await run(["wslpath", "-u", windows])).trim();
  return { linux, windows };
}

let built: Promise<string> | null = null;

/**
 * The compiled scanner, built when missing or when its source changed — once
 * per process: the Windows walk and the database sizes both ask, at once.
 */
export function fastdu(): Promise<string> {
  if (built === null) {
    built = buildFastdu().catch((error: unknown) => {
      built = null;
      throw error;
    });
  }
  return built;
}

async function buildFastdu(): Promise<string> {
  const hash = createHash("sha256").update(readFileSync(SOURCE)).digest("hex").slice(0, 12);
  const folder = await toolFolder();
  const exe = join(folder.linux, `fastdu-${hash}.exe`);
  if (existsSync(exe)) return exe;
  mkdirSync(folder.linux, { recursive: true });
  copyFileSync(SOURCE, join(folder.linux, `fastdu-${hash}.cs`));
  await run(
    [
      CSC,
      "/nologo",
      "/optimize+",
      `/out:${folder.windows}\\fastdu-${hash}.exe`,
      `${folder.windows}\\fastdu-${hash}.cs`,
    ],
    120_000,
    "/mnt/c",
  );
  return exe;
}

/** "bytes<TAB>files<TAB>path" lines, the depth read from the path's backslashes. */
export function parseFolders(out: string): WindowsFolder[] {
  return out
    .split(/\r?\n/)
    .filter((line) => line.includes("\t"))
    .map((line) => {
      const [bytes = "0", files = "0", path = ""] = line.split("\t");
      return {
        path,
        bytes: Number(bytes),
        files: Number(files),
        depth: path.split("\\").length - 1,
      };
    });
}

/** "progress<TAB>dirs<TAB>files<TAB>bytes" from its standard error. */
export function parseProgress(line: string): WalkProgress | null {
  const [tag, dirs, files, bytes] = line.trim().split("\t");
  if (tag !== "progress") return null;
  return { dirs: Number(dirs), files: Number(files), bytes: Number(bytes) };
}

/**
 * Folders down to `depth` below each drive's root and at least `minBytes`,
 * with the running count as it goes.
 */
export async function windowsFolders(
  drives: string[],
  onProgress: (progress: WalkProgress) => void,
  depth = 2,
  minBytes = 1e9,
): Promise<WindowsFolder[]> {
  if (drives.length === 0) return [];
  const exe = await fastdu();
  const threads = Math.max(4, Math.floor(availableParallelism() / 2));
  const argv = [exe, String(depth), String(minBytes), String(threads), ...drives];
  let done = await runStreaming(argv, onProgress);
  // WSL could not start it at all (`run.ts`): it never ran, so once more.
  if (done.code !== 0 && interopFailed(done.errors)) {
    await Bun.sleep(1000);
    done = await runStreaming(argv, onProgress);
  }
  if (done.code !== 0) {
    throw new Error(`fastdu exited ${done.code}: ${done.errors.trim().split("\n").at(-1) ?? ""}`);
  }
  return parseFolders(done.out);
}

/**
 * One run of a Windows program that prints folders on standard output and
 * `progress` lines on standard error — fastdu, or the PowerShell walk that
 * stands in for it: its output, its exit, and what else it said.
 */
export async function runStreaming(
  argv: string[],
  onProgress: (progress: WalkProgress) => void,
): Promise<{ out: string; code: number; errors: string }> {
  const proc = Bun.spawn(argv, { cwd: "/mnt/c", stdout: "pipe", stderr: "pipe" });
  let errors = "";
  const reading = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const progress = parseProgress(line);
        if (progress === null) errors += `${line}\n`;
        else onProgress(progress);
      }
    }
    errors += pending;
  })();
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited, reading]);
  return { out, code, errors };
}
