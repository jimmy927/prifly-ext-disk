// "What takes the space": a drive's folders as a treemap (diskmap.js's model,
// drawn by treemap.js), one drive at a time by its tab. A click on a folder
// that holds others zooms into it, the breadcrumb above leads back up, and a
// click on any other tile says what it is in the detail. Tiles that hold
// something "Could be cleaned" lists are striped as far as it frees.

import { cleanNote, cleanWithin, driveTree, trail } from "./diskmap.js";
import { bytes, el } from "./format.js";
import { detail, find, layoutIn, treemap } from "./treemap.js";

const $ = (id) => document.getElementById(id);

/** The drive shown, the tile zoomed into on each drive, the tile picked: kept across redraws. */
let tab = null;
const zoom = new Map();
let picked = null;
let shown = null;

function drawTabs(scan) {
  const labels = scan.drives.map((drive) => drive.label);
  if (tab === null || !labels.includes(tab)) tab = labels[0] ?? null;
  $("tabs").replaceChildren(
    ...labels.map((name) => {
      const button = el(
        "button",
        { class: "tab", role: "tab", "aria-selected": String(name === tab) },
        name,
      );
      button.addEventListener("click", () => {
        tab = name;
        picked = null;
        drawUsage(scan);
      });
      return button;
    }),
  );
}

function title(item) {
  const where = item.path === undefined ? "" : `\n${item.path}`;
  const note = cleanNote(item);
  return `${item.name}: ${bytes(item.value)}${where}${note === null ? "" : `\n${note}`}`;
}

/** The part of a tile that could be freed, striped from its foot up. */
function striped(item, node) {
  if (!item.clean) return;
  node.classList.add("has-clean");
  node.append(
    el("div", {
      class: "cleanable",
      style: `height:${Math.max(4, (100 * item.clean.bytes) / item.value)}%`,
    }),
  );
}

/** Under the picked tile's size: what in it could be freed. */
function lines(item) {
  const out = [];
  for (const each of item.clean?.items ?? [])
    out.push(el("p", { class: "freed" }, `${each.title}: ${bytes(each.bytes)} could be freed`));
  const within = cleanWithin(item);
  if (item.children && within > 0)
    out.push(el("p", { class: "freed" }, `${bytes(within)} could be freed in here`));
  return out;
}

function childTable(children) {
  return el(
    "table",
    {},
    ...children.map((c) =>
      el("tr", {}, el("td", {}, c.name), el("td", { class: "size" }, bytes(c.value))),
    ),
  );
}

function crumbs(path, scan) {
  return el(
    "nav",
    { class: "crumbs", "aria-label": "Where in the drive" },
    ...path.flatMap((tile, i) => {
      const last = i === path.length - 1;
      const name = i === 0 ? `${tile.name} drive` : tile.name;
      if (last) return [el("span", { "aria-current": "location" }, name)];
      const button = el("button", { type: "button", class: "crumb" }, name);
      button.addEventListener("click", () => {
        zoom.set(tab, tile.key);
        picked = null;
        drawUsage(scan);
      });
      return [button, el("span", { class: "sep" }, "›")];
    }),
  );
}

function message(text) {
  $("usage").replaceChildren(el("p", { class: "hint" }, text));
}

function drawMap(scan) {
  const root = driveTree(scan, tab);
  if (root === null) {
    const drive = scan.drives.find((each) => each.label === tab);
    message(
      drive === undefined
        ? "The scan found no drive to map."
        : `The scan measured no folder on ${tab} — ${bytes(drive.usedBytes)} used, ${bytes(drive.freeBytes)} free; the drive's bar above is all there is.`,
    );
    return;
  }
  // A folder zoomed into before a rescan may be gone, or hold no folder now.
  const zoomed = find([root], zoom.get(tab) ?? "#root");
  const at = zoomed?.children ? zoomed : root;
  const items = at.children;
  const pickedTile = picked === null ? null : find(items, picked);
  const { narrow, width, height } = layoutIn($("usage").clientWidth || 640);
  const map = treemap(items, width, height, {
    picked: pickedTile?.key ?? null,
    pick: (key) => {
      const tile = find(items, key);
      if (tile?.children) {
        zoom.set(tab, key);
        picked = null;
      } else picked = key;
      drawUsage(scan);
    },
    note: cleanNote,
    title,
    decorate: striped,
  });
  const anyClean = cleanWithin(at) > 0;
  $("usage").replaceChildren(
    crumbs(trail(root, at.key), scan),
    el(
      "div",
      { class: `mbody${narrow ? " narrow" : ""}` },
      el(
        "div",
        {},
        map,
        el(
          "div",
          { class: "mlegend" },
          "A folder's tile holds the folders in it — click one to zoom in.",
          anyClean ? el("span", { class: "sw striped" }) : null,
          anyClean ? "could be freed — see Could be cleaned" : null,
        ),
      ),
      detail(pickedTile ?? at, lines, childTable),
    ),
  );
}

/** Draws the tabs and the map of the drive they show. */
export function drawUsage(scan) {
  shown = scan;
  drawTabs(scan);
  if (tab === null) {
    message("The scan found no drive to map.");
    return;
  }
  drawMap(scan);
}

/** In the map's place, when there is no scan to map: why, in a line. */
export function usageMessage(text) {
  shown = null;
  $("tabs").replaceChildren();
  message(text);
}

// The map is laid out to its column's width: again when the window changes it.
let resizing = 0;
addEventListener("resize", () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => {
    if (shown !== null) drawUsage(shown);
  });
});
