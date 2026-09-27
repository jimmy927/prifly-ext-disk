/**
 * One scan, in named parts that run side by side and report as they go
 * (`progress.ts`). Each part stands on its own, so a machine without Docker,
 * Windows or Postgres still gets the rest; what a part could not do becomes a
 * note. The two walks — this Linux's folders (`walk.ts`) and the Windows
 * drives' (`windows/fastdu.ts`) — are the long ones; the scratch folders and
 * worktrees are looked up in the Linux walk rather than walked again.
 */

import { homedir } from "node:os";
import type { Config } from "./config";
import { dockerCandidates, readDocker } from "./docker";
import { driveOf, readDrives } from "./drives";
import { linuxFolders, windowsUsage } from "./folders";
import { bytes } from "./format";
import { type DiskImage, imageFindings, readImages } from "./images";
import { databaseFindings, envTexts, queryOf, readDatabases } from "./postgres";
import { counted, type Part, Progress } from "./progress";
import { onWsl } from "./run";
import { readScratch, scratchFindings } from "./scratch";
import { type Running, readRunning } from "./sessions";
import type { Candidate, Drive, Scan, SessionInfo, Usage } from "./types";
import { type Sizer, sizerOf, walkFastest } from "./walk";
import { windowsFolders } from "./windows/fastdu";
import { windowsFoldersOrSlow } from "./windows/slowdu";
import { defaultRoots, findRepos, readWorktrees, worktreeCandidates } from "./worktrees";

export type ScanInput = { sessions: SessionInfo[]; config: Config };

export const PARTS = [
  "Drives",
  "Linux folders",
  "Windows folders",
  "Disk images",
  "Docker",
  "Scratch folders",
  "Worktrees",
  "Databases",
] as const;

type Found = { usage: Usage[]; candidates: Candidate[] };
const NOTHING: Found = { usage: [], candidates: [] };

/** What every part can see. */
type Context = {
  input: ScanInput;
  progress: Progress;
  notes: string[];
  drives: Drive[];
  on: (path: string) => string;
  running: Running;
  roots: string[];
  wsl: boolean;
};

function isDockerData(image: DiskImage): boolean {
  return image.path.toLowerCase().endsWith("docker_data.vhdx");
}

/** This Linux's home folder and /tmp, walked once; the sizes serve the parts after it. */
async function linux(ctx: Context): Promise<{ found: Found; size: Sizer }> {
  const roots = [homedir(), "/tmp"];
  const walked = await ctx.progress.run("Linux folders", ctx.notes, async () => {
    const result = await walkFastest(roots, (p) =>
      ctx.progress.update("Linux folders", counted(p.files, bytes(p.bytes))),
    );
    if (result.fellBack !== null) {
      ctx.notes.push(
        `linux folders: fastdu failed (${result.fellBack}); walked in TypeScript instead`,
      );
    }
    const slow = result.fellBack === null ? "" : " · TypeScript, slower";
    return {
      value: result,
      detail: `${counted(result.progress.files, bytes(result.progress.bytes))}${slow}`,
    };
  });
  const sizes = walked?.sizes ?? new Map<string, number>();
  return {
    found: { usage: linuxFolders(sizes, roots, ctx.on), candidates: [] },
    size: sizerOf(sizes),
  };
}

async function windows(ctx: Context): Promise<Found> {
  const letters = ctx.drives.map((drive) => drive.label).filter((label) => /^[A-Z]:$/.test(label));
  if (!ctx.wsl || letters.length === 0) {
    ctx.progress.finish("Windows folders", "skipped", "no Windows drives here");
    return NOTHING;
  }
  const folders = await ctx.progress.run("Windows folders", ctx.notes, async () => {
    let slow = "";
    const { folders: found } = await windowsFoldersOrSlow(
      letters,
      (p) => ctx.progress.update("Windows folders", `${counted(p.files, bytes(p.bytes))}${slow}`),
      (reason) => {
        slow = " · PowerShell, slower";
        ctx.progress.update("Windows folders", `fastdu failed, reading with PowerShell${slow}`);
        ctx.notes.push(`windows folders: fastdu failed (${reason}); read with PowerShell instead`);
      },
    );
    // The drives' own totals: the last progress tick can be up to a second old
    // (it said 1,868,787 files where C: and D: had 2,063,329 on 2026-09-27).
    const drives = found.filter((folder) => folder.depth === 0);
    const files = drives.reduce((sum, folder) => sum + folder.files, 0);
    const total = drives.reduce((sum, folder) => sum + folder.bytes, 0);
    return { value: found, detail: `${counted(files, bytes(total))}${slow}` };
  });
  return { usage: windowsUsage(folders ?? []), candidates: [] };
}

/** The WSL and Docker disk images, then Docker, which is measured against its image. */
async function imagesAndDocker(ctx: Context): Promise<Found> {
  const list =
    (ctx.wsl
      ? await ctx.progress.run("Disk images", ctx.notes, async () => {
          const found = await readImages();
          return { value: found, detail: `${found.length} found` };
        })
      : null) ?? [];
  if (!ctx.wsl) ctx.progress.finish("Disk images", "skipped", "not under WSL");
  const dockerImage = list.find(isDockerData);
  const drive = dockerImage === undefined ? ctx.on("/") : ctx.on(dockerImage.path);
  const df = await ctx.progress.run("Docker", ctx.notes, async () => {
    const read = await readDocker();
    return { value: read, detail: `${bytes(read.totalBytes)} in images, volumes and cache` };
  });
  const found: Found = { usage: [], candidates: df === null ? [] : dockerCandidates(df, drive) };
  const own = process.env["WSL_DISTRO_NAME"];
  const rootUsed = ctx.drives.find((each) => each.mount === "/")?.usedBytes ?? null;
  for (const image of list) {
    let inside: number | null = null;
    if (isDockerData(image)) inside = df?.totalBytes ?? null;
    else if (image.distro === own) inside = rootUsed;
    const { usage, candidate } = imageFindings(image, inside, ctx.on(image.path));
    found.usage.push(usage);
    if (candidate !== null) found.candidates.push(candidate);
  }
  return found;
}

export const LIVENESS_UNKNOWN =
  "which sessions are running cannot be read on this system (no /proc): no scratch folder or worktree is offered for cleaning";

/** The kinds judged by which sessions are running. */
const BY_LIVENESS = new Set<Candidate["kind"]>(["scratch", "worktree"]);

/**
 * Without knowing which sessions run, a running one's scratch folder and
 * worktrees would look safe to remove: they are counted, never offered.
 * Docker's cache, disk images and databases do not depend on it and stay.
 */
export function gateOnLiveness(candidates: Candidate[], known: boolean): Candidate[] {
  return known ? candidates : candidates.filter((candidate) => !BY_LIVENESS.has(candidate.kind));
}

async function scratchAndWorktrees(ctx: Context, size: Sizer): Promise<Found> {
  const known = ctx.running.known;
  if (!known) {
    ctx.notes.push(`liveness: ${LIVENESS_UNKNOWN}`);
    ctx.progress.finish("Worktrees", "skipped", "running sessions cannot be read here");
  }
  const [scratch, trees] = await Promise.all([
    ctx.progress.run("Scratch folders", ctx.notes, async () => {
      const found = scratchFindings(
        await readScratch(ctx.input.sessions, size),
        ctx.running,
        ctx.on("/tmp"),
      );
      const detail = known
        ? `${found.candidates.length} could go`
        : "counted, not offered: running sessions cannot be read here";
      return { value: found, detail };
    }),
    known
      ? ctx.progress.run("Worktrees", ctx.notes, async () => {
          const list = await readWorktrees(await findRepos(ctx.roots));
          const found = await worktreeCandidates(
            list,
            ctx.input.sessions,
            ctx.running,
            ctx.on,
            size,
          );
          return { value: found, detail: `${list.length} found, ${found.length} not in use` };
        })
      : Promise.resolve(null),
  ]);
  return {
    usage: scratch === null ? [] : [scratch.usage],
    candidates: gateOnLiveness([...(scratch?.candidates ?? []), ...(trees ?? [])], known),
  };
}

/** Each folder directly under a Windows folder, by name: `base\<oid>` of a Postgres data folder. */
async function baseFolders(windowsPath: string): Promise<Map<string, number>> {
  const folders = await windowsFolders([windowsPath], () => undefined, 1, 0);
  return new Map(
    folders
      .filter((folder) => folder.path !== windowsPath)
      .map((folder) => [folder.path.split("\\").at(-1) ?? "", folder.bytes]),
  );
}

async function databases(ctx: Context): Promise<Found> {
  const config = ctx.input.config.postgres;
  if (config === undefined) {
    ctx.progress.finish("Databases", "skipped", "no Postgres in config.json");
    return NOTHING;
  }
  const found = await ctx.progress.run("Databases", ctx.notes, async () => {
    const {
      dataDirectory,
      databases: list,
      fellBack,
    } = await readDatabases(queryOf(config), ctx.wsl ? baseFolders : null);
    if (fellBack !== null) {
      ctx.notes.push(
        `databases: reading their folders failed (${fellBack}); asked Postgres instead`,
      );
    }
    const repos = await findRepos(ctx.roots);
    const trees = await readWorktrees(repos);
    const envs = envTexts([...repos, ...trees.map((tree) => tree.path)]);
    const result = databaseFindings(list, envs, driveOf(dataDirectory, ctx.drives), dataDirectory);
    const how = fellBack === null ? "" : " · sized by Postgres, slower";
    return { value: result, detail: `${list.length} databases${how}` };
  });
  return found === null ? NOTHING : { usage: [found.usage], candidates: found.candidates };
}

export async function scan(
  input: ScanInput,
  onProgress: (parts: Part[]) => void = () => undefined,
): Promise<Scan> {
  const started = Date.now();
  const notes: string[] = [];
  const progress = new Progress(PARTS, onProgress);
  const wsl = onWsl();
  progress.start("Drives");
  const drives = await readDrives(wsl);
  progress.finish("Drives", "done", drives.map((drive) => drive.label).join(" · "));
  const ctx: Context = {
    input,
    progress,
    notes,
    drives,
    on: (path) => driveOf(path, drives),
    running: await readRunning(),
    roots: input.config.roots ?? defaultRoots(),
    wsl,
  };
  const parts = await Promise.all([
    linux(ctx).then(async ({ found, size }) => [found, await scratchAndWorktrees(ctx, size)]),
    windows(ctx).then((found) => [found]),
    imagesAndDocker(ctx).then((found) => [found]),
    databases(ctx).then((found) => [found]),
  ]);
  const all = parts.flat();
  return {
    at: started,
    took: Date.now() - started,
    drives,
    usage: onePerPath(all.flatMap((part) => part.usage)),
    candidates: all.flatMap((part) => part.candidates).sort((a, b) => b.bytes - a.bytes),
    notes,
  };
}

/**
 * Biggest first, each path once: `/tmp/claude-1000` is both a folder under
 * /tmp and the scratch folders, and the named reading says more.
 */
export function onePerPath(usage: Usage[]): Usage[] {
  const byPath = new Map<string, Usage>();
  for (const item of usage) {
    const key = item.path.replaceAll("\\", "/").toLowerCase();
    const seen = byPath.get(key);
    if (seen === undefined || seen.what === "folder") byPath.set(key, item);
  }
  return [...byPath.values()].sort((a, b) => b.bytes - a.bytes);
}
