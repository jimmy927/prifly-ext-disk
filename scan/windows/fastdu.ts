/**
 * The Windows drives' folder sizes, from the directory listings alone.
 *
 * Two builds of the same walk, the faster first:
 *   - fastdu's native release (`fastdu-release.ts`), downloaded on first use.
 *     All of C: (1.86 M files) in 13.1 s against gdu's 16.2 s under load, and
 *     10.5 s on a quiet machine (2026-09-27).
 *   - `fastdu.cs`, compiled with the C# compiler every Windows has when the
 *     release cannot be had — with the server garbage collector, which took
 *     it from 22 s to 15 s on C: at 16 threads.
 * Both go into `%LOCALAPPDATA%\prifly-disk\`, under names carrying their
 * version or their source's hash, and run from there, not from a WSL path,
 * which Windows would treat as a network location.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { FASTDU_VERSION, fastduBinary } from "../fastdu-release";
import { interopRetry, run } from "../run";
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

/** A walker, and how it takes its arguments: the release's flags, or the C# one's positions. */
type Walker = { exe: string; release: boolean };

let built: Promise<Walker> | null = null;

/**
 * The walker, fetched or built when missing — once per process: the Windows
 * walk and the database sizes both ask, at once.
 */
export function fastdu(): Promise<Walker> {
  if (built === null) {
    built = findFastdu().catch((error: unknown) => {
      built = null;
      throw error;
    });
  }
  return built;
}

async function findFastdu(): Promise<Walker> {
  const folder = await toolFolder();
  try {
    const exe = join(folder.linux, `fastdu-${FASTDU_VERSION}.exe`);
    return { exe: await fastduBinary("fastdu-windows-x64.exe", exe), release: true };
  } catch {
    // Offline, or the download blocked: the C# build does the same walk.
    return { exe: await buildCsharp(folder), release: false };
  }
}

async function buildCsharp(folder: { linux: string; windows: string }): Promise<string> {
  mkdirSync(folder.linux, { recursive: true });
  const hash = createHash("sha256").update(readFileSync(SOURCE)).digest("hex").slice(0, 12);
  const exe = join(folder.linux, `fastdu-${hash}.exe`);
  if (existsSync(exe)) return exe;
  copyFileSync(SOURCE, join(folder.linux, `fastdu-${hash}.cs`));
  // One heap per core: with the shared default, 16 threads allocating file
  // names spent their time waiting on each other (22 s against 15 s on C:).
  writeFileSync(
    join(folder.linux, `fastdu-${hash}.exe.config`),
    '<?xml version="1.0"?>\r\n<configuration><runtime><gcServer enabled="true"/><gcConcurrent enabled="false"/></runtime></configuration>\r\n',
  );
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
  const walker = await fastdu();
  // One per core: they mostly wait on NTFS, and on all of C: 16 took 11.5 s
  // where 8 took 13.0 and 32 took 14.4 (2026-09-27).
  const threads = String(availableParallelism());
  // du's options: -b file lengths in bytes (what Explorer shows), and fastdu's
  // --file-count the file-count column; -t the smallest folder printed.
  const argv = walker.release
    ? [
        walker.exe,
        "-p",
        "-b",
        "--file-count",
        "-d",
        String(depth),
        "-t",
        String(minBytes),
        "-j",
        threads,
        "--",
        ...drives,
      ]
    : [walker.exe, String(depth), String(minBytes), threads, ...drives];
  const done = await runStreaming(argv, onProgress);
  if (walkFailed(done)) {
    throw new Error(`fastdu exited ${done.code}: ${done.errors.trim().split("\n").at(-1) ?? ""}`);
  }
  return parseFolders(done.out);
}

/**
 * Whether a walk gave nothing to use. Like du, fastdu exits 1 when some folder
 * could not be read (on C:, WindowsApps always), and what it printed is still
 * everything else; only another exit, or 1 with nothing printed, is a failure.
 */
export function walkFailed(done: { out: string; code: number }): boolean {
  return done.code !== 0 && !(done.code === 1 && done.out.trim() !== "");
}

/**
 * One run of a program that prints folders on standard output and `progress`
 * lines on standard error — fastdu, or the PowerShell walk that stands in for
 * it: its output, its exit, and what else it said. Started again while WSL
 * could not start it at all (`interopRetry`): it never ran, so no progress was
 * reported for it.
 */
export function runStreaming(
  argv: string[],
  onProgress: (progress: WalkProgress) => void,
  /** A Windows program starts from a Windows folder, or it warns about UNC paths. */
  cwd = "/mnt/c",
): Promise<{ out: string; code: number; errors: string }> {
  return interopRetry(
    () => streamOnce(argv, onProgress, cwd),
    (done) => (done.code === 0 ? null : done.errors),
  );
}

async function streamOnce(
  argv: string[],
  onProgress: (progress: WalkProgress) => void,
  cwd: string,
): Promise<{ out: string; code: number; errors: string }> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
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
