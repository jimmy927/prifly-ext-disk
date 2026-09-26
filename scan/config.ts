/** The extension's own settings, from `config.json` beside the manifest. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostgresConfig } from "./postgres";

export type Config = {
  /** Where to look for repositories and their worktrees; the home folder and ~/src by default. */
  roots?: string[];
  /** A local Postgres to look for databases no checkout uses; left out, none is read. */
  postgres?: PostgresConfig;
};

export function readConfig(folder: string): Config {
  const path = join(folder, "config.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}
