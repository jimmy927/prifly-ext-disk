/**
 * fastdu (https://github.com/jimmy927/fastdu), the native walker for the
 * Linux or macOS folders and the Windows drives: the release this extension
 * runs, and each binary's checksum, which a download must match before it is
 * kept.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FASTDU_VERSION = "3.0.1";

const SHA256 = {
  "fastdu-linux-x64": "481f2115799b640a0ecd3182bd049497e30980cdeeba08ccbb22319e2cd06f2e",
  "fastdu-linux-arm64": "df8c84f7975e9bb86d843ef35cfe6a81bb4a705e9a50b8b0726a2c467bd6c2b2",
  "fastdu-macos": "91ba81995aa333b7e64c0e43985adc825456e85da8940ddf097061fe176a72be",
  "fastdu-windows-x64.exe": "bfd6bc27d0f68524c6f93d8a74c085a85e48fe7e63a1bde9d70229d417365c18",
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
