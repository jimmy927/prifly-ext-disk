import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeWalk } from "../scan/linux/fastdu";
import { run } from "../scan/run";
import { walk } from "../scan/walk";

/** Nesting, an empty folder, a file under two names, and many files in one folder. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "disk-native-"));
  mkdirSync(join(root, "a", "b", "c"), { recursive: true });
  mkdirSync(join(root, "empty"));
  mkdirSync(join(root, "many"));
  for (let i = 0; i < 3000; i++) writeFileSync(join(root, "many", `f${i}`), `${i}`);
  writeFileSync(join(root, "a", "one.bin"), Buffer.alloc(200_000));
  writeFileSync(join(root, "a", "b", "c", "deep.bin"), Buffer.alloc(50_000));
  writeFileSync(join(root, "a", "b", "linked.bin"), Buffer.alloc(300_000));
  linkSync(join(root, "a", "b", "linked.bin"), join(root, "empty", "same.bin"));
  return root;
}

async function du(path: string): Promise<number> {
  return Number((await run(["du", "-sx", "--block-size=1", path])).split("\t")[0]);
}

describe("fastdu in C, on Linux", () => {
  test("totals are du's to the byte, hard links once, on one thread and on many", async () => {
    const root = tree();
    for (const threads of [1, 8]) {
      const { sizes, progress } = await nativeWalk([root], () => undefined, threads, 0);
      expect(sizes.get(root)).toBe(await du(root));
      expect(sizes.get(join(root, "many"))).toBe(await du(join(root, "many")));
      expect(sizes.get(join(root, "a", "b", "c"))).toBe(await du(join(root, "a", "b", "c")));
      // 3000 + one + deep + the linked file once.
      expect(progress.files).toBe(3003);
    }
  });

  test("it and the TypeScript walk agree", async () => {
    const root = tree();
    const native = await nativeWalk([root], () => undefined, 4, 0);
    const typescript = await walk([root], () => undefined, 4);
    // Folders holding one of the linked file's two names are left out: which
    // name counts depends on which thread meets it first, in either walk.
    for (const path of [root, join(root, "many"), join(root, "a", "b", "c")]) {
      expect(native.sizes.get(path)).toBe(typescript.sizes.get(path));
    }
  });

  test("small folders are left out above the size asked for", async () => {
    const root = tree();
    const { sizes } = await nativeWalk([root], () => undefined, 2, 150_000);
    expect(sizes.has(join(root, "a"))).toBe(true);
    expect(sizes.has(join(root, "a", "b", "c"))).toBe(false);
  });
});
