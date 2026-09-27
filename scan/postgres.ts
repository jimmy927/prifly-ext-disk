/**
 * Local development databases no checkout points at any more.
 *
 * A checkout names its database in its `.env`; when the checkout goes, its
 * database stays. On 2026-09-26 one such copy of production was 759 GB.
 * Dropping one cannot be undone, so every candidate here is "check".
 * Read only when `postgres` is set in `config.json`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./run";
import type { Candidate, Usage } from "./types";

export type PostgresConfig = { host: string; user: string; port?: number };

export type DatabaseSize = { name: string; bytes: number };

function psql(config: PostgresConfig, sql: string): Promise<string> {
  return run(
    [
      "psql",
      "-h",
      config.host,
      "-p",
      String(config.port ?? 5432),
      "-U",
      config.user,
      "-d",
      "postgres",
      "-w",
      "-Atc",
      sql,
    ],
    // pg_database_size lists every file of every database: a terabyte of
    // them on a drive other things are reading takes a while.
    180_000,
  );
}

/** `a|b` rows from psql -At. */
function rows(out: string): string[][] {
  return out
    .trim()
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => line.split("|"));
}

/** Each database's folder under `base\`, by its oid, from the directory listings. */
export type FolderSizes = (windowsPath: string) => Promise<Map<string, number>>;

/** A query's rows as psql -At prints them; `psql` bound to a config. */
export type Query = (sql: string) => Promise<string>;

export function queryOf(config: PostgresConfig): Query {
  return (sql) => psql(config, sql);
}

/**
 * The databases and their sizes. Postgres names them; their sizes come from
 * `base/<oid>` in the data folder. On a Windows drive that folder is read with
 * `fastdu` from the directory listings (`sizeOnWindows`): `pg_database_size`
 * stats every segment file, and on NTFS that took 50 s for a 979 GB database
 * on 2026-09-27. Anywhere else — or when reading the folder fails, whose
 * reason comes back as `fellBack` — Postgres is asked.
 */
export async function readDatabases(
  query: Query,
  sizeOnWindows: FolderSizes | null,
): Promise<{ dataDirectory: string; databases: DatabaseSize[]; fellBack: string | null }> {
  const dataDirectory = (await query("show data_directory")).trim();
  const onWindows = /^[A-Za-z]:[\\/]/.test(dataDirectory);
  let fellBack: string | null = null;
  if (onWindows && sizeOnWindows !== null) {
    const list = rows(await query("select oid, datname from pg_database where not datistemplate"));
    try {
      const sizes = await sizeOnWindows(`${dataDirectory.replaceAll("/", "\\")}\\base`);
      const databases = list
        .map(([oid = "", name = ""]) => ({ name, bytes: sizes.get(oid) ?? 0 }))
        .sort((a, b) => b.bytes - a.bytes);
      return { dataDirectory, databases, fellBack };
    } catch (error) {
      fellBack = error instanceof Error ? error.message : String(error);
    }
  }
  const sized = rows(
    await query(
      "select datname, pg_database_size(datname) from pg_database where not datistemplate order by 2 desc",
    ),
  );
  return {
    dataDirectory,
    databases: sized.map(([name = "", bytes = "0"]) => ({ name, bytes: Number(bytes) })),
    fellBack,
  };
}

/** Every `.env` in these folders, as text. */
export function envTexts(folders: string[]): string[] {
  return folders
    .map((folder) => join(folder, ".env"))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8"));
}

/** Whether a `.env` assigns exactly this name to some variable. */
export function referenced(name: string, envs: string[]): boolean {
  const assigned = new RegExp(
    `^[A-Z0-9_]+=["']?${name.replace(/[^a-zA-Z0-9_]/g, "\\$&")}["']?\\s*$`,
    "m",
  );
  return envs.some((text) => assigned.test(text));
}

const SYSTEM = new Set(["postgres", "template0", "template1"]);

/** Worth a question from this size up; a small unused one costs nothing. */
const WORTH_ASKING = 1e9;

export function databaseFindings(
  databases: DatabaseSize[],
  envs: string[],
  drive: string,
  dataDirectory: string,
): { usage: Usage; candidates: Candidate[] } {
  const total = databases.reduce((sum, db) => sum + db.bytes, 0);
  const candidates = databases
    .filter((db) => !SYSTEM.has(db.name) && db.bytes >= WORTH_ASKING && !referenced(db.name, envs))
    .map(
      (db): Candidate => ({
        id: `database:${db.name}`,
        kind: "database",
        title: `Database ${db.name}`,
        path: `${dataDirectory} (${db.name})`,
        bytes: db.bytes,
        drive,
        safety: "check",
        why: "no checkout's .env names it",
        blockers: [
          "dropping cannot be undone: it comes back only by importing it again",
          "a checkout or script outside the scanned folders may still use it",
        ],
      }),
    );
  return {
    usage: { drive, path: dataDirectory, bytes: total, what: "Postgres databases" },
    candidates,
  };
}
