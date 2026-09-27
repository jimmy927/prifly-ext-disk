/**
 * What a cleanup session is told: the candidates the reader picked in the
 * Disk space window.
 *
 * A launch key is one candidate's id, or `group:<safety>` for a whole group.
 * The session re-checks each one before touching it
 * — the scan may be half an hour old — and confirms once with the reader,
 * because nobody reviewed a form: the panel starts it at once.
 */

import { bytes, total } from "./format";
import type { Candidate, Safety, Scan } from "./types";

const SAFETIES = new Set<Safety>(["safe", "check", "downtime"]);

/** The candidates a launch key names; empty when none does any more. */
export function chosen(scan: Scan, key: string): Candidate[] {
  if (key.startsWith("group:")) {
    const safety = key.slice("group:".length);
    return SAFETIES.has(safety as Safety)
      ? scan.candidates.filter((candidate) => candidate.safety === safety)
      : [];
  }
  return scan.candidates.filter((candidate) => candidate.id === key);
}

function line(candidate: Candidate): string {
  const blockers =
    candidate.blockers.length === 0 ? "" : `\n  - before: ${candidate.blockers.join("; ")}`;
  return `- ${bytes(candidate.bytes)} on ${candidate.drive} — ${candidate.title} (${candidate.safety}): ${candidate.why}\n  - \`${candidate.path}\`${blockers}`;
}

/** The prompt for a launch key, from the scan it was picked in. */
export function cleanupPrompt(scan: Scan | null, key: string): string {
  if (scan === null) throw new Error("No scan yet: scan first.");
  const picked = chosen(scan, key);
  if (picked.length === 0) throw new Error("That is no longer in the list: scan again.");
  const scanned = new Date(scan.at).toLocaleString("sv-SE");
  return [
    `Clean up disk space: in the Disk space window I chose ${picked.length === 1 ? "this" : `these ${picked.length}`} (${bytes(total(picked))}, scanned ${scanned}). Use the \`disk-cleanup\` skill.`,
    "",
    ...picked.map(line),
    "",
    "Check each one again before touching it: the scan may be out of date, and a session may have started using it since. Leave out what is now in use and say why.",
    "Then confirm once with AskUserQuestion — exactly what will be removed, what is lost, what stops, and what cannot be undone — and save what the `before:` lines say first.",
    "Finish with each drive's free space before and after (`df -h`), and run `disk-scan --fresh` so the Disk space window shows the result.",
  ].join("\n");
}
