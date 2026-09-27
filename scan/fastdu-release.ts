/**
 * fastdu (https://github.com/jimmy927/fastdu), the native walker for the
 * Linux or macOS folders and the Windows drives: the release this extension
 * runs, and each binary's checksum, which a download must match before it is
 * kept.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FASTDU_VERSION = "1.1.1";

const SHA256 = {
  "fastdu-linux-x64": "0020e629b72adb8d19ba3f7b69feac5176a8f21c8818d2d705f97094954a338d",
  "fastdu-linux-arm64": "56ab6a6cc10c2d9f379775e8b0db23baf2f2323887b80e86d2014f3f5fd28576",
  "fastdu-macos": "11e5844e93e96823703511c58a8bdbb13d971cfd953de1c1a34039235fe3ed0b",
  "fastdu-windows-x64.exe": "e772d3e8b416f71a5ca40f6801cec6f8503d3a8a860c3891e8417723b97ad660",
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
