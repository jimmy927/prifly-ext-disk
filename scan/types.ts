/**
 * What a scan finds: the drives, what takes their space, and what could be
 * cleaned. The panel draws it, the status bar sums it up, and `bin/disk-scan`
 * hands it to the cleanup skill.
 */

export type Drive = {
  /** Where it is mounted here: "/" or "/mnt/c". */
  mount: string;
  /** How a person names it: "WSL", "C:". */
  label: string;
  sizeBytes: number;
  usedBytes: number;
  freeBytes: number;
};

/** One thing taking space, for the "what takes what" view. */
export type Usage = {
  /** The drive label it lives on. */
  drive: string;
  path: string;
  bytes: number;
  /** A few words: "WSL disk image", "session scratch folders". */
  what: string;
};

/**
 * How careful removing it has to be.
 * - safe: nothing is lost that is not kept elsewhere (pushed, archived, rebuilt on demand)
 * - check: something may be lost; a person has to look first
 * - downtime: nothing is lost, but services or sessions stop while it runs
 */
export type Safety = "safe" | "check" | "downtime";

export type CandidateKind =
  | "disk-image"
  | "docker-cache"
  | "docker-images"
  | "scratch"
  | "worktree"
  | "database";

/** Something the cleanup skill can offer to remove or shrink. */
export type Candidate = {
  /** Stable across scans: kind plus path. */
  id: string;
  kind: CandidateKind;
  title: string;
  path: string;
  /** Roughly what removing it gives back. */
  bytes: number;
  /** The drive the bytes come back on. */
  drive: string;
  safety: Safety;
  /** Why it is a candidate, in one line. */
  why: string;
  /** What has to be true, or saved, before it goes. */
  blockers: string[];
};

export type Scan = {
  /** Epoch ms. */
  at: number;
  /** How long the scan took, ms. */
  took: number;
  drives: Drive[];
  usage: Usage[];
  candidates: Candidate[];
  /** What could not be looked at, and why: "docker: not running". */
  notes: string[];
};

/** A session as the cleanup cares about it. */
export type SessionInfo = {
  id: string;
  title: string;
  cwd: string;
  /** prifly's state: "working", "waiting", "ended", … */
  state: string;
  archived: boolean;
};
