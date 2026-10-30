// The Disk space window: drives, what takes their space, and what could be
// cleaned. Data comes from `api/status`; `api/rescan` and `api/deep` start
// scans, and the page polls while one runs. What takes the space is a
// treemap of its own (usagemap.js).

import { nameOf, outermost } from "./diskmap.js";
import { bytes, el } from "./format.js";
import { drawUsage, usageMessage } from "./usagemap.js";

const $ = (id) => document.getElementById(id);
const COLOURS = ["--s0", "--s1", "--s2", "--s3", "--s4", "--s5"];
const SAFETY = {
  safe: "Safe — nothing is lost",
  check: "Check first — something may be lost",
  downtime: "Needs downtime — services stop while it runs",
};

let last = null;
let polling = null;
/** The keys a cleanup session was started for while this page is open. */
const started = new Set();

function ago(at) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function driveCard(drive, usage) {
  const top = outermost(usage.filter((item) => item.drive === drive.label)).slice(
    0,
    COLOURS.length,
  );
  const known = top.reduce((sum, item) => sum + item.bytes, 0);
  const other = Math.max(0, drive.usedBytes - known);
  const pct = (n) => `${(100 * n) / drive.sizeBytes}%`;
  const meter = el("div", { class: "meter" });
  const legend = el("div", { class: "legend" });
  top.forEach((item, i) => {
    const colour = `var(${COLOURS[i]})`;
    meter.append(
      el("span", {
        style: `width:${pct(item.bytes)};background:${colour}`,
        title: `${item.path} — ${bytes(item.bytes)}`,
      }),
    );
    legend.append(
      el(
        "span",
        {},
        el("span", { class: "swatch", style: `background:${colour}` }),
        `${nameOf(item)} ${bytes(item.bytes)}`,
      ),
    );
  });
  meter.append(
    el("span", { style: `width:${pct(other)};background:var(--other)`, title: "everything else" }),
  );
  legend.append(
    el(
      "span",
      {},
      el("span", { class: "swatch", style: "background:var(--other)" }),
      `other ${bytes(other)}`,
    ),
  );
  legend.append(
    el(
      "span",
      {},
      el("span", { class: "swatch", style: "background:var(--free)" }),
      `free ${bytes(drive.freeBytes)}`,
    ),
  );
  return el(
    "div",
    { class: "drive" },
    el(
      "div",
      { class: "drive-head" },
      el("span", { class: "drive-name" }, drive.label),
      el(
        "span",
        { class: "status" },
        `${bytes(drive.freeBytes)} free of ${bytes(drive.sizeBytes)}`,
      ),
    ),
    meter,
    legend,
  );
}

function drawDrives(scan) {
  $("drives").replaceChildren(...scan.drives.map((drive) => driveCard(drive, scan.usage)));
}

/**
 * A Clean up button: asks prifly to start a session for this key in a window
 * of its own (`prifly-launch`), which the extension's `launch` writes the
 * prompt for. Several can run at once, and this window can be closed.
 * Outside prifly — the page opened on its own — there is nobody to ask.
 */
function cleanupButton(key, label) {
  if (window.parent === window) return null;
  const done = started.has(key);
  const button = el("button", { type: "button", class: "btn small" }, done ? "Started ↗" : label);
  button.disabled = done;
  button.title = done
    ? "A session for this runs in its own window"
    : "Start a session in its own window that checks this again, asks you once, and cleans it";
  button.addEventListener("click", () => {
    window.parent.postMessage({ type: "prifly-launch", launcher: "cleanup", key }, "*");
    started.add(key);
    button.textContent = "Started ↗";
    button.disabled = true;
  });
  return button;
}

function candidateRow(candidate) {
  const blockers =
    candidate.blockers.length === 0
      ? null
      : el("ul", { class: "blockers" }, ...candidate.blockers.map((text) => el("li", {}, text)));
  return el(
    "div",
    { class: "row candidate" },
    el("span", { class: "size" }, bytes(candidate.bytes)),
    el(
      "span",
      {},
      el("div", {}, `${candidate.title} `, el("span", { class: "what" }, `on ${candidate.drive}`)),
      el("div", { class: "why" }, candidate.why),
      el("div", { class: "path" }, candidate.path),
      blockers,
    ),
    cleanupButton(candidate.id, "Clean up"),
  );
}

function drawCandidates(scan) {
  const total = scan.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  $("cleanable").textContent = `— ${bytes(total)} in ${scan.candidates.length} places`;
  const groups = ["safe", "check", "downtime"].map((safety) => {
    const list = scan.candidates.filter((candidate) => candidate.safety === safety);
    if (list.length === 0) return null;
    const sum = list.reduce((acc, candidate) => acc + candidate.bytes, 0);
    return el(
      "div",
      { class: "group" },
      el(
        "h3",
        {},
        el("span", { class: `dot ${safety}` }),
        `${SAFETY[safety]} · ${bytes(sum)}`,
        el("span", { class: "grow" }),
        cleanupButton(`group:${safety}`, `Clean up all ${list.length}`),
      ),
      ...list.map(candidateRow),
    );
  });
  $("candidates").replaceChildren(...groups.filter(Boolean));
  $("notes").replaceChildren(...scan.notes.map((note) => el("li", {}, `Not read — ${note}`)));
}

const PART_MARK = { waiting: "○", running: "◐", done: "✓", failed: "✕", skipped: "–" };

function seconds(ms) {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** One row per part of the running scan: what it has counted so far, and for how long. */
function drawParts(state) {
  if (!state.scanning || state.parts.length === 0) {
    $("parts").replaceChildren();
    return;
  }
  $("parts").replaceChildren(
    ...state.parts.map((part) => {
      const time =
        part.state === "running"
          ? seconds(Date.now() - part.startedAt)
          : part.state === "done" || part.state === "failed"
            ? seconds(part.ms)
            : "";
      return el(
        "div",
        { class: `part ${part.state}` },
        el("span", { class: "mark" }, PART_MARK[part.state]),
        el("span", { class: "name" }, part.name),
        el("span", { class: "detail" }, part.state === "waiting" ? "waiting" : part.detail),
        el("span", { class: "time" }, time),
      );
    }),
  );
}

function drawStatus(state) {
  $("status").textContent = state.scanning
    ? "Scanning…"
    : state.scan
      ? `Scanned ${ago(state.scan.at)}, in ${seconds(state.scan.took)}`
      : "";
  $("rescan").disabled = state.scanning;
  $("error").hidden = state.error === "";
  $("error").textContent = state.error;
  drawParts(state);
}

/** In the map's place before any scan has finished: running, failed, or not asked for yet. */
function noMapYet(state) {
  if (state.scanning) return "Scanning… the map of what takes the space appears when it is done.";
  if (state.error !== "")
    return "The scan failed, so there is nothing to map — the error is above; Scan now tries again.";
  return "Not scanned yet. Scan now maps what takes the space on each drive.";
}

function draw(state) {
  last = state;
  drawStatus(state);
  if (state.scan === null) {
    // A scan runs only when asked (index.ts): until one has, there is nothing to draw.
    const drives = state.scanning
      ? "Reading the drives…"
      : state.error !== ""
        ? "No drive read — the scan failed."
        : "Not scanned yet — Scan now reads every drive.";
    $("drives").replaceChildren(el("p", { class: "hint" }, drives));
    usageMessage(noMapYet(state));
    return;
  }
  drawDrives(state.scan);
  drawUsage(state.scan, state.fileManager);
  drawCandidates(state.scan);
}

async function call(path) {
  const response = await fetch(`api/${path}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

async function refresh(path = "status") {
  try {
    const state = await call(path);
    draw(state);
    clearTimeout(polling);
    // Every second while a scan runs, so its counts move; the scan's result
    // replaces the page once it is over.
    if (state.scanning) polling = setTimeout(() => void refresh(), 1000);
  } catch (error) {
    $("error").hidden = false;
    $("error").textContent = String(error.message ?? error);
    // Never answered yet: the map's place says so rather than staying blank.
    if (last === null) usageMessage("The window could not read the scan — the error is above.");
  }
}

$("rescan").addEventListener("click", () => void refresh("rescan"));

const LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--accent": "--accent",
  "--font-sans": "--font",
  "--font-mono": "--mono",
};
addEventListener("message", (event) => {
  if (event.data?.type !== "prifly-look") return;
  document.documentElement.classList.toggle("dark", event.data.dark === true);
  for (const [theirs, ours] of Object.entries(LOOK)) {
    const value = event.data.tokens?.[theirs];
    if (typeof value === "string" && value !== "")
      document.documentElement.style.setProperty(ours, value);
  }
  if (last !== null) draw(last);
});

void refresh();
