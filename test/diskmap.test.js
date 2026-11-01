// The "What takes the space" map's model (panel/diskmap.js); its layout is in squarify.test.js.

import { describe, expect, test } from "bun:test";
import {
  cleanNote,
  cleanWithin,
  driveTree,
  homeOf,
  nest,
  norm,
  tabsOf,
  trail,
} from "../panel/diskmap.js";
import { find } from "../panel/treemap.js";

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
    expect(keys(c)).toEqual([
      "c:/users/jimmy",
      "c:/program files",
      "c:/windows",
      "#other",
      "#free",
    ]);
    expect(find(c.children, "#free").value).toBe(50 * GB);
    // 950 used, 832 + 62 + 30 of it in the folders.
    expect(find(c.children, "#other").value).toBe(26 * GB);
    expect(c.value).toBe(1000 * GB);
  });

  test("children are inside their parent, never beside it", () => {
    // Users holds only jimmy: one tile, "Users › jimmy" (see "chains collapse").
    expect(find(c.children, "c:/users")).toBeNull();
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
    // The eight Windows paths less Users, drawn in jimmy's tile, and the three Linux folders inside the WSL image.
    expect(paths.length).toBe(10);
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
    const users = find(c.children, "c:/users/jimmy");
    // Except WSL's own folders inside the disk image, which have a colour of their own.
    const image = find(users.children, norm(IMAGE));
    const inside = all(users)
      .filter((t) => !all(image).includes(t) || t === image)
      .map((t) => t.colour.split(" ")[0]);
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
  test("a disk image's trim sits on its unused tile, with its line", () => {
    const c = driveTree(fixture(), "C:");
    const unused = find(c.children, `${norm(IMAGE)}#unused`);
    expect(unused.clean.bytes).toBe(87 * GB);
    expect(cleanNote(unused)).toBe("87 GB could be freed by trimming");
    expect(find(c.children, norm(IMAGE)).clean).toBeUndefined();
    expect(cleanNote(find(c.children, "c:/users/jimmy"))).toBeNull();
    expect(cleanWithin(find(c.children, "c:/users/jimmy"))).toBe(127 * GB);
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
    // The trim cannot free more than the image has unused: 466 - 300 GB.
    expect(find(c.children, `${norm(IMAGE)}#unused`).clean.bytes).toBe(166 * GB);
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

describe("a candidate on a group", () => {
  const worktree = (path) => ({
    id: "wt",
    kind: "worktree",
    title: "Old worktree",
    path,
    bytes: 7 * GB,
    drive: "C:",
    safety: "safe",
    why: "merged",
    blockers: [],
  });

  test("moves to the group's other-files tile, where its bytes are; the group has no mark", () => {
    const scan = fixture();
    scan.candidates.push(worktree("C:\\Users\\jimmy\\worktrees\\old"));
    const c = driveTree(scan, "C:");
    const rest = find(c.children, "c:/users/jimmy#rest");
    expect(rest.clean.items.map((i) => i.id)).toEqual(["wt"]);
    expect(cleanNote(rest)).toBe("7.0 GB could be freed by removing worktrees");
    expect(find(c.children, "c:/users/jimmy").clean).toBeUndefined();
  });

  test("a collapsed chain ending in a plain folder keeps it on that folder", () => {
    const scan = fixture();
    scan.usage.push({ drive: "C:", path: "C:\\Windows\\System32", bytes: 30 * GB, what: "folder" });
    scan.candidates.push(worktree("C:\\Windows\\temp\\x"));
    const c = driveTree(scan, "C:");
    // Windows holds only System32: collapsed, a leaf; it has no children to draw a foot under.
    const tile = find(c.children, "c:/windows/system32");
    expect(tile.name).toBe("Windows › System32");
    expect(tile.clean.items.map((i) => i.id)).toEqual(["wt"]);
    expect(tile.children).toBeUndefined();
  });

  test("a group with children and no rest keeps it", () => {
    const scan = fixture();
    scan.usage.push(
      { drive: "C:", path: "C:\\Windows\\A", bytes: 15 * GB, what: "folder" },
      { drive: "C:", path: "C:\\Windows\\B", bytes: 15 * GB, what: "folder" },
    );
    scan.candidates.push(worktree("C:\\Windows\\C\\x"));
    const win = find(driveTree(scan, "C:").children, "c:/windows");
    expect(win.children.map((t) => t.kind)).toEqual(["folder", "folder"]);
    expect(win.clean.items.map((i) => i.id)).toEqual(["wt"]);
  });
});

describe("chains collapse", () => {
  const c = driveTree(fixture(), "C:");

  test("Users with only jimmy in it is one tile, with jimmy's key, path and children", () => {
    const tile = find(c.children, "c:/users/jimmy");
    expect(tile.name).toBe("Users › jimmy");
    expect(tile.path).toBe("C:\\Users\\jimmy");
    expect(tile.value).toBe(832 * GB);
    expect(keys(tile)).toEqual([
      "c:/users/jimmy/appdata",
      "c:/users/jimmy/videos",
      "c:/users/jimmy#rest",
    ]);
  });

  test("a folder with a real remainder is not collapsed", () => {
    const scan = fixture();
    scan.usage.find((u) => u.path === "C:\\Users").bytes = 840 * GB;
    const users = find(driveTree(scan, "C:").children, "c:/users");
    expect(users.name).toBe("Users");
    expect(keys(users)).toEqual(["c:/users/jimmy", "c:/users#rest"]);
  });

  test("a candidate on the collapsed parent folder's own path lands on the collapsed tile", () => {
    const scan = fixture();
    scan.candidates.push({ ...scan.candidates[2], id: "u", kind: "worktree", path: "C:\\Users" });
    expect(homeOf(driveTree(scan, "C:"), scan.candidates.at(-1))?.key).toBe("c:/users/jimmy");
  });

  test("a candidate on a group's own folder stays on the group, not its other-files tile", () => {
    const scan = fixture();
    const path = "C:\\Users\\jimmy";
    scan.candidates.push({ ...scan.candidates[2], id: "j", kind: "worktree", path });
    expect(homeOf(driveTree(scan, "C:"), scan.candidates.at(-1))?.key).toBe("c:/users/jimmy");
  });
});

describe("WSL inside its disk image", () => {
  const scan = fixture();
  const c = driveTree(scan, "C:");
  const image = find(c.children, norm(IMAGE));

  test("the image holds Linux's folders, the rest of what Linux uses, and what it no longer uses", () => {
    expect(keys(image)).toEqual([
      "/home/jimmy",
      "/tmp/claude-1000",
      `${image.key}#linux-other`,
      `${image.key}#unused`,
    ]);
    expect(find(image.children, "/home/jimmy").children.map((t) => t.name)).toEqual([
      "src",
      "other files",
    ]);
    // Linux uses 300 GB: 200 + 40 in the folders listed, 60 outside them.
    expect(find(image.children, `${image.key}#linux-other`).value).toBe(60 * GB);
    expect(find(image.children, `${image.key}#linux-other`).name).toBe("other Linux files");
  });

  test("nothing is counted twice: the image tile keeps its size and its children add up to it", () => {
    expect(image.value).toBe(466 * GB);
    expect(sum(image.children)).toBe(image.value);
    expect(c.value).toBe(1000 * GB);
    const paths = all(c).flatMap((t) => (t.path === undefined ? [] : [t.key]));
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("the unused tile is the image less what Linux uses, and the folders keep their own colour", () => {
    const unused = find(image.children, `${image.key}#unused`);
    expect(unused.value).toBe((466 - 300) * GB);
    expect(unused.name).toBe("unused in the image");
    expect(unused.colour).toBe("k-free");
    for (const tile of all(find(image.children, "/home/jimmy")))
      expect(tile.colour.split(" ")[0]).toBe("c5");
    expect(find(c.children, "c:/users/jimmy").colour).not.toContain("c5");
  });

  test("the trim candidate is on the unused tile only", () => {
    const trim = scan.candidates[0];
    expect(homeOf(c, trim)?.key).toBe(`${image.key}#unused`);
    expect(image.clean).toBeUndefined();
  });

  test("a WSL candidate is on the Linux tile holding its path, however deep", () => {
    const scratch = find(c.children, "/tmp/claude-1000");
    expect(scratch.clean.items.map((i) => i.id)).toEqual(["scratch:a", "scratch:b"]);
    expect(cleanNote(scratch)).toBe("15 GB could be freed by clearing scratch folders");
    const worktree = { ...scan.candidates[2], kind: "worktree", path: "/home/jimmy/src/x/y" };
    expect(homeOf(c, worktree)?.key).toBe("/home/jimmy/src");
    // The image's trim and the cleanup of Linux folders both count in the C: drive's totals.
    expect(cleanWithin(image)).toBe((87 + 15) * GB);
  });

  test("the WSL drive has no tab of its own once it is in the image", () => {
    expect(tabsOf(scan)).toEqual(["C:", "D:"]);
  });

  test("with no WSL disk image on the scan, nothing is grafted and WSL keeps its tab", () => {
    const bare = fixture();
    bare.usage = bare.usage.filter((item) => item.path !== IMAGE);
    const tree = driveTree(bare, "C:");
    expect(find(tree.children, "/home/jimmy")).toBeNull();
    expect(tabsOf(bare)).toEqual(["C:", "WSL", "D:"]);
  });

  test("with no WSL drive on the scan, the image stays a plain tile", () => {
    const bare = fixture();
    bare.drives = bare.drives.filter((drive) => drive.label !== "WSL");
    const tree = driveTree(bare, "C:");
    expect(find(tree.children, norm(IMAGE)).children).toBeUndefined();
    expect(tabsOf(bare)).toEqual(["C:", "D:"]);
  });

  test("an image smaller than what Linux uses is left as it is", () => {
    const odd = fixture();
    odd.drives.find((drive) => drive.label === "WSL").usedBytes = 500 * GB;
    expect(find(driveTree(odd, "C:").children, norm(IMAGE)).children).toBeUndefined();
    expect(tabsOf(odd)).toContain("WSL");
  });

  test("several images: Linux goes into the first the scan lists, once", () => {
    const two = fixture();
    two.usage.push({
      drive: "D:",
      path: "D:\\vm\\ext4.vhdx",
      bytes: 100 * GB,
      what: "WSL disk image (Debian)",
    });
    expect(find(driveTree(two, "C:").children, norm(IMAGE)).children).toBeDefined();
    expect(find(driveTree(two, "D:").children, "d:/vm/ext4.vhdx").children).toBeUndefined();
  });

  test("the breadcrumb runs through the image into a Linux folder", () => {
    expect(trail(c, "/home/jimmy/src").map((t) => t.name)).toEqual([
      "C:",
      "Users",
      "jimmy",
      "AppData",
      "WSL disk image (Ubuntu-20.04)",
      "jimmy",
      "src",
    ]);
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

  test("a collapsed tile is a step per folder, each leading to that tile", () => {
    const steps = trail(c, "c:/users/jimmy");
    expect(steps.map((t) => t.name)).toEqual(["C:", "Users", "jimmy"]);
    expect(steps.slice(1).map((t) => t.key)).toEqual(["c:/users/jimmy", "c:/users/jimmy"]);
  });

  test("the drive alone at the top, or where the key is gone", () => {
    expect(trail(c, "#root").map((t) => t.key)).toEqual(["#root"]);
    expect(trail(c, "c:/gone").map((t) => t.key)).toEqual(["#root"]);
  });
});
