// What the right-click menu on a tile of "What takes the space" offers, with
// no DOM: which entries it has and whether each can be used. usagemap.js draws
// it and does what an entry says.

/**
 * Files the scan lists next to folders: its disk images (`what` says so) and
 * the files that are named by their extension, like pagefile.sys.
 */
const FILE_WHAT = /disk image/i;
const FILE_NAME = /\.(vhdx?|vmdk|qcow2|img|iso|sys|bak|zip|7z|bin)$/i;

/** True where the tile is a file, not a folder: only folders can be investigated. */
export function isFile(item) {
  return (
    item.kind === "folder" && (FILE_WHAT.test(item.what ?? "") || FILE_NAME.test(item.path ?? ""))
  );
}

/** A folder tile, or a remainder tile of one (the rest of a folder, or of a drive). */
function folderPath(item) {
  if (item.kind === "folder" && !isFile(item) && typeof item.path === "string") return item.path;
  return null;
}

/** The folder a remainder tile ("other files") is the rest of, or null for any other tile. */
export function parentOf(item) {
  return (item.kind === "rest" || item.kind === "other") && typeof item.parent === "string"
    ? item.parent
    : null;
}

/** The last part of a path, or the path itself where it has none (`C:\`, `/`). */
function baseName(path) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** What the file manager shows for the tile: its file or folder, a remainder's folder; null where nothing. */
export function revealPath(item) {
  if (item.kind === "folder" && typeof item.path === "string") return item.path;
  return parentOf(item);
}

/** The launch key of the tile's investigation (see `scan/investigate.ts`), or null where it has none. */
export function investigateKey(item) {
  const folder = folderPath(item);
  if (folder !== null) return `folder:${folder}`;
  const parent = parentOf(item);
  return parent === null ? null : `rest:${parent}`;
}

const OUTSIDE =
  "Only inside prifly: this page was opened on its own, and there is no session to start";

/** Why the tile has nothing to investigate, for the disabled entry's title. */
function noInvestigation(item) {
  if (isFile(item)) return "Only folders can be investigated";
  if (item.kind === "free") return "Free space is not in a folder: there is nothing to investigate";
  if (item.kind === "unused")
    return "These blocks are inside the disk image, not in a folder: there is nothing to investigate";
  return "Only folders can be investigated";
}

function noReveal(item, manager) {
  if (item.kind === "free") return `Free space is not in a folder: ${manager} has nothing to show`;
  if (item.kind === "unused")
    return `These blocks are inside the disk image, not in a folder: ${manager} has nothing to show`;
  return `${manager} has nothing to show for this`;
}

/**
 * The entries of the tile's menu, in order: `{ id, label, enabled, title }`.
 * `inPrifly` is whether this page is inside prifly's window (it can start a
 * session); `started` whether an investigation of this tile has been.
 */
export function menuEntries(item, { inPrifly, manager, started = false }) {
  const key = investigateKey(item);
  const parent = parentOf(item);
  const investigate = { id: "investigate" };
  if (parent !== null) investigate.label = `Investigate the rest of ${baseName(parent)}`;
  else investigate.label = "Investigate this folder";
  if (key === null) {
    Object.assign(investigate, { enabled: false, title: noInvestigation(item) });
  } else if (!inPrifly) {
    Object.assign(investigate, { enabled: false, title: OUTSIDE });
  } else if (started) {
    Object.assign(investigate, {
      enabled: false,
      label: "Started ↗",
      title: "A session for this runs in its own window",
    });
  } else {
    const what =
      parent === null
        ? "this folder"
        : `what is in ${parent} outside the folders listed on their own`;
    Object.assign(investigate, {
      enabled: true,
      title: `Start a session in its own window that investigates ${what}, and proposes: it deletes nothing without asking`,
    });
  }
  const path = revealPath(item);
  const reveal = { id: "reveal", label: `Show in ${manager}` };
  if (path === null) Object.assign(reveal, { enabled: false, title: noReveal(item, manager) });
  else
    Object.assign(reveal, {
      enabled: true,
      title: isFile(item) ? `Open the folder with the file selected` : `Open ${path} in ${manager}`,
    });
  return [investigate, reveal];
}
