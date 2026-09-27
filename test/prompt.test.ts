import { describe, expect, test } from "bun:test";
import { chosen, cleanupPrompt } from "../scan/prompt";
import type { Candidate, Scan } from "../scan/types";

function candidate(over: Partial<Candidate>): Candidate {
  return {
    id: "scratch:/tmp/claude-1000/p/a",
    kind: "scratch",
    title: "Scratch folder of “a”",
    path: "/tmp/claude-1000/p/a",
    bytes: 1.9e9,
    drive: "WSL",
    safety: "safe",
    why: "the session is archived",
    blockers: [],
    ...over,
  };
}

const scan: Scan = {
  at: Date.parse("2026-09-26T17:00:00Z"),
  took: 70_000,
  drives: [],
  usage: [],
  candidates: [
    candidate({}),
    candidate({
      id: "worktree:/home/j/src/lc-xrust",
      kind: "worktree",
      title: "Worktree lc-xrust (rust-explore-fixes)",
      path: "/home/j/src/lc-xrust",
      bytes: 387e6,
      safety: "check",
      why: "no session works in it",
      blockers: [
        "6 uncommitted change(s): save them before removing",
        "9 commit(s) not pushed: push or bundle them first",
      ],
    }),
    candidate({
      id: "database:odi_old",
      kind: "database",
      title: "Database odi_old",
      safety: "check",
      bytes: 759e9,
      drive: "D:",
    }),
  ],
  notes: [],
};

describe("which candidates a launch key names", () => {
  test("one by its id, a group by its safety", () => {
    expect(chosen(scan, "worktree:/home/j/src/lc-xrust").map((c) => c.id)).toEqual([
      "worktree:/home/j/src/lc-xrust",
    ]);
    expect(chosen(scan, "group:check")).toHaveLength(2);
  });

  test("a key naming nothing, or a group that is no safety, names nothing", () => {
    expect(chosen(scan, "worktree:/gone")).toEqual([]);
    expect(chosen(scan, "group:everything")).toEqual([]);
  });
});

describe("the prompt a cleanup session starts with", () => {
  test("one candidate: its path, size and what must be saved first, then one confirmation", () => {
    const prompt = cleanupPrompt(scan, "worktree:/home/j/src/lc-xrust");
    expect(prompt).toContain("I chose this (387 MB");
    expect(prompt).toContain("`/home/j/src/lc-xrust`");
    expect(prompt).toContain("before: 6 uncommitted change(s)");
    expect(prompt).toContain("confirm once with AskUserQuestion");
    expect(prompt).toContain("disk-cleanup");
    expect(prompt).not.toContain("odi_old");
  });

  test("a group lists every member and their total", () => {
    const prompt = cleanupPrompt(scan, "group:check");
    expect(prompt).toContain("these 2 (759 GB");
    expect(prompt).toContain("Database odi_old");
    expect(prompt).toContain("lc-xrust");
  });

  test("something no longer listed, or no scan yet, starts nothing", () => {
    expect(() => cleanupPrompt(scan, "worktree:/gone")).toThrow("no longer in the list");
    expect(() => cleanupPrompt(null, "group:safe")).toThrow("No scan yet");
  });
});
