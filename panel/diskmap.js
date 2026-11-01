// The "What takes the space" map's model, with no DOM: a drive's folders (the
// scan's `usage`) nested by path into a tree of tiles that never counts a
// byte twice. A folder's tile is as big as the folder; the folders inside it
// are tiles inside it, and what they leave of it is an "other files" tile. At
// the top, next to the biggest folders: what the drive uses outside them, and
// its free space. WSL's own drive is drawn inside its disk image's tile on
// the Windows drive that holds the image. The "Could be cleaned" items are
// attached to the tile that holds them. usagemap.js draws it with treemap.js.

import { bytes } from "./format.js";

/** How many colours the top-level tiles take turns with (`c0`…`c5` in style.css). */
const COLOURS = 6;

/** A remainder below this is not worth a tile. */
const SMALLEST = 1e6;

/**
 * A path with `/` and lower case, `/mnt/c/…` as `c:/…`, so Windows and WSL
 * paths of the same place compare alike.
 */
export function norm(path) {
  const p = path.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
  const mount = /^\/mnt\/([a-z])(?=\/|$)/.exec(p);
  return mount === null ? p : `${mount[1]}:${p.slice(6)}`;
}

/**
 * `items` (each with a `path`) as a forest by path prefix: each `{ item, key,
 * kids }` under the deepest other item whose path contains it. A path listed
 * twice is kept once, the first time.
 */
export function nest(items) {
  const sorted = [...items].sort((a, b) => norm(a.path).length - norm(b.path).length);
  const byKey = new Map();
  const top = [];
  for (const item of sorted) {
    const key = norm(item.path);
    if (byKey.has(key)) continue;
    const node = { item, key, kids: [] };
    byKey.set(key, node);
    let parent;
    let at = key;
    while (parent === undefined) {
      const cut = at.lastIndexOf("/");
      if (cut <= 0) break;
      at = at.slice(0, cut);
      parent = byKey.get(at);
    }
    (parent?.kids ?? top).push(node);
  }
  return top;
}

/** The top of a drive, as the backend (`scan/reveal.ts` `driveRoot`) names it: `C:\` for a Windows drive, else its mount. */
export function driveRoot(drive) {
  return /^[A-Za-z]:$/.test(drive.label) ? `${drive.label}\\` : drive.mount;
}

/** A usage item's name on its tile: what the scan calls it, or its folder's own name. */
export function nameOf(item) {
  if (item.what !== "folder") return item.what;
  return item.path.split(/[\\/]/).filter(Boolean).at(-1) ?? item.path;
}

const bySize = (a, b) => b.value - a.value;
const sum = (list) => list.reduce((total, x) => total + x.value, 0);

/** A folder's tile, its children inside it and, where they leave some of it, "other files". */
function folderTile(n, colour) {
  const children = n.kids.map((kid) => folderTile(kid, colour)).sort(bySize);
  const rest = n.item.bytes - sum(children);
  if (children.length > 0 && rest >= SMALLEST) {
    children.push({
      key: `${n.key}#rest`,
      kind: "rest",
      name: "other files",
      parent: n.item.path,
      value: rest,
      colour: `${colour} rest`,
      why: `In ${n.item.path} but in none of the folders the scan lists on its own: smaller folders, and files.`,
    });
  }
  // A folder whose only content is one listed folder is that folder's tile,
  // named "Users › jimmy": two stacked headers say no more. It answers to
  // both folders' paths (`lead`) and keeps the deeper folder's key and path.
  const [only] = children;
  if (children.length === 1 && only.kind === "folder") {
    const chain = [nameOf(n.item), ...(only.chain ?? [only.name])];
    return {
      ...only,
      name: chain.join(" › "),
      chain,
      lead: [n.key, ...(only.lead ?? [])],
    };
  }
  const tile = {
    key: n.key,
    kind: "folder",
    name: nameOf(n.item),
    path: n.item.path,
    what: n.item.what,
    value: n.item.bytes,
    colour,
    why: n.item.path,
  };
  if (children.length > 0) tile.children = children;
  return tile;
}

/** What a candidate does, as "could be freed by …" ends. */
export function verb(candidate) {
  switch (candidate.kind) {
    case "disk-image":
      return candidate.title.startsWith("Trim") ? "trimming" : "compacting";
    case "docker-cache":
      return "pruning Docker's build cache";
    case "docker-images":
      return "removing unused Docker images";
    case "scratch":
      return "clearing scratch folders";
    case "worktree":
      return "removing worktrees";
    case "database":
      return "dropping databases";
    default:
      return "cleaning up";
  }
}

const DOCKER_DATA = /^docker desktop data disk image/i;

/** Every tile under `tile`, itself first. */
function* tiles(tile) {
  yield tile;
  for (const child of tile.children ?? []) yield* tiles(child);
}

/**
 * The deepest folder tile holding `target` (a normalised path), counting the
 * folders collapsed into it (`lead`); `exact` where the path is that folder
 * itself, not something inside it, so it spans the whole tile. No `best`
 * where no folder holds it.
 */
function holding(root, target) {
  let best;
  let bestLength = -1;
  for (const tile of tiles(root)) {
    if (tile.kind !== "folder") continue;
    for (const key of [tile.key, ...(tile.lead ?? [])]) {
      const inside = target === key || target.startsWith(`${key}/`);
      if (inside && key.length > bestLength) {
        best = tile;
        bestLength = key.length;
      }
    }
  }
  return { best, exact: bestLength === target.length };
}

/**
 * The tile a candidate's bytes come out of: the deepest folder holding its
 * path anywhere in the tree (a database's "dir (name)" by its dir), and for
 * Docker's own cleanups, which name a command rather than a path, the Docker
 * data disk image. A disk image's trim is on the image's "unused in the image"
 * tile where it has one. Null where the map has no such tile.
 */
export function homeOf(root, candidate) {
  if (candidate.kind === "docker-cache" || candidate.kind === "docker-images") {
    for (const tile of tiles(root)) if (DOCKER_DATA.test(tile.what ?? "")) return tile;
    return null;
  }
  const target = norm(candidate.path.replace(/ \([^)]*\)$/, ""));
  const { best, exact } = holding(root, target);
  if (best === undefined) return null;
  // A trim frees the image's unused blocks: the tile that shows them.
  if (candidate.kind === "disk-image")
    return best.children?.find((c) => c.kind === "unused") ?? best;
  // A path inside a group but in none of its listed folders: its bytes are in the group's "other files".
  if (exact) return best;
  return best.children?.find((c) => c.kind === "rest") ?? best;
}

/** Each candidate on its tile, as `tile.clean`: the items, and what they free, never more than the tile. */
function attach(root, candidates) {
  for (const candidate of candidates) {
    const tile = homeOf(root, candidate);
    if (tile === null) continue;
    tile.clean ??= { bytes: 0, items: [] };
    tile.clean.items.push({
      id: candidate.id,
      title: candidate.title,
      bytes: candidate.bytes,
      verb: verb(candidate),
    });
    tile.clean.bytes = Math.min(tile.value, tile.clean.bytes + candidate.bytes);
  }
}

/** "87 GB could be freed by trimming": the tile's own line, or null where nothing on it could be. */
export function cleanNote(tile) {
  if (!tile.clean) return null;
  const verbs = [...new Set(tile.clean.items.map((item) => item.verb))];
  return `${bytes(tile.clean.bytes)} could be freed by ${verbs.join(" and ")}`;
}

/** What could be freed in `tile` and every tile inside it. */
export function cleanWithin(tile) {
  let total = 0;
  for (const each of tiles(tile)) total += each.clean?.bytes ?? 0;
  return Math.min(total, tile.value);
}

const WSL = "WSL";
const WSL_IMAGE = /^wsl disk image/i;

/**
 * Where WSL's drive is drawn: the first WSL disk image the scan lists on
 * another drive, with the WSL drive. The scan names one WSL drive and no
 * distro on it, so with several images it goes into the first. Null where
 * there is no image, no WSL drive, or the image holds less than WSL uses.
 */
function linuxHome(scan) {
  const linux = scan.drives.find((drive) => drive.label === WSL);
  const image = scan.usage.find((item) => item.drive !== WSL && WSL_IMAGE.test(item.what));
  if (linux === undefined || image === undefined || linux.usedBytes > image.bytes) return null;
  return { linux, image };
}

/** The drives that get a tab: all but WSL's, which is inside its disk image where it has one. */
export function tabsOf(scan) {
  const home = linuxHome(scan);
  return scan.drives.map((drive) => drive.label).filter((label) => home === null || label !== WSL);
}

/**
 * WSL's drive inside its disk image's tile: Linux's folders in a colour of
 * their own, what Linux uses outside them, and the image's blocks Linux no
 * longer uses, which a trim gives back. They add up to the image's tile.
 */
function graftLinux(root, scan, label) {
  const home = linuxHome(scan);
  if (home === null || home.image.drive !== label) return;
  const tile = [...tiles(root)].find((each) => each.key === norm(home.image.path));
  if (tile === undefined) return;
  const folders = nest(scan.usage.filter((item) => item.drive === WSL))
    .map((n) => folderTile(n, "c5"))
    .sort(bySize);
  const children = [...folders];
  const other = home.linux.usedBytes - sum(folders);
  if (other >= SMALLEST)
    children.push({
      key: `${tile.key}#linux-other`,
      kind: "rest",
      name: "other Linux files",
      parent: driveRoot(home.linux),
      value: other,
      colour: "c5 rest",
      why: "Used inside WSL but in none of the folders the scan lists on its own: smaller folders, and files.",
    });
  const unused = tile.value - home.linux.usedBytes;
  if (unused >= SMALLEST)
    children.push({
      key: `${tile.key}#unused`,
      kind: "unused",
      name: "unused in the image",
      value: unused,
      colour: "k-free",
      why: "Blocks the image still takes on the drive that Linux has freed: a trim gives them back.",
    });
  if (children.length > 0) tile.children = children;
}

/**
 * The map of drive `label` in `scan`: a root tile (key "#root") whose
 * children are the drive's outermost folders, biggest first, each in a
 * colour of its own that its children keep; what the drive uses outside them
 * ("#other"); and its free space ("#free"). The drive's WSL disk image holds
 * WSL's folders (`graftLinux`). Null where the scan has no such drive or
 * measured no folder on it.
 */
export function driveTree(scan, label) {
  const drive = scan.drives.find((each) => each.label === label);
  const usage = scan.usage.filter((item) => item.drive === label);
  if (drive === undefined || usage.length === 0) return null;
  const folders = nest(usage)
    .sort((a, b) => b.item.bytes - a.item.bytes)
    .map((n, i) => folderTile(n, `c${i % COLOURS}`));
  const children = [...folders];
  const other = drive.usedBytes - sum(folders);
  if (other >= SMALLEST) {
    children.push({
      key: "#other",
      kind: "other",
      name: "Other files",
      parent: driveRoot(drive),
      value: other,
      colour: "k-other",
      why: `Used on ${label} but in none of the folders the scan lists on its own: folders under 1 GB, and files.`,
    });
  }
  if (drive.freeBytes > 0) {
    children.push({
      key: "#free",
      kind: "free",
      name: "Free space",
      value: drive.freeBytes,
      colour: "k-free",
      why: `What is left on ${label}.`,
    });
  }
  const root = {
    key: "#root",
    kind: "drive",
    name: label,
    value: sum(children),
    colour: "",
    why: `${bytes(drive.usedBytes)} used and ${bytes(drive.freeBytes)} free of ${bytes(drive.sizeBytes)}.`,
    children,
  };
  graftLinux(root, scan, label);
  // Every candidate, each on the deepest tile holding its path: WSL's too, on the Linux tiles.
  attach(root, scan.candidates);
  return root;
}

function tilesTo(root, key) {
  if (root.key === key) return [root];
  for (const child of root.children ?? []) {
    const below = tilesTo(child, key);
    if (below.at(-1)?.key === key) return [root, ...below];
  }
  return [root];
}

/**
 * The steps from `root` down to the tile of `key`, both ends included: the
 * breadcrumb. A collapsed chain ("Users › jimmy") is a step per folder, each
 * leading to that one tile. Just the root where there is none.
 */
export function trail(root, key) {
  return tilesTo(root, key).flatMap((tile) =>
    tile.chain === undefined ? [tile] : tile.chain.map((name) => ({ ...tile, name })),
  );
}
