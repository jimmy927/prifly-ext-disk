/** A scan in words: for the launcher and `bin/disk-scan`. */

import type { Candidate, Safety, Scan } from "./types";

/** Two significant figures, in the unit that keeps the number small. */
export function bytes(n: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = value >= 100 ? Math.round(value).toString() : value.toPrecision(2);
  return `${shown} ${units[unit]}`;
}

const SAFETY_WORDS: Record<Safety, string> = {
  safe: "safe",
  check: "check first",
  downtime: "needs downtime",
};

export function total(candidates: Candidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
}

/** The whole scan as Markdown: drives, then candidates by safety, then notes. */
export function markdown(scan: Scan): string {
  const lines = [
    `Scanned ${new Date(scan.at).toLocaleString("sv-SE")} in ${Math.round(scan.took / 1000)} s.`,
    "",
  ];
  lines.push("| Drive | Free | Size | Used |", "|---|---|---|---|");
  for (const drive of scan.drives) {
    lines.push(
      `| ${drive.label} | ${bytes(drive.freeBytes)} | ${bytes(drive.sizeBytes)} | ${Math.round((100 * drive.usedBytes) / drive.sizeBytes)} % |`,
    );
  }
  for (const safety of ["safe", "check", "downtime"] as const) {
    const group = scan.candidates.filter((candidate) => candidate.safety === safety);
    if (group.length === 0) continue;
    lines.push("", `## ${SAFETY_WORDS[safety]} — ${bytes(total(group))}`, "");
    for (const candidate of group) lines.push(candidateLine(candidate));
  }
  if (scan.notes.length > 0) lines.push("", "Not read:", ...scan.notes.map((note) => `- ${note}`));
  return lines.join("\n");
}

function candidateLine(candidate: Candidate): string {
  const blockers = candidate.blockers.length === 0 ? "" : ` — ${candidate.blockers.join("; ")}`;
  return `- **${bytes(candidate.bytes)}** on ${candidate.drive} — ${candidate.title} — ${candidate.why}${blockers}  \n  \`${candidate.path}\` (id \`${candidate.id}\`)`;
}
