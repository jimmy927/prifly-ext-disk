import { describe, expect, test } from "bun:test";
import { investigatePrompt, investigateTarget } from "../scan/investigate";
import type { Scan } from "../scan/types";

const GB = 1e9;
const IMAGE = "C:\\Users\\jimmy\\AppData\\Local\\Packages\\Ubuntu20.04\\LocalState\\ext4.vhdx";

const scan: Scan = {
  at: Date.parse("2026-10-30T12:00:00Z"),
  took: 1,
  notes: [],
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
    { drive: "C:", path: "C:\\Users\\jimmy", bytes: 700 * GB, what: "folder" },
    { drive: "C:", path: "C:\\Users\\jimmy\\Videos", bytes: 90 * GB, what: "folder" },
    {
      drive: "C:",
      path: "C:\\Users\\jimmy\\AppData\\Local\\Docker",
      bytes: 120 * GB,
      what: "folder",
    },
    { drive: "C:", path: IMAGE, bytes: 466 * GB, what: "WSL disk image (Ubuntu-20.04)" },
    { drive: "WSL", path: "/home/jimmy/src", bytes: 150 * GB, what: "folder" },
    { drive: "WSL", path: "/home/jimmy/src/odi", bytes: 60 * GB, what: "folder" },
  ],
  candidates: [
    {
      id: "worktree:/home/jimmy/src/odi/wt",
      kind: "worktree",
      title: "Worktree wt (done)",
      path: "/home/jimmy/src/odi/wt",
      bytes: 4 * GB,
      drive: "WSL",
      safety: "check",
      why: "no session works in it",
      blockers: [],
    },
    {
      id: "disk-image:x",
      kind: "disk-image",
      title: "Trim WSL disk image",
      path: IMAGE,
      bytes: 87 * GB,
      drive: "C:",
      safety: "safe",
      why: "sparse",
      blockers: [],
    },
  ],
};

describe("the investigation prompt", () => {
  test("a Windows folder: its path in both forms, size, what the scan lists inside it", () => {
    const prompt = investigatePrompt(scan, "folder:C:\\Users\\jimmy");
    expect(prompt).toContain("`C:\\Users\\jimmy` (a Windows path; `/mnt/c/Users/jimmy` from WSL)");
    expect(prompt).toContain("700 GB");
    expect(prompt).toContain("- 90 GB `C:\\Users\\jimmy\\Videos`");
    expect(prompt).toContain("- 466 GB");
    expect(prompt).toContain("WSL disk image (Ubuntu-20.04)");
    expect(prompt).toContain("87 GB — Trim WSL disk image (safe): sparse");
    expect(prompt).toMatch(/Do not delete/);
    expect(prompt).toContain("AskUserQuestion");
  });

  test("a WSL folder: a Linux path, only what is inside it", () => {
    const prompt = investigatePrompt(scan, "folder:/home/jimmy/src");
    expect(prompt).toContain("`/home/jimmy/src` (a Linux path, inside WSL)");
    expect(prompt).toContain("150 GB");
    expect(prompt).toContain("- 60 GB `/home/jimmy/src/odi`");
    expect(prompt).toContain("4.0 GB — Worktree wt (done) (check)");
    expect(prompt).not.toContain("Trim WSL disk image");
    expect(prompt).not.toContain("Videos");
  });

  test("a remainder tile: the rest of the folder outside the listed sub-folders", () => {
    const prompt = investigatePrompt(scan, "rest:C:\\Users\\jimmy");
    expect(prompt).toContain("outside the folders the scan lists on their own");
    expect(prompt).toContain("the whole folder");
    expect(prompt).toContain("24 GB of it that is not in a listed sub-folder");
    expect(prompt).toContain("not part of this");
    expect(prompt).toContain("- 90 GB `C:\\Users\\jimmy\\Videos`");
  });

  test("the rest of a drive: from its top", () => {
    const prompt = investigatePrompt(scan, "rest:/");
    expect(prompt).toContain("`/` (a Linux path, inside WSL)");
    expect(prompt).toContain("300 GB");
    expect(prompt).toContain("- 150 GB `/home/jimmy/src`");
    expect(prompt).not.toContain("- 60 GB `/home/jimmy/src/odi`");
  });
});

describe("which folders may be investigated", () => {
  test("a folder the scan reported", () => {
    expect(investigateTarget(scan, "folder:/home/jimmy/src")).toEqual({
      rest: false,
      path: "/home/jimmy/src",
      bytes: 150 * GB,
    });
    expect(investigateTarget(scan, "rest:C:\\")).toEqual({
      rest: true,
      path: "C:\\",
      bytes: 900 * GB,
    });
  });

  test("a path the scan did not report is refused, whatever it looks like", () => {
    for (const key of [
      "folder:/etc",
      "folder:/home/jimmy",
      "rest:C:\\Windows",
      "folder:/home/jimmy/src/../../..",
      "folder:/home/jimmy/src ",
      "folder:",
      "folder:C:",
    ]) {
      expect(investigateTarget(scan, key)).toHaveProperty("error");
      expect(() => investigatePrompt(scan, key)).toThrow();
    }
  });

  test("a key that is neither folder: nor rest:, and no scan at all", () => {
    expect(investigateTarget(scan, "cleanup:x")).toHaveProperty("error");
    expect(investigateTarget(scan, "/home/jimmy/src")).toHaveProperty("error");
    expect(investigateTarget(null, "folder:/home/jimmy/src")).toHaveProperty("error");
    expect(() => investigatePrompt(null, "folder:/home/jimmy/src")).toThrow();
  });
});
