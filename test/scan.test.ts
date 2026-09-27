import { describe, expect, test } from "bun:test";
import { dockerCandidates, parseSystemDf } from "../scan/docker";
import { driveOf, parseDf } from "../scan/drives";
import { bytes, markdown } from "../scan/format";
import { imageFindings } from "../scan/images";
import { databaseFindings, referenced } from "../scan/postgres";
import { parseSize } from "../scan/run";
import { scratchFindings } from "../scan/scratch";
import { isLive, type Running, scratchOwner } from "../scan/sessions";
import type { Scan, SessionInfo } from "../scan/types";
import { parseWorktrees, worktreeCandidate } from "../scan/worktrees";

const DF = `Mounted on        1B-blocks          Used        Avail
/              1081101176832  314952908800  725611884544
/mnt/wsl        16690081792         4096  16690077696
/mnt/c         1002832572416  747054235648  255778336768
/mnt/d         4000768323584 1508349313024 2492419010560
/usr/lib/wsl/drivers 1002832572416 747054235648 255778336768
`;

const nobody: Running = { ids: new Set(), folders: [], known: true };

function session(over: Partial<SessionInfo>): SessionInfo {
  return { id: "s1", title: "t", cwd: "/x", state: "ended", archived: false, ...over };
}

describe("drives", () => {
  test("keeps / and the Windows drives, names them as a person would", () => {
    const drives = parseDf(DF, true);
    expect(drives.map((drive) => drive.label)).toEqual(["WSL", "C:", "D:"]);
    expect(drives[1]?.freeBytes).toBe(255778336768);
  });

  test("a path is on the longest mount that holds it; Windows paths by letter", () => {
    const drives = parseDf(DF, true);
    expect(driveOf("/mnt/d/docker/x", drives)).toBe("D:");
    expect(driveOf("/tmp/claude-1000", drives)).toBe("WSL");
    expect(driveOf("D:/postgresql/data", drives)).toBe("D:");
    expect(driveOf("C:\\Users\\jimmy\\x.vhdx", drives)).toBe("C:");
  });
});

describe("docker", () => {
  test("sizes as Docker writes them", () => {
    expect(parseSize("42.59GB (74%)")).toBeCloseTo(42.59e9);
    expect(parseSize("714.8MB")).toBeCloseTo(714.8e6);
    expect(parseSize("0B")).toBe(0);
  });

  test("dangling and cache are safe; unused tagged images are asked about", () => {
    const df = parseSystemDf(
      [
        '{"Type":"Images","Size":"57.37GB","Reclaimable":"42.59GB (74%)"}',
        '{"Type":"Build Cache","Size":"714.8MB","Reclaimable":"376.3MB"}',
      ].join("\n"),
    );
    const found = dockerCandidates({ ...df, danglingImageBytes: 5.5e9 }, "D:");
    expect(found.map((c) => [c.kind, c.safety])).toEqual([
      ["docker-cache", "safe"],
      ["docker-images", "check"],
    ]);
    expect(found[1]?.bytes).toBeCloseTo(42.59e9 - 5.5e9);
  });
});

describe("disk images", () => {
  const image = {
    distro: "docker-desktop",
    path: "D:\\docker\\DockerDesktopWSL\\disk\\docker_data.vhdx",
    bytes: 822e9,
    allocated: 822e9,
    sparse: false,
  };

  test("a non-sparse image holding much less than it takes is compacted, with downtime", () => {
    const { candidate } = imageFindings(image, 64e9, "D:");
    expect(candidate?.safety).toBe("downtime");
    expect(candidate?.bytes).toBe(758e9);
    expect(candidate?.blockers.join(" ")).toContain("Docker Desktop stops");
  });

  test("a sparse one is only trimmed: nothing stops", () => {
    const { candidate } = imageFindings(
      { ...image, distro: "Ubuntu", sparse: true, allocated: 330e9 },
      302e9,
      "C:",
    );
    expect(candidate?.safety).toBe("safe");
    expect(candidate?.title).toStartWith("Trim");
  });

  test("little slack, or nothing known about the inside: no candidate", () => {
    expect(imageFindings(image, 820e9, "D:").candidate).toBeNull();
    expect(imageFindings(image, null, "D:").candidate).toBeNull();
  });
});

describe("sessions and scratch folders", () => {
  test("a scratch folder names the session it belongs to", () => {
    expect(
      scratchOwner(
        "/tmp/claude-1000/-home-j-src/54d0ac6f-ac5a-499e-ae64-aecd06950589/scratchpad/wt",
      ),
    ).toBe("54d0ac6f-ac5a-499e-ae64-aecd06950589");
    expect(scratchOwner("/home/j/src/lc-nn19")).toBeNull();
  });

  test("a session is live when its process runs, whatever prifly last said", () => {
    const running: Running = { ids: new Set(["s1"]), folders: [], known: true };
    expect(isLive(session({ state: "ended" }), running)).toBe(true);
    expect(isLive(session({ state: "ended" }), nobody)).toBe(false);
    expect(isLive(session({ state: "waiting" }), nobody)).toBe(true);
  });

  test("archived → safe, ended → check, running → not offered", () => {
    const id = (n: number) => `0000000${n}-0000-0000-0000-000000000000`;
    const folders = [1, 2, 3].map((n) => ({
      path: `/tmp/claude-1000/p/${id(n)}`,
      bytes: 1e9,
      session: session({ id: id(n), archived: n === 1 }),
    }));
    const running: Running = { ids: new Set([id(3)]), folders: [], known: true };
    const { candidates, usage } = scratchFindings(folders, running, "WSL");
    expect(candidates.map((c) => c.safety)).toEqual(["safe", "check"]);
    expect(usage.bytes).toBe(3e9);
  });
});

describe("worktrees", () => {
  const PORCELAIN = `worktree /home/j/src/odi
HEAD 76e73c52f
branch refs/heads/master

worktree /home/j/src/odi.worktrees/cleanup
HEAD 76e73c52f
branch refs/heads/cleanup

worktree /home/j/src/odi/.claude/worktrees/agent-a1
HEAD b260141da
branch refs/heads/worktree-agent-a1
locked

worktree /tmp/wt
HEAD 6fe2d4b62
detached
`;

  test("the main checkout is not a worktree; locked and detached are kept apart", () => {
    const trees = parseWorktrees(PORCELAIN, "/home/j/src/odi");
    expect(trees.map((t) => [t.path, t.branch, t.locked])).toEqual([
      ["/home/j/src/odi.worktrees/cleanup", "cleanup", false],
      ["/home/j/src/odi/.claude/worktrees/agent-a1", "worktree-agent-a1", true],
      ["/tmp/wt", "detached HEAD", false],
    ]);
  });

  const tree = { path: "/home/j/src/lc-x", repo: "/home/j/src/lc", branch: "x", locked: false };
  const now = Date.parse("2026-09-26T18:00:00Z");

  test("clean, pushed and quiet for a day is safe", () => {
    const c = worktreeCandidate(
      tree,
      { dirty: 0, unpushed: 0, changedAt: now - 3 * 86_400_000 },
      [],
      1e9,
      "WSL",
      now,
    );
    expect(c.safety).toBe("safe");
  });

  test("uncommitted, unpushed or recently changed is checked first, each said", () => {
    const c = worktreeCandidate(
      tree,
      { dirty: 2, unpushed: 9, changedAt: now - 2 * 3_600_000 },
      [],
      1e9,
      "WSL",
      now,
    );
    expect(c.safety).toBe("check");
    expect(c.blockers).toHaveLength(3);
    expect(c.blockers[2]).toContain("2 hours ago");
  });
});

describe("databases", () => {
  test("a name assigned in a .env is in use; a mention elsewhere is not", () => {
    const envs = [
      "DEVEL_DB=true\nDATABASE_NAME=odi_2026_08_04\n",
      "# odi_2026_05_22 was the old one\n",
    ];
    expect(referenced("odi_2026_08_04", envs)).toBe(true);
    expect(referenced("odi_2026_05_22", envs)).toBe(false);
  });

  test("only big databases nothing names are offered, and never as safe", () => {
    const { candidates } = databaseFindings(
      [
        { name: "odi_2026_08_04", bytes: 968e9 },
        { name: "odi_2026_05_22", bytes: 759e9 },
        { name: "odi_wf150", bytes: 1e6 },
        { name: "postgres", bytes: 8e6 },
      ],
      ["DATABASE_NAME=odi_2026_08_04"],
      "D:",
      "D:/postgresql/data",
    );
    expect(candidates.map((c) => [c.title, c.safety])).toEqual([
      ["Database odi_2026_05_22", "check"],
    ]);
  });
});

describe("format", () => {
  test("two significant figures", () => {
    expect(bytes(759e9)).toBe("759 GB");
    expect(bytes(1.93e9)).toBe("1.9 GB");
    expect(bytes(2.4e12)).toBe("2.4 TB");
  });

  test("the Markdown groups candidates by safety", () => {
    const scan: Scan = {
      at: 0,
      took: 1000,
      drives: [{ mount: "/mnt/d", label: "D:", sizeBytes: 4e12, usedBytes: 2e12, freeBytes: 2e12 }],
      usage: [],
      candidates: [
        {
          id: "a",
          kind: "database",
          title: "Database x",
          path: "p",
          bytes: 1e9,
          drive: "D:",
          safety: "check",
          why: "w",
          blockers: [],
        },
      ],
      notes: ["docker: not running"],
    };
    const text = markdown(scan);
    expect(text).toContain("## check first — 1.0 GB");
    expect(text).toContain("docker: not running");
  });
});
