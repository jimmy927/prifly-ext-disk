/** What Docker holds, and what of it nothing uses. */

import { parseSize, run } from "./run";
import type { Candidate } from "./types";

export type DockerDf = {
  /** Everything Docker keeps: images, containers, volumes, build cache. */
  totalBytes: number;
  imagesReclaimable: number;
  buildCacheReclaimable: number;
  danglingImageBytes: number;
};

type DfRow = { Type: string; Size: string; Reclaimable: string };

/** `docker system df --format '{{json .}}'`, one JSON object per line. */
export function parseSystemDf(out: string): Omit<DockerDf, "danglingImageBytes"> {
  let totalBytes = 0;
  let imagesReclaimable = 0;
  let buildCacheReclaimable = 0;
  for (const line of out.trim().split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as DfRow;
    totalBytes += parseSize(row.Size);
    if (row.Type === "Images") imagesReclaimable = parseSize(row.Reclaimable);
    if (row.Type === "Build Cache") buildCacheReclaimable = parseSize(row.Reclaimable);
  }
  return { totalBytes, imagesReclaimable, buildCacheReclaimable };
}

export async function readDocker(): Promise<DockerDf> {
  const df = parseSystemDf(await run(["docker", "system", "df", "--format", "{{json .}}"], 60_000));
  const dangling = await run(
    ["docker", "images", "--filter", "dangling=true", "--format", "{{.Size}}"],
    60_000,
  );
  const danglingImageBytes = dangling
    .split("\n")
    .filter((line) => line.trim() !== "")
    .reduce((sum, line) => sum + parseSize(line), 0);
  return { ...df, danglingImageBytes };
}

/** Dangling images and build cache go without a question; unused images are asked about. */
export function dockerCandidates(df: DockerDf, drive: string): Candidate[] {
  const out: Candidate[] = [];
  const quick = df.danglingImageBytes + df.buildCacheReclaimable;
  if (quick > 100e6) {
    out.push({
      id: "docker-cache:dangling",
      kind: "docker-cache",
      title: "Docker dangling images and build cache",
      path: "docker image prune; docker builder prune",
      bytes: quick,
      drive,
      safety: "safe",
      why: "untagged image layers and build cache; rebuilt when needed",
      blockers: [],
    });
  }
  const unused = df.imagesReclaimable - df.danglingImageBytes;
  if (unused > 1e9) {
    out.push({
      id: "docker-images:unused",
      kind: "docker-images",
      title: "Docker images no container uses",
      path: "docker image prune -a",
      bytes: unused,
      drive,
      safety: "check",
      why: "tagged images with no container; a stack that is down right now counts as unused",
      blockers: ["list them first: an image for a stack that is only stopped is pulled again"],
    });
  }
  return out;
}
