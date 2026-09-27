/**
 * fastdu (https://github.com/jimmy927/fastdu), the native walker for the
 * Linux or macOS folders and the Windows drives: the release this extension
 * runs, and each binary's checksum, which a download must match before it is
 * kept.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FASTDU_VERSION = "1.1.0";

const SHA256 = {
  "fastdu-linux-x64": "688b478752a9121fb1dd9218d62c8fcf0187b60e1671664e3541ce8fba196602",
  "fastdu-linux-arm64": "ea7f036cc3a659bfb2f343aaae9a59c40b5d7260f48bb6cd3ef7c992605faaba",
  "fastdu-macos": "f5f7c97e83f3018c5a62006f8689630b33ef7e47e59f3bf4c61c98cec2096b31",
  "fastdu-windows-x64.exe": "a8a9be5bbad45583fb41e044cd48655ac1cf0289fc2ead7be9617a089cc8e96d",
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
