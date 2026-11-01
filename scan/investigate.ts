/**
 * What an investigation session is told: the folder the reader right-clicked
 * in the Disk space window's map, and what the scan already knows about it.
 *
 * A launch key is `folder:<path>` (investigate that folder) or `rest:<path>`
 * (investigate what is in the folder outside the sub-folders the scan lists:
 * a remainder tile's "other files"). The path must be one the latest scan
 * reported — the same test `api/reveal` applies (`scannedPath`) — because the
 * key comes from a request and the session it starts works on that path.
 */

import { bytes } from "./format";
import { driveRoot, scannedPath } from "./reveal";
import type { Candidate, Scan, Usage } from "./types";

export type Target = {
  /** `rest`: the folder's content outside the sub-folders the scan lists. */
  rest: boolean;
  path: string;
  /** What the scan measured for the folder (a drive's root: what the drive uses). */
  bytes: number;
};

/** A path with `/` and lower case, `/mnt/c/…` as `c:/…`, no trailing `/`: paths of one place compare alike. */
function norm(path: string): string {
  const p = path.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
  const mount = /^\/mnt\/([a-z])(?=\/|$)/.exec(p);
  return mount?.[1] === undefined ? p : `${mount[1]}:${p.slice(6)}`;
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The folder a launch key names, or why the scan does not know it. */
export function investigateTarget(scan: Scan | null, key: string): Target | { error: string } {
  const rest = key.startsWith("rest:");
  if (!rest && !key.startsWith("folder:")) return { error: "That is not a folder to investigate." };
  const found = scannedPath(scan, key.slice(key.indexOf(":") + 1));
  if ("error" in found) return found;
  const item = scan?.usage.find((each) => each.path === found.path);
  if (item !== undefined) return { rest, path: item.path, bytes: item.bytes };
  // Not a listed folder, so the top of a drive (scannedPath accepts nothing else).
  const drive = scan?.drives.find((each) => driveRoot(each) === found.path);
  return { rest, path: found.path, bytes: drive?.usedBytes ?? 0 };
}

/** Folders the scan lists inside `root`, not inside another such folder: what the map draws as its tiles. */
function subfolders(scan: Scan, root: string): Usage[] {
  const inside = scan.usage.filter((item) => {
    const p = norm(item.path);
    return p !== root && within(root, p);
  });
  const nested = (item: Usage) =>
    inside.some(
      (other) => norm(other.path) !== norm(item.path) && within(norm(other.path), norm(item.path)),
    );
  return inside.filter((item) => !nested(item)).sort((a, b) => b.bytes - a.bytes);
}

function cleanables(scan: Scan, root: string): Candidate[] {
  return scan.candidates.filter((candidate) => within(root, norm(candidate.path)));
}

/** `C:\Users\x` as `/mnt/c/Users/x`, for the session that runs in WSL; null for any other path. */
function wslForm(path: string): string | null {
  const match = /^([A-Za-z]):[\\/]*(.*)$/.exec(path);
  if (match?.[1] === undefined) return null;
  return `/mnt/${match[1].toLowerCase()}/${(match[2] ?? "").replaceAll("\\", "/")}`.replace(
    /\/$/,
    "",
  );
}

function where(path: string): string {
  const mounted = wslForm(path);
  return mounted === null
    ? `\`${path}\` (a Linux path, inside WSL)`
    : `\`${path}\` (a Windows path; \`${mounted}\` from WSL)`;
}

function line(item: Usage): string {
  const label = item.what === "folder" ? "" : ` — ${item.what}`;
  return `- ${bytes(item.bytes)} \`${item.path}\`${label}`;
}

/** The prompt for a launch key, from the scan it was picked in. */
export function investigatePrompt(scan: Scan | null, key: string): string {
  const target = investigateTarget(scan, key);
  if ("error" in target) throw new Error(target.error);
  if (scan === null) throw new Error("No scan yet: scan first.");
  const root = norm(target.path);
  const subs = subfolders(scan, root);
  const freeable = cleanables(scan, root);
  const scanned = new Date(scan.at).toLocaleString("sv-SE");
  const what = target.rest
    ? `what is in ${where(target.path)} outside the folders the scan lists on their own`
    : where(target.path);
  const lines = [
    `Investigate disk space: in the Disk space window I asked to look into ${what}. The scan (${scanned}) measured ${bytes(target.bytes)} for ${target.rest ? "the whole folder" : "it"}.`,
    "",
  ];
  if (target.rest) {
    const listed = subs.reduce((sum, item) => sum + item.bytes, 0);
    lines.push(
      `That is ${bytes(Math.max(0, target.bytes - listed))} of it that is not in a listed sub-folder: smaller folders, and files directly in it.`,
      ...(subs.length === 0
        ? []
        : [
            "",
            "The scan already lists these sub-folders, which are not part of this:",
            ...subs.map(line),
          ]),
    );
  } else if (subs.length > 0) {
    lines.push("The scan lists these inside it:", ...subs.map(line));
  }
  if (freeable.length > 0)
    lines.push(
      "",
      "The scan's Could be cleaned list has these in it:",
      ...freeable.map(
        (each) => `- ${bytes(each.bytes)} — ${each.title} (${each.safety}): ${each.why}`,
      ),
    );
  lines.push(
    "",
    target.rest
      ? "Find out what takes the space in there that the scan does not list: the biggest folders and files, what they are, how old, and what keeps them."
      : "Find out what is in it and what takes the space: the biggest folders and files, what they are, how old, and what keeps them.",
    "Then say what could go, how much that would free, and what would be lost or stop.",
    "Investigate and propose only. Do not delete, move, shrink or change anything without asking me first with AskUserQuestion; the `disk-cleanup` skill has how to clean once I agree.",
  );
  return lines.join("\n");
}
