/**
 * One scan: every reader, each on its own, so a machine without Docker or
 * Postgres still gets the rest. What a reader could not do becomes a note.
 */

import { homedir } from "node:os";
import type { Config } from "./config";
import { dockerCandidates, readDocker } from "./docker";
import { driveOf, readDrives } from "./drives";
import { linuxFolders } from "./folders";
import { type DiskImage, imageFindings, readImages } from "./images";
import { databaseFindings, envTexts, readDatabases } from "./postgres";
import { onWsl } from "./run";
import { readScratch, scratchFindings } from "./scratch";
import { readRunning } from "./sessions";
import type { Candidate, Drive, Scan, SessionInfo, Usage } from "./types";
import { defaultRoots, findRepos, readWorktrees, worktreeCandidates } from "./worktrees";

export type ScanInput = {
  sessions: SessionInfo[];
  config: Config;
  /** The Windows folder sizes from the last deep scan, kept because they take minutes. */
  windowsFolders: Usage[];
};

type Found = { usage: Usage[]; candidates: Candidate[] };

async function attempt(name: string, notes: string[], read: () => Promise<Found>): Promise<Found> {
  try {
    return await read();
  } catch (error) {
    notes.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    return { usage: [], candidates: [] };
  }
}

function isDockerData(image: DiskImage): boolean {
  return image.path.toLowerCase().endsWith("docker_data.vhdx");
}

function images(list: DiskImage[], drives: Drive[], dockerBytes: number | null): Found {
  const found: Found = { usage: [], candidates: [] };
  const own = process.env["WSL_DISTRO_NAME"];
  const rootUsed = drives.find((drive) => drive.mount === "/")?.usedBytes ?? null;
  for (const image of list) {
    let inside: number | null = null;
    if (isDockerData(image)) inside = dockerBytes;
    else if (image.distro === own) inside = rootUsed;
    const { usage, candidate } = imageFindings(image, inside, driveOf(image.path, drives));
    found.usage.push(usage);
    if (candidate !== null) found.candidates.push(candidate);
  }
  return found;
}

async function docker(
  drive: string,
  notes: string[],
): Promise<{ found: Found; totalBytes: number | null }> {
  try {
    const df = await readDocker();
    return {
      found: { usage: [], candidates: dockerCandidates(df, drive) },
      totalBytes: df.totalBytes,
    };
  } catch (error) {
    notes.push(`docker: ${error instanceof Error ? error.message : String(error)}`);
    return { found: { usage: [], candidates: [] }, totalBytes: null };
  }
}

export async function scan(input: ScanInput): Promise<Scan> {
  const started = Date.now();
  const notes: string[] = [];
  const wsl = onWsl();
  const drives = await readDrives(wsl);
  const on = (path: string) => driveOf(path, drives);
  const running = await readRunning();
  const roots = input.config.roots ?? defaultRoots();

  const imageList = wsl ? await readImagesNoted(notes) : [];
  const dockerImage = imageList.find(isDockerData);
  const dockerRead = await docker(
    dockerImage === undefined ? on("/") : on(dockerImage.path),
    notes,
  );
  const parts = await Promise.all([
    Promise.resolve(images(imageList, drives, dockerRead.totalBytes)),
    attempt("scratch folders", notes, async () => {
      const found = scratchFindings(await readScratch(input.sessions), running, on("/tmp"));
      return { usage: [found.usage], candidates: found.candidates };
    }),
    attempt("worktrees", notes, async () => {
      const trees = await readWorktrees(await findRepos(roots));
      return {
        usage: [],
        candidates: await worktreeCandidates(trees, input.sessions, running, on),
      };
    }),
    attempt("folders", notes, async () => ({
      usage: await linuxFolders([homedir(), "/tmp"], on(homedir())),
      candidates: [],
    })),
    postgres(input, roots, drives, notes),
  ]);
  // Docker's own bytes live inside its disk image: only the candidates are listed.
  const all = [dockerRead.found, ...parts];
  return {
    at: started,
    took: Date.now() - started,
    drives,
    usage: onePerPath([...all.flatMap((part) => part.usage), ...input.windowsFolders]),
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

async function readImagesNoted(notes: string[]): Promise<DiskImage[]> {
  try {
    return await readImages();
  } catch (error) {
    notes.push(`disk images: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function none(): Promise<Found> {
  return Promise.resolve({ usage: [], candidates: [] });
}

function postgres(
  input: ScanInput,
  roots: string[],
  drives: Drive[],
  notes: string[],
): Promise<Found> {
  const config = input.config.postgres;
  if (config === undefined) return none();
  return attempt("postgres", notes, async () => {
    const { dataDirectory, databases } = await readDatabases(config);
    const repos = await findRepos(roots);
    const trees = await readWorktrees(repos);
    const envs = envTexts([...repos, ...trees.map((tree) => tree.path)]);
    const found = databaseFindings(databases, envs, driveOf(dataDirectory, drives), dataDirectory);
    return { usage: [found.usage], candidates: found.candidates };
  });
}
