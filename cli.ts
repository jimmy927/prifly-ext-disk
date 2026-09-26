/**
 * `disk-scan`: the drives and what could be cleaned, for a session.
 *
 *   disk-scan            the extension's last scan, as Markdown
 *   disk-scan --fresh    scan now (a minute or so), then print
 *   disk-scan --json     the scan as JSON
 *
 * A fresh scan judges sessions by the list the extension last saw, which is
 * where the archived marks and states come from.
 */

import { dirname } from "node:path";
import { readCache, writeCache } from "./scan/cache";
import { readConfig } from "./scan/config";
import { markdown } from "./scan/format";
import { scan } from "./scan/scan";
import { readArchived, readKnown } from "./scan/sessions";

const folder = dirname(import.meta.path);

async function main(args: string[]): Promise<void> {
  const cached = readCache(folder);
  let result = cached?.scan ?? null;
  if (args.includes("--fresh") || result === null) {
    // prifly's whole list, with the states the extension last saw laid over it.
    const archived = readArchived();
    const byId = new Map(readKnown().map((session) => [session.id, session]));
    for (const session of cached?.sessions ?? []) byId.set(session.id, session);
    const sessions = [...byId.values()].map((session) => ({
      ...session,
      archived: archived.has(session.id),
    }));
    result = await scan({
      sessions,
      config: readConfig(folder),
      windowsFolders: cached?.windows?.usage ?? [],
    });
    writeCache(folder, { scan: result, sessions, windows: cached?.windows ?? null });
  }
  process.stdout.write(
    args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : `${markdown(result)}\n`,
  );
}

await main(process.argv.slice(2));
