// The "What takes the space" map's model (panel/diskmap.js) and the squarified
// layout it is drawn with (panel/treemap.js, copied from prifly-ext-perf).

import { describe, expect, test } from "bun:test";
import { cleanNote, cleanWithin, driveTree, homeOf, nest, norm, trail } from "../panel/diskmap.js";
import { find, squarify } from "../panel/treemap.js";

const GB = 1e9;
const IMAGE = "C:\\Users\\jimmy\\AppData\\Local\\Packages\\Ubuntu20.04\\LocalState\\ext4.vhdx";
const DOCKER = "C:\\Users\\jimmy\\AppData\\Local\\Docker\\wsl\\disk\\docker_data.vhdx";

/** A scan as the scan writes it, the way Jimmy's laptop looks. */
function fixture() {
  const usage = [
    { drive: "C:", path: "C:\\Users", bytes: 832 * GB, what: "folder" },
    { drive: "C:", path: "C:\\Users\\jimmy", bytes: 832 * GB, what: "folder" },
    { drive: "C:", path: "C:\\Users\\jimmy\\AppData", bytes: 640 * GB, what: "folder" },
    { drive: "C:", path: IMAGE, bytes: 466 * GB, what: "WSL disk image (Ubuntu-20.04)" },
    { drive: "C:", path: DOCKER, bytes: 120 * GB, what: "Docker Desktop data disk image" },
    { drive: "C:", path: "C:\\Users\\jimmy\\Videos", bytes: 90 * GB, what: "folder" },
    { drive: "C:", path: "C:\\Program Files", bytes: 62 * GB, what: "folder" },
    { drive: "C:", path: "C:\\Windows", bytes: 30 * GB, what: "folder" },
    { drive: "WSL", path: "/home/jimmy", bytes: 200 * GB, what: "folder" },
    { drive: "WSL", path: "/home/jimmy/src", bytes: 150 * GB, what: "folder" },
    {
      drive: "WSL",
      path: "/tmp/claude-1000",
      bytes: 40 * GB,
      what: "Claude session scratch folders",
    },
  ];
  const candidates = [
    {
      id: `disk-image:${IMAGE}`,
      kind: "disk-image",
      title: "Trim WSL disk image (Ubuntu-20.04)",
      path: IMAGE,
      bytes: 87 * GB,
      drive: "C:",
      safety: "safe",
      why: "sparse",
      blockers: [],
    },
    {
      id: "docker-cache",
      kind: "docker-cache",
      title: "Docker dangling images and build cache",
      path: "docker image prune; docker builder prune",
      bytes: 25 * GB,
      drive: "C:",
      safety: "safe",
      why: "cache",
      blockers: [],
    },
    {
      id: "scratch:a",
      kind: "scratch",
      title: "Scratch folder of a",
      path: "/tmp/claude-1000/a",
      bytes: 10 * GB,
      drive: "WSL",
      safety: "safe",
      why: "ended",
      blockers: [],
    },
    {
      id: "scratch:b",
      kind: "scratch",
      title: "Scratch folder of b",
      path: "/tmp/claude-1000/b",
      bytes: 5 * GB,
      drive: "WSL",
      safety: "safe",
      why: "ended",
      blockers: [],
    },
  ];
  return {
    at: 0,
    took: 0,
    drives: [
      {
        mount: "/mnt/c",
        label: "C:",
        sizeBytes: 1000 * GB,
        usedBytes: 950 * GB,
        freeBytes: 50 * GB,
      },
      { mount: "/", label: "WSL", sizeBytes: 1000 * GB, usedBytes: 300 * GB, freeBytes: 700 * GB },
      {
        mount: "/mnt/d",
        label: "D:",
        sizeBytes: 500 * GB,
        usedBytes: 10 * GB,
        freeBytes: 490 * GB,
      },
    ],
    usage,
    candidates,
    notes: [],
  };
}

const keys = (tile) => (tile.children ?? []).map((c) => c.key);
const sum = (list) => list.reduce((s, x) => s + x.value, 0);

/** Every tile in the tree, each once. */
function all(tile) {
  return [tile, ...(tile.children ?? []).flatMap(all)];
}

describe("norm", () => {
  test("Windows, WSL-mounted and trailing-slash paths of one place compare alike", () => {
    expect(norm("C:\\Users\\Jimmy\\")).toBe("c:/users/jimmy");
    expect(norm("/mnt/c/Users/jimmy")).toBe("c:/users/jimmy");
    expect(norm("/mnt/c")).toBe("c:");
    expect(norm("/mnt/cdrom/x")).toBe("/mnt/cdrom/x");
  });
});

describe("nest", () => {
  test("each item sits under the deepest listed item holding it, and is listed once", () => {
    const top = nest([
      { path: "C:\\Users\\jimmy\\AppData" },
      { path: "C:\\Users" },
      { path: "C:\\Users\\jimmy" },
      { path: "C:\\Users\\jimmy" },
      { path: "C:\\Program Files" },
    ]);
    expect(top.map((n) => n.key)).toEqual(["c:/users", "c:/program files"]);
    expect(top[0].kids.map((n) => n.key)).toEqual(["c:/users/jimmy"]);
    expect(top[0].kids[0].kids.map((n) => n.key)).toEqual(["c:/users/jimmy/appdata"]);
  });

  test("a sibling sharing a prefix is not a child: C:\\Users2 is not in C:\\Users", () => {
    const top = nest([{ path: "C:\\Users" }, { path: "C:\\Users2" }]);
    expect(top.map((n) => n.key)).toEqual(["c:/users", "c:/users2"]);
  });

  test("a folder whose parent is not listed nests under the nearest listed ancestor", () => {
    const top = nest([{ path: "C:\\Users\\jimmy" }, { path: IMAGE }]);
    expect(top.map((n) => n.key)).toEqual(["c:/users/jimmy"]);
    expect(top[0].kids.map((n) => n.key)).toEqual([norm(IMAGE)]);
  });
});

describe("driveTree", () => {
  const c = driveTree(fixture(), "C:");

  test("the top level is the outermost folders, biggest first, then other files and free space", () => {
    expect(keys(c)).toEqual(["c:/users", "c:/program files", "c:/windows", "#other", "#free"]);
    expect(find(c.children, "#free").value).toBe(50 * GB);
    // 950 used, 832 + 62 + 30 of it in the folders.
    expect(find(c.children, "#other").value).toBe(26 * GB);
    expect(c.value).toBe(1000 * GB);
  });

  test("children are inside their parent, never beside it", () => {
    const users = find(c.children, "c:/users");
    expect(keys(users)).toEqual(["c:/users/jimmy"]);
    const jimmy = find(c.children, "c:/users/jimmy");
    expect(keys(jimmy)).toEqual([
      "c:/users/jimmy/appdata",
      "c:/users/jimmy/videos",
      "c:/users/jimmy#rest",
    ]);
    expect(find(c.children, "c:/users/jimmy/appdata").children.map((t) => t.name)).toEqual([
      "WSL disk image (Ubuntu-20.04)",
      "Docker Desktop data disk image",
      "other files",
    ]);
  });

  test("no byte counted twice: each tile's children add up to it, every path appears once", () => {
    for (const tile of all(c)) {
      if (tile.children) expect(sum(tile.children)).toBe(tile.value);
    }
    const paths = all(c).flatMap((t) => (t.path === undefined ? [] : [norm(t.path)]));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length).toBe(8);
  });

  test("the remainder tile is what the children leave of their parent", () => {
    const rest = find(c.children, "c:/users/jimmy#rest");
    expect(rest.value).toBe((832 - 640 - 90) * GB);
    expect(rest.name).toBe("other files");
    // A parent the size of its one child gets no remainder.
    expect(find(c.children, "c:/users#rest")).toBeNull();
  });

  test("tiles carry what the scan calls them, else their folder's name", () => {
    expect(find(c.children, norm(IMAGE)).name).toBe("WSL disk image (Ubuntu-20.04)");
    expect(find(c.children, "c:/program files").name).toBe("Program Files");
  });

  test("a top-level folder's colour is kept by everything inside it", () => {
    const users = find(c.children, "c:/users");
    const inside = all(users).map((t) => t.colour.split(" ")[0]);
    expect(new Set(inside)).toEqual(new Set([users.colour]));
    expect(find(c.children, "c:/program files").colour).not.toBe(users.colour);
  });

  test("a drive with no folder measured, or no such drive, has no map", () => {
    expect(driveTree(fixture(), "D:")).toBeNull();
    expect(driveTree(fixture(), "E:")).toBeNull();
    expect(driveTree({ ...fixture(), usage: [] }, "C:")).toBeNull();
  });
});

describe("cleanable marks", () => {
  test("a disk image's trim sits on the image's own tile, with its line", () => {
    const c = driveTree(fixture(), "C:");
    const image = find(c.children, norm(IMAGE));
    expect(image.clean.bytes).toBe(87 * GB);
    expect(cleanNote(image)).toBe("87 GB could be freed by trimming");
    expect(cleanNote(find(c.children, "c:/users/jimmy"))).toBeNull();
    expect(cleanWithin(find(c.children, "c:/users"))).toBe(112 * GB);
  });

  test("Docker's cleanups, which name a command, sit on the Docker data disk", () => {
    const c = driveTree(fixture(), "C:");
    const docker = find(c.children, norm(DOCKER));
    expect(cleanNote(docker)).toBe("25 GB could be freed by pruning Docker's build cache");
  });

  test("candidates below a listed folder add up on the deepest listed folder holding them", () => {
    const wsl = driveTree(fixture(), "WSL");
    const scratch = find(wsl.children, "/tmp/claude-1000");
    expect(scratch.name).toBe("Claude session scratch folders");
    expect(scratch.clean.items.map((i) => i.id)).toEqual(["scratch:a", "scratch:b"]);
    expect(cleanNote(scratch)).toBe("15 GB could be freed by clearing scratch folders");
    // Each candidate on one tile only.
    const marked = all(wsl).filter((t) => t.clean);
    expect(marked.map((t) => t.key)).toEqual(["/tmp/claude-1000"]);
  });

  test("a candidate on no tile is left off the map, and never frees more than its tile", () => {
    const scan = fixture();
    scan.candidates.push({ ...scan.candidates[0], id: "x", path: "D:\\x", bytes: 1 });
    scan.candidates.push({ ...scan.candidates[0], id: "y", bytes: 900 * GB });
    const c = driveTree(scan, "C:");
    const image = find(c.children, norm(IMAGE));
    expect(image.clean.bytes).toBe(466 * GB);
    expect(homeOf(c, scan.candidates.at(-2))).toBeNull();
  });

  test("a database's 'dir (name)' path finds its data directory's tile", () => {
    const scan = fixture();
    scan.usage.push({
      drive: "WSL",
      path: "/var/lib/postgresql",
      bytes: 30 * GB,
      what: "Postgres databases",
    });
    scan.candidates.push({
      ...scan.candidates[2],
      id: "db",
      kind: "database",
      path: "/var/lib/postgresql (odi_old)",
    });
    const wsl = driveTree(scan, "WSL");
    expect(homeOf(wsl, scan.candidates.at(-1))?.key).toBe("/var/lib/postgresql");
  });
});

describe("trail", () => {
  const c = driveTree(fixture(), "C:");

  test("the breadcrumb runs from the drive down to the zoomed folder", () => {
    expect(trail(c, "c:/users/jimmy/appdata").map((t) => t.name)).toEqual([
      "C:",
      "Users",
      "jimmy",
      "AppData",
    ]);
  });

  test("the drive alone at the top, or where the key is gone", () => {
    expect(trail(c, "#root").map((t) => t.key)).toEqual(["#root"]);
    expect(trail(c, "c:/gone").map((t) => t.key)).toEqual(["#root"]);
  });
});

describe("squarify", () => {
  const items = [500, 300, 120, 60, 15, 5].map((value, i) => ({ key: `k${i}`, value }));
  const rect = { x: 10, y: 20, w: 600, h: 360 };
  const out = squarify(items, rect);

  test("every item gets a tile, as big as its share of the rect", () => {
    expect(out.length).toBe(items.length);
    const total = 1000;
    for (const t of out) expect(t.w * t.h).toBeCloseTo((rect.w * rect.h * t.item.value) / total, 6);
  });

  test("the tiles fill the rect and stay inside it", () => {
    const area = out.reduce((s, t) => s + t.w * t.h, 0);
    expect(area).toBeCloseTo(rect.w * rect.h, 6);
    for (const t of out) {
      expect(t.x).toBeGreaterThanOrEqual(rect.x - 1e-9);
      expect(t.y).toBeGreaterThanOrEqual(rect.y - 1e-9);
      expect(t.x + t.w).toBeLessThanOrEqual(rect.x + rect.w + 1e-9);
      expect(t.y + t.h).toBeLessThanOrEqual(rect.y + rect.h + 1e-9);
    }
  });

  test("no two tiles overlap", () => {
    for (const [i, a] of out.entries()) {
      for (const b of out.slice(i + 1)) {
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(w <= 1e-9 || h <= 1e-9).toBe(true);
      }
    }
  });

  test("a drive's top level lays out the same way, free tile included", () => {
    const c = driveTree(fixture(), "C:");
    const laid = squarify(c.children, { x: 0, y: 0, w: 500, h: 300 });
    expect(laid.map((t) => t.item.key).sort()).toEqual([...keys(c)].sort());
    expect(laid.reduce((s, t) => s + t.w * t.h, 0)).toBeCloseTo(500 * 300, 6);
  });

  test("nothing to lay out, or no room, gives no tiles", () => {
    expect(squarify([], rect)).toEqual([]);
    expect(squarify([{ value: 0 }], rect)).toEqual([]);
    expect(squarify(items, { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
  });
});
