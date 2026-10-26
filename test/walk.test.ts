import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxFolders, windowsUsage } from "../scan/folders";
import { counted, type Part, Progress } from "../scan/progress";
import { interopFailed, interopRetry, run } from "../scan/run";
import { sizerOf, walk } from "../scan/walk";
import { parseFolders, parseProgress, walkFailed } from "../scan/windows/fastdu";

/** A tree with nesting, an empty folder, and a file under two names. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "disk-walk-"));
  mkdirSync(join(root, "a", "b", "c"), { recursive: true });
  mkdirSync(join(root, "empty"));
  writeFileSync(join(root, "top.bin"), Buffer.alloc(10_000));
  writeFileSync(join(root, "a", "one.bin"), Buffer.alloc(200_000));
  writeFileSync(join(root, "a", "b", "c", "deep.bin"), Buffer.alloc(50_000));
  writeFileSync(join(root, "a", "b", "linked.bin"), Buffer.alloc(300_000));
  linkSync(join(root, "a", "b", "linked.bin"), join(root, "empty", "same.bin"));
  return root;
}

async function du(path: string): Promise<number> {
  return Number((await run(["du", "-sx", "--block-size=1", path])).split("\t")[0]);
}

describe("the Linux walk", () => {
  test("every folder's size is what du says, a hard-linked file counted once", async () => {
    const root = tree();
    const { sizes, progress } = await walk([root], () => undefined, 4);
    expect(sizes.get(root)).toBe(await du(root));
    // A folder's own blocks are counted in it, as du does.
    expect(sizes.get(join(root, "a", "b", "c"))).toBe(await du(join(root, "a", "b", "c")));
    // The file with two names is counted once, under whichever name was met
    // first — as du does, whose order of meeting them may differ.
    const both = [join(root, "a", "b"), join(root, "empty")];
    const walked = both.reduce((sum, path) => sum + (sizes.get(path) ?? 0), 0);
    // One du over both counts the file once, as the walk does.
    const together = (await run(["du", "-scx", "--block-size=1", ...both]))
      .trim()
      .split("\n")
      .at(-1);
    expect(walked).toBe(Number(together?.split("\t")[0]));
    // top, one, deep, and the linked file once.
    expect(progress.files).toBe(4);
  });

  test("one thread and many agree", async () => {
    const root = tree();
    const one = await walk([root], () => undefined, 1);
    const many = await walk([root], () => undefined, 8);
    expect([...many.sizes].sort()).toEqual([...one.sizes].sort());
  });

  test("a folder the walk did not cover is measured on its own", async () => {
    const root = tree();
    const size = sizerOf(new Map([[join(root, "a"), 42]]));
    const got = await size([join(root, "a"), join(root, "empty")]);
    expect(got.get(join(root, "a"))).toBe(42);
    // On Windows fastdu.exe measures it, in file lengths as the Windows walk does.
    const own = process.platform === "win32" ? 300_000 : await du(join(root, "empty"));
    expect(got.get(join(root, "empty"))).toBe(own);
  });
});

describe("what takes the space", () => {
  test("Linux folders down to two levels below a root, 1 GB and up", () => {
    const sizes = new Map([
      ["/home/j", 90e9],
      ["/home/j/src", 60e9],
      ["/home/j/src/odi", 7e9],
      ["/home/j/src/odi/node_modules", 2e9],
      ["/home/j/.cache", 0.5e9],
    ]);
    const paths = linuxFolders(sizes, ["/home/j"], () => "WSL").map((usage) => usage.path);
    expect(paths.sort()).toEqual(["/home/j/src", "/home/j/src/odi"]);
  });

  test("Windows folders, the drive itself left to the drive bar", () => {
    const folders = parseFolders(
      "1566891619631\t207354\tD:\r\n979119997766\t28306\tD:\\postgresql\r\n2000000000\t12\tD:\\postgresql\\data\r\n",
    );
    expect(folders.map((folder) => folder.depth)).toEqual([0, 1, 2]);
    expect(windowsUsage(folders).map((usage) => [usage.drive, usage.path])).toEqual([
      ["D:", "D:\\postgresql"],
      ["D:", "D:\\postgresql\\data"],
    ]);
  });

  test("fastdu's progress lines, and nothing else, are progress", () => {
    expect(parseProgress("progress\t566239\t2032565\t2326327466453\r")).toEqual({
      dirs: 566239,
      files: 2032565,
      bytes: 2326327466453,
    });
    expect(parseProgress("usage: fastdu <depth> …")).toBeNull();
  });
});

test("fastdu exiting 1 over an unreadable folder still walked; with nothing printed it did not", () => {
  expect(walkFailed({ out: "123\t4\tC:\n", code: 0 })).toBe(false);
  expect(walkFailed({ out: "123\t4\tC:\n", code: 1 })).toBe(false);
  expect(walkFailed({ out: "", code: 1 })).toBe(true);
  expect(walkFailed({ out: "123\t4\tC:\n", code: 2 })).toBe(true);
});

test("a program WSL could not start is started again, up to three times; other failures are not", async () => {
  const interop = "<3>WSL (2946390 - ) ERROR: UtilAcceptVsock:273: accept4 failed 110";
  let calls = 0;
  const got = await interopRetry(
    async () => {
      calls += 1;
      return calls < 3 ? { code: 1, errors: interop } : { code: 0, errors: "" };
    },
    (done) => (done.code === 0 ? null : done.errors),
  );
  expect(got.code).toBe(0);
  expect(calls).toBe(3);
  let once = 0;
  await interopRetry(
    async () => {
      once += 1;
      return { code: 2, errors: "usage" };
    },
    (done) => done.errors,
  );
  expect(once).toBe(1);
});

test("only WSL failing to start a Windows program is worth starting it again", () => {
  expect(interopFailed("<3>WSL (2289041 - ) ERROR: UtilAcceptVsock:273: accept4 failed 110")).toBe(
    true,
  );
  expect(interopFailed("fastdu exited 2: usage: fastdu <depth> …")).toBe(false);
});

describe("progress", () => {
  test("a part runs, finishes with what it found, and a failure becomes a note", async () => {
    const seen: Part[][] = [];
    const progress = new Progress(["Linux folders", "Docker"], (parts) => seen.push(parts));
    const notes: string[] = [];
    expect(
      await progress.run("Linux folders", notes, async () => ({ value: 7, detail: "7 files" })),
    ).toBe(7);
    expect(
      await progress.run("Docker", notes, async () => {
        throw new Error("docker: not running");
      }),
    ).toBeNull();
    expect(seen.at(-1)?.map((part) => [part.name, part.state, part.detail])).toEqual([
      ["Linux folders", "done", "7 files"],
      ["Docker", "failed", "docker: not running"],
    ]);
    expect(notes).toEqual(["docker: docker: not running"]);
    expect(seen[0]?.[0]?.state).toBe("running");
  });

  test("counts stay exact", () => {
    expect(counted(1139143, "50 GB")).toBe("1,139,143 files · 50 GB");
  });
});
