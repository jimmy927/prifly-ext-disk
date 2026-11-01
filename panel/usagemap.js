// "What takes the space": a drive's folders as a treemap (diskmap.js's model,
// drawn by treemap.js) as wide and as tall as the window, one drive at a time
// by its tab (no tabs where there is one drive). A click on a folder
// that holds others zooms into it, the breadcrumb above leads back up, and a
// click on any other tile says what it is in the detail. Tiles that hold
// something "Could be cleaned" lists are striped as far as it frees. A
// right-click on a tile opens a menu (menu.js), and its detail has the same as
// buttons: Investigate (a session of its own on that folder, `prifly-launch`)
// and show it in the system's file manager (`api/reveal`).

import { cleanNote, cleanWithin, driveTree, tabsOf, trail } from "./diskmap.js";
import { bytes, el } from "./format.js";
import { investigateKey, menuEntries, revealPath } from "./menu.js";
import { detail, find, layoutIn, treemap } from "./treemap.js";

const $ = (id) => document.getElementById(id);

/** The room kept under the map for its legend and the page's foot, and the least height it gets. */
const BELOW_MAP = 90;
const MIN_HEIGHT = 420;

/** The drive shown, the tile zoomed into on each drive, the tile picked: kept across redraws. */
let tab = null;
const zoom = new Map();
let picked = null;
let shown = null;
/** What the file manager is called here ("Explorer", "Finder", "Files"), from `api/status`. */
let manager = "file manager";
/** The last "show in" outcome, for the tile it was asked for: `{ key, text, failed }`. */
let revealed = null;

/** Whether this page is inside prifly's window, which can start a session (`prifly-launch`). */
function inPrifly() {
  return window.parent !== window;
}

/** The tiles an investigation was started for while this page is open. */
const investigated = new Set();

async function showIn(item, scan) {
  const path = revealPath(item);
  if (path === null) return;
  picked = item.key;
  revealed = { key: item.key, text: `Opening in ${manager}…`, failed: false };
  drawUsage(shown ?? scan);
  try {
    const response = await fetch("api/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    revealed = { key: item.key, text: `Shown in ${manager}.`, failed: false };
  } catch (error) {
    revealed = { key: item.key, text: String(error.message ?? error), failed: true };
  }
  if (shown !== null) drawUsage(shown);
}

/**
 * Asks prifly for a session in a window of its own that investigates the
 * tile's folder (`prifly-launch`; the extension's `launch` writes the prompt).
 * The menu and the detail's button then show "Started ↗" for the tile.
 */
function investigate(item) {
  const key = investigateKey(item);
  if (key === null || !inPrifly() || investigated.has(item.key)) return;
  window.parent.postMessage({ type: "prifly-launch", launcher: "investigate", key }, "*");
  investigated.add(item.key);
  picked = item.key;
  if (shown !== null) drawUsage(shown);
}

function entriesOf(item) {
  return menuEntries(item, {
    inPrifly: inPrifly(),
    manager,
    started: investigated.has(item.key),
  });
}

let menu = null;

function closeMenu() {
  menu?.remove();
  menu = null;
}

/** The entries a key press can reach: all but the disabled ones. */
function usable(list) {
  return [...list.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')];
}

/** The menu at the pointer: Investigate, Show in Explorer; one that does not fit the tile stays, disabled, its title saying why. */
function openMenu(event, item, scan) {
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
  const entries = entriesOf(item).map((entry) => {
    const node = el(
      "button",
      {
        type: "button",
        class: "ctx-item",
        role: "menuitem",
        title: entry.title,
        "aria-disabled": String(!entry.enabled),
      },
      entry.label,
    );
    node.addEventListener("click", (click) => {
      click.stopPropagation();
      if (!entry.enabled) return;
      closeMenu();
      if (entry.id === "investigate") investigate(item);
      else void showIn(item, scan);
    });
    return node;
  });
  menu = el("div", { class: "ctx-menu", role: "menu" }, ...entries);
  menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - 250))}px`;
  menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - 80))}px`;
  document.body.append(menu);
  usable(menu)[0]?.focus();
}

/** Arrow keys move over the entries that can be used, Enter picks the focused one, Escape closes. */
function menuKey(event) {
  if (menu === null) return;
  if (event.key === "Escape") {
    closeMenu();
    return;
  }
  const choices = usable(menu);
  const at = choices.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (choices.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    choices[(at + step + choices.length) % choices.length]?.focus();
  } else if (event.key === "Enter" && at >= 0) {
    event.preventDefault();
    choices[at]?.click();
  }
}

addEventListener("click", closeMenu);
addEventListener("contextmenu", closeMenu);
addEventListener("blur", closeMenu);
addEventListener("keydown", menuKey);

function drawTabs(scan) {
  const labels = tabsOf(scan);
  if (tab === null || !labels.includes(tab)) tab = labels[0] ?? null;
  // One drive needs no tab to choose it.
  $("tabs").replaceChildren(
    ...(labels.length < 2 ? [] : labels).map((name) => {
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

/** Every tile opens the menu on a right-click: an entry that does not fit it is disabled, not hidden. */
function menuOn(scan) {
  return (item, node) => {
    striped(item, node);
    node.addEventListener("contextmenu", (event) => openMenu(event, item, scan));
  };
}

function title(item) {
  const where = item.path === undefined ? "" : `\n${item.path}`;
  const note = cleanNote(item);
  return `${item.name}: ${bytes(item.value)}${where}${note === null ? "" : `\n${note}`}`;
}

/** The part of a tile that could be freed, striped from its foot up. A group has none: its children cover its foot. */
function striped(item, node) {
  if (!item.clean || item.children) return;
  node.classList.add("has-clean");
  node.append(
    el("div", {
      class: "cleanable",
      style: `height:${Math.max(4, (100 * item.clean.bytes) / item.value)}%`,
    }),
  );
}

/** Under the picked tile's size: the way to open it, then what in it could be freed. */
function linesFor(scan) {
  return (item) => {
    const out = [];
    const entries = entriesOf(item);
    if (!["free", "unused", "drive"].includes(item.kind)) {
      const buttons = entries.map((entry) => {
        const button = el(
          "button",
          { type: "button", class: "btn small", title: entry.title },
          entry.id === "reveal"
            ? `Open in ${manager}`
            : entry.label === "Started ↗"
              ? entry.label
              : "Investigate",
        );
        button.disabled = !entry.enabled;
        button.addEventListener("click", () => {
          if (entry.id === "reveal") void showIn(item, scan);
          else investigate(item);
        });
        return button;
      });
      out.push(el("p", { class: "reveal" }, ...buttons));
      if (revealed?.key === item.key)
        out.push(
          el(
            "p",
            { class: `reveal-note${revealed.failed ? " failed" : ""}`, role: "status" },
            revealed.text,
          ),
        );
    }
    return [...out, ...lines(item)];
  };
}

/** What in the tile could be freed. */
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

/** The way back up, and at the right end what the drive holds. */
function crumbs(path, scan) {
  const drive = scan.drives.find((each) => each.label === tab);
  return el(
    "div",
    { class: "crumbline" },
    trailNav(path, scan),
    drive === undefined
      ? null
      : el(
          "span",
          { class: "status" },
          `${bytes(drive.usedBytes)} used · ${bytes(drive.freeBytes)} free of ${bytes(drive.sizeBytes)}`,
        ),
  );
}

function trailNav(path, scan) {
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
        : `The scan measured no folder on ${tab} — ${bytes(drive.usedBytes)} used, ${bytes(drive.freeBytes)} free.`,
    );
    return;
  }
  // A folder zoomed into before a rescan may be gone, or hold no folder now.
  const zoomed = find([root], zoom.get(tab) ?? "#root");
  const at = zoomed?.children ? zoomed : root;
  const items = at.children;
  const pickedTile = picked === null ? null : find(items, picked);
  const { narrow, width } = layoutIn($("usage").clientWidth || 640);
  // From the map's top to the window's foot, whatever is scrolled away.
  const top = $("usage").getBoundingClientRect().top + scrollY;
  const height = Math.max(MIN_HEIGHT, Math.round(innerHeight - top - BELOW_MAP));
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
    // A group's header is one line tall: its note is in its hover title and the detail.
    note: (item) => (item.children ? null : cleanNote(item)),
    title,
    decorate: menuOn(scan),
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
      detail(pickedTile ?? at, linesFor(scan), childTable),
    ),
  );
}

/** Draws the tabs and the map of the drive they show. */
export function drawUsage(scan, fileManager = manager) {
  shown = scan;
  manager = fileManager ?? manager;
  closeMenu();
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
  closeMenu();
  $("tabs").replaceChildren();
  message(text);
}

// The map is laid out to the window's width and height: again when the window changes.
let resizing = 0;
addEventListener("resize", () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => {
    if (shown !== null) drawUsage(shown);
  });
});
