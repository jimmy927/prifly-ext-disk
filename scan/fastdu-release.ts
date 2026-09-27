/**
 * fastdu (https://github.com/jimmy927/fastdu), the native walker for the
 * Linux folders and the Windows drives: the release this extension runs, and
 * each binary's checksum, which a download must match before it is kept.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FASTDU_VERSION = "1.0.0";

const SHA256 = {
  "fastdu-linux-x64": "702e5bf328af606f08a2cc5b997b0755879e69da9710425aa891e762c11a792d",
  "fastdu-linux-arm64": "7f1516c49be17f107b357c3fa7d8d9ef4b5ad4b873f85d5a9c10425f7abb28d6",
  "fastdu-windows-x64.exe": "06bf51955c7eb3b0f4fb4376f194fee4422af61c2f9ed63db98f196add902e96",
} as const;

export type FastduAsset = keyof typeof SHA256;

/** This machine's Linux build, or null when there is none for its system or processor. */
export function linuxAsset(
  arch: string = process.arch,
  platform: string = process.platform,
): FastduAsset | null {
  if (platform !== "linux") return null;
  if (arch === "x64") return "fastdu-linux-x64";
  if (arch === "arm64") return "fastdu-linux-arm64";
  return null;
}

/**
 * The release's `asset` at `path`, downloaded when it is not there yet. Throws
 * when it cannot be had or its checksum is not the one pinned here.
 */
export async function fastduBinary(asset: FastduAsset, path: string): Promise<string> {
  if (existsSync(path)) return path;
  const url = `https://github.com/jimmy927/fastdu/releases/download/v${FASTDU_VERSION}/${asset}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`downloading ${asset}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const sum = createHash("sha256").update(body).digest("hex");
  if (sum !== SHA256[asset]) throw new Error(`${asset} has checksum ${sum}, not ${SHA256[asset]}`);
  mkdirSync(dirname(path), { recursive: true });
  // Written aside and renamed, so a scan never runs half a binary.
  const partial = `${path}.${process.pid}`;
  writeFileSync(partial, body);
  chmodSync(partial, 0o755);
  renameSync(partial, path);
  return path;
}
