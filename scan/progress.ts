/**
 * How far a scan has got, part by part — what the window shows while it runs:
 * "Linux folders · 812,406 files · 31 GB · 5 s", "Windows folders · waiting".
 */

export type PartState = "waiting" | "running" | "done" | "failed" | "skipped";

export type Part = {
  name: string;
  state: PartState;
  /** What it has counted or found: "1,139,143 files · 50 GB", or why it failed. */
  detail: string;
  /** When it started, epoch ms, or 0 while waiting. */
  startedAt: number;
  /** How long it took, once finished. */
  ms: number;
};

export class Progress {
  readonly parts: Part[];
  private readonly changed: (parts: Part[]) => void;

  constructor(names: readonly string[], changed: (parts: Part[]) => void) {
    this.parts = names.map((name) => ({ name, state: "waiting", detail: "", startedAt: 0, ms: 0 }));
    this.changed = changed;
  }

  private part(name: string): Part {
    const part = this.parts.find((each) => each.name === name);
    if (part === undefined) throw new Error(`No scan part called ${name}`);
    return part;
  }

  private set(name: string, fields: Partial<Part>): void {
    Object.assign(this.part(name), fields);
    this.changed(this.parts.map((part) => ({ ...part })));
  }

  start(name: string): void {
    this.set(name, { state: "running", startedAt: Date.now(), detail: "" });
  }

  update(name: string, detail: string): void {
    this.set(name, { detail });
  }

  finish(name: string, state: "done" | "failed" | "skipped", detail: string): void {
    const part = this.part(name);
    this.set(name, { state, detail, ms: part.startedAt === 0 ? 0 : Date.now() - part.startedAt });
  }

  /**
   * Run one part: it is marked running, then done with what it says, or failed
   * with its error — which becomes a note, and the rest of the scan goes on.
   */
  async run<T>(
    name: string,
    notes: string[],
    work: () => Promise<{ value: T; detail: string }>,
  ): Promise<T | null> {
    this.start(name);
    try {
      const { value, detail } = await work();
      this.finish(name, "done", detail);
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish(name, "failed", message);
      notes.push(`${name.toLowerCase()}: ${message}`);
      return null;
    }
  }
}

/** "1,139,143 files · 50 GB" — the count exact, the size to two significant figures. */
export function counted(files: number, bytes: string): string {
  return `${files.toLocaleString("en-US")} files · ${bytes}`;
}
