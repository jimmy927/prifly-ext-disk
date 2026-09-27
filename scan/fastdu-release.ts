/**
 * fastdu (https://github.com/jimmy927/fastdu), the native walker for the
 * Linux or macOS folders and the Windows drives: the release this extension
 * runs, and each binary's checksum, which a download must match before it is
 * kept.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FASTDU_VERSION = "3.0.0";

const SHA256 = {
  "fastdu-linux-x64": "40a2d0020093adc63c2fb0cd57ca3b0c89cc652c27f1527df2b87085ff1fec6c",
  "fastdu-linux-arm64": "5821b00a8219b67dd59f869af879dcac00b0c1712eba6e925ded7c80994886ba",
  "fastdu-macos": "ce4d0c7e36b5b709e7b50322f1dda23c4fcabe99745bbe19649f3b00d7b16972",
  "fastdu-windows-x64.exe": "6b23afa81f0037bc2cc0467ec40c821a28b32db0d18555b5dd2918157db121a3",
} as const;

export type FastduAsset = keyof typeof SHA256;

/**
 * The build for this machine's own folders — Linux, or macOS (one file for
 * Intel and Apple Silicon) — or null when there is none for its system or
 * processor.
 */
export function unixAsset(
  arch: string = process.arch,
  platform: string = process.platform,
): FastduAsset | null {
  if (platform === "darwin") return "fastdu-macos";
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
