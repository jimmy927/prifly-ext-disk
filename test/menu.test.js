// The right-click menu's entries per tile (panel/menu.js), on the tiles of a real map (panel/diskmap.js).

import { describe, expect, test } from "bun:test";
import { driveTree } from "../panel/diskmap.js";
import { investigateKey, isFile, menuEntries, revealPath } from "../panel/menu.js";

const GB = 1e9;
const IMAGE = "C:\\Users\\jimmy\\AppData\\Local\\Packages\\Ubuntu20.04\\LocalState\\ext4.vhdx";

const scan = {
  at: 0,
  took: 0,
  notes: [],
  candidates: [],
  drives: [
    {
      mount: "/mnt/c",
      label: "C:",
      sizeBytes: 1000 * GB,
      usedBytes: 900 * GB,
      freeBytes: 100 * GB,
    },
    { mount: "/", label: "WSL", sizeBytes: 1000 * GB, usedBytes: 300 * GB, freeBytes: 700 * GB },
  ],
  usage: [
    { drive: "C:", path: "C:\\Users", bytes: 400 * GB, what: "folder" },
    { drive: "C:", path: "C:\\Users\\jimmy", bytes: 400 * GB, what: "folder" },
    { drive: "C:", path: "C:\\Users\\jimmy\\Videos", bytes: 90 * GB, what: "folder" },
    { drive: "C:", path: IMAGE, bytes: 466 * GB, what: "WSL disk image (Ubuntu-20.04)" },
    { drive: "C:", path: "C:\\pagefile.sys", bytes: 20 * GB, what: "folder" },
    { drive: "C:", path: "C:\\Windows", bytes: 30 * GB, what: "folder" },
    { drive: "WSL", path: "/home/jimmy", bytes: 200 * GB, what: "folder" },
    { drive: "WSL", path: "/home/jimmy/src", bytes: 150 * GB, what: "folder" },
    { drive: "WSL", path: "/home/jimmy/src/odi", bytes: 60 * GB, what: "folder" },
  ],
};

const root = driveTree(scan, "C:");
const everything = [];
(function walk(tile) {
  everything.push(tile);
  for (const child of tile.children ?? []) walk(child);
})(root);
const tile = (name) => {
  const found = everything.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no tile ${name}`);
  return found;
};

const inside = { inPrifly: true, manager: "Explorer" };
const outside = { inPrifly: false, manager: "Explorer" };
const enabled = (item, where = inside) =>
  Object.fromEntries(menuEntries(item, where).map((entry) => [entry.id, entry.enabled]));

describe("which entries a tile's menu enables", () => {
  test("a Windows folder, a collapsed one, and a Linux folder in the image: both", () => {
    for (const name of ["Windows", "Users › jimmy", "src"]) {
      expect(enabled(tile(name))).toEqual({ investigate: true, reveal: true });
    }
  });

  test("a collapsed tile answers with its deepest folder's path", () => {
    expect(investigateKey(tile("Users › jimmy"))).toBe("folder:C:\\Users\\jimmy");
    expect(revealPath(tile("Users › jimmy"))).toBe("C:\\Users\\jimmy");
    expect(investigateKey(tile("src"))).toBe("folder:/home/jimmy/src");
  });

  test("a file (a disk image, pagefile.sys): only Show in Explorer", () => {
    for (const item of [tile("WSL disk image (Ubuntu-20.04)"), tile("pagefile.sys")]) {
      expect(isFile(item)).toBe(true);
      expect(enabled(item)).toEqual({ investigate: false, reveal: true });
      expect(menuEntries(item, inside)[0].title).toBe("Only folders can be investigated");
    }
  });

  test("a remainder tile is the rest of its folder: both, on the parent", () => {
    const rest = tile("other files");
    expect(enabled(rest)).toEqual({ investigate: true, reveal: true });
    expect(investigateKey(rest)).toBe(`rest:${rest.parent}`);
    expect(revealPath(rest)).toBe(rest.parent);
    expect(menuEntries(rest, inside)[0].label).toMatch(/^Investigate the rest of /);
    for (const name of ["Other files", "other Linux files"]) {
      expect(enabled(tile(name))).toEqual({ investigate: true, reveal: true });
    }
  });

  test("the rest of a drive is investigated from the drive's top", () => {
    expect(investigateKey(tile("Other files"))).toBe("rest:C:\\");
    expect(investigateKey(tile("other Linux files"))).toBe("rest:/");
  });

  test("free space and the image's unused blocks: both disabled, with a reason", () => {
    for (const name of ["Free space", "unused in the image"]) {
      const entries = menuEntries(tile(name), inside);
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.enabled).toBe(false);
        expect(entry.title.length).toBeGreaterThan(10);
      }
    }
  });

  test("outside prifly Investigate is disabled and says why; Show in Explorer is not affected", () => {
    const [investigate, reveal] = menuEntries(tile("Windows"), outside);
    expect(investigate.enabled).toBe(false);
    expect(investigate.title).toMatch(/prifly/);
    expect(reveal.enabled).toBe(true);
  });

  test("after Investigate: Started, and disabled", () => {
    const [investigate] = menuEntries(tile("Windows"), { ...inside, started: true });
    expect(investigate).toMatchObject({ label: "Started ↗", enabled: false });
  });
});
