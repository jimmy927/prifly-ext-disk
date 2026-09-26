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
    60_000,
  );
}

export async function readDatabases(
  config: PostgresConfig,
): Promise<{ dataDirectory: string; databases: DatabaseSize[] }> {
  const rows = await psql(
    config,
    "select datname, pg_database_size(datname) from pg_database where not datistemplate order by 2 desc",
  );
  const dataDirectory = (await psql(config, "show data_directory")).trim();
  const databases = rows
    .trim()
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [name = "", bytes = "0"] = line.split("|");
      return { name, bytes: Number(bytes) };
    });
  return { dataDirectory, databases };
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
