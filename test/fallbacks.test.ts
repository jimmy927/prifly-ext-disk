import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDatabases } from "../scan/postgres";
import { gateOnLiveness } from "../scan/scan";
import { readRunning } from "../scan/sessions";
import type { Candidate } from "../scan/types";
import { slowScript, windowsFoldersOrSlow } from "../scan/windows/slowdu";

function candidate(kind: Candidate["kind"]): Candidate {
  return {
    id: `${kind}:x`,
    kind,
    title: kind,
    path: "/x",
    bytes: 1e9,
    drive: "WSL",
    safety: "safe",
    why: "",
    blockers: [],
  };
}

describe("liveness", () => {
  test("no /proc to read: not known, rather than nothing running", async () => {
    const empty = mkdtempSync(join(tmpdir(), "disk-noproc-"));
    expect(await readRunning(empty, empty)).toEqual({ ids: new Set(), folders: [], known: false });
  });

  test("a /proc to read: known, and a session whose process lives is running", async () => {
    const proc = mkdtempSync(join(tmpdir(), "disk-proc-"));
    mkdirSync(join(proc, "self"));
    mkdirSync(join(proc, "4242"));
    const files = mkdtempSync(join(tmpdir(), "disk-sessions-"));
    writeFileSync(
      join(files, "4242.json"),
      JSON.stringify({ pid: 4242, sessionId: "alive", cwd: "/a" }),
    );
    writeFileSync(
      join(files, "999.json"),
      JSON.stringify({ pid: 999, sessionId: "gone", cwd: "/b" }),
    );
    const running = await readRunning(proc, files);
    expect(running.known).toBe(true);
    expect([...running.ids]).toEqual(["alive"]);
  });

  test("not known: no scratch folder or worktree is offered; the rest stays", () => {
    const all = (["scratch", "worktree", "docker-cache", "disk-image", "database"] as const).map(
      candidate,
    );
    expect(gateOnLiveness(all, true)).toHaveLength(5);
    expect(gateOnLiveness(all, false).map((c) => c.kind)).toEqual([
      "docker-cache",
      "disk-image",
      "database",
    ]);
  });
});

describe("Windows folders without fastdu", () => {
  const folder = { path: "C:\\Users", bytes: 5e11, files: 10, depth: 1 };

  test("fastdu works: it is used, and nothing is said", async () => {
    let slowRan = false;
    const told: string[] = [];
    const got = await windowsFoldersOrSlow(
      ["C:"],
      () => undefined,
      (reason) => told.push(reason),
      async () => [folder],
      async () => {
        slowRan = true;
        return [];
      },
    );
    expect(got).toEqual({ folders: [folder], fellBack: null });
    expect([slowRan, told]).toEqual([false, []]);
  });

  test("fastdu fails: PowerShell reads them, and why is said before it starts", async () => {
    const told: string[] = [];
    const got = await windowsFoldersOrSlow(
      ["C:"],
      () => undefined,
      (reason) => told.push(reason),
      async () => {
        throw new Error("csc.exe not found");
      },
      async () => [folder],
    );
    expect(got).toEqual({ folders: [folder], fellBack: "csc.exe not found" });
    expect(told).toEqual(["csc.exe not found"]);
  });

  test("the PowerShell walk prints what fastdu prints, and progress the same way", () => {
    const script = slowScript(["C:", "D:"]);
    expect(script).toContain('@("C:","D:")');
    expect(script).toContain("progress`t0`t$files`t$bytes");
    expect(script).toContain("-Attributes !ReparsePoint");
  });
});

describe("database sizes without their folders", () => {
  /** psql's answers, by the start of the query. */
  function postgres(answers: Record<string, string>, asked: string[]) {
    return async (sql: string) => {
      asked.push(sql);
      const key = Object.keys(answers).find((start) => sql.startsWith(start));
      if (key === undefined) throw new Error(`unexpected query: ${sql}`);
      return answers[key] ?? "";
    };
  }
  const answers = {
    "show data_directory": "D:/postgresql/data\n",
    "select oid, datname": "16384|odi_2026_08_04\n5|postgres\n",
    "select datname, pg_database_size": "odi_2026_08_04|967600000000\npostgres|6935011\n",
  };

  test("the folders read: sizes from them, Postgres not asked to size", async () => {
    const asked: string[] = [];
    const got = await readDatabases(postgres(answers, asked), async (base) => {
      expect(base).toBe("D:\\postgresql\\data\\base");
      return new Map([
        ["16384", 967_600_000_000],
        ["5", 7_000_000],
      ]);
    });
    expect(got.fellBack).toBeNull();
    expect(got.databases[0]).toEqual({ name: "odi_2026_08_04", bytes: 967_600_000_000 });
    expect(asked.some((sql) => sql.includes("pg_database_size"))).toBe(false);
  });

  test("reading the folders fails: Postgres sizes them, and why is kept", async () => {
    const asked: string[] = [];
    const got = await readDatabases(postgres(answers, asked), async () => {
      throw new Error("fastdu exited 1");
    });
    expect(got.fellBack).toBe("fastdu exited 1");
    expect(got.databases).toEqual([
      { name: "odi_2026_08_04", bytes: 967_600_000_000 },
      { name: "postgres", bytes: 6935011 },
    ]);
  });
});
