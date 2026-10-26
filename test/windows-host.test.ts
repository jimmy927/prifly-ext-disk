import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveOf, parseLogicalDisks } from "../scan/drives";
import { inUse, readRunning, scratchOwner, sessionsIn } from "../scan/sessions";
import { parseDistros, pickDistro } from "../scan/wsl";

/** `wsl.exe -l -v` as it comes out: UTF-16, so a NUL after every character. */
const WSL_LIST = [
  "  NAME              STATE           VERSION",
  "* Ubuntu-20.04      Running         2",
  "  docker-desktop    Running         2",
  "",
]
  .join("\r\n")
  .split("")
  .join("\0");

describe("WSL from Windows", () => {
  test("the distros, the default marked", () => {
    expect(parseDistros(WSL_LIST)).toEqual([
      { name: "Ubuntu-20.04", running: true, isDefault: true },
      { name: "docker-desktop", running: true, isDefault: false },
    ]);
  });

  test("the default distro is walked; Docker's never, a stopped one is not started", () => {
    expect(pickDistro(parseDistros(WSL_LIST))).toEqual({ name: "Ubuntu-20.04" });
    expect(
      pickDistro([
        { name: "docker-desktop", running: true, isDefault: true },
        { name: "Ubuntu", running: false, isDefault: false },
      ]),
    ).toEqual({ why: "Ubuntu is stopped, and a scan does not start it" });
    expect(pickDistro([{ name: "docker-desktop", running: true, isDefault: true }])).toEqual({
      why: "no WSL distro is installed",
    });
  });
});

describe("Windows itself", () => {
  test("the fixed drives, and a Linux path on the WSL drive", () => {
    const drives = parseLogicalDisks('[{"DeviceID":"C:","Size":1000,"FreeSpace":200}]');
    expect(drives).toEqual([
      { mount: "C:\\", label: "C:", sizeBytes: 1000, usedBytes: 800, freeBytes: 200 },
    ]);
    const wsl = { mount: "/", label: "WSL", sizeBytes: 1, usedBytes: 1, freeBytes: 0 };
    expect(driveOf("C:\\Users\\j", [...drives, wsl])).toBe("C:");
    expect(driveOf("/home/j", [...drives, wsl])).toBe("WSL");
  });

  test("a Windows scratch folder names its session", () => {
    expect(
      scratchOwner(
        "C:\\Users\\j\\AppData\\Local\\Temp\\claude\\C--Users-j-src\\54d0ac6f-ac5a-499e-ae64-aecd06950589\\scratchpad",
      ),
    ).toBe("54d0ac6f-ac5a-499e-ae64-aecd06950589");
  });

  test("git's C:/ paths and Windows' C:\\ paths are the same folders, in any case", () => {
    expect(inUse("C:/Users/j/src/wt", ["c:\\users\\j\\src\\wt\\sub"])).toBe(true);
    expect(inUse("C:/Users/j/src/wt", ["C:\\Users\\j\\src\\wt-2"])).toBe(false);
    const session = {
      id: "s",
      title: "",
      cwd: "C:\\Users\\j\\src\\wt",
      state: "ended",
      archived: false,
    };
    expect(sessionsIn("C:/Users/j/src/wt", [session])).toHaveLength(1);
  });

  test("no /proc: a session runs while its process lives, and works in its folder", async () => {
    const files = mkdtempSync(join(tmpdir(), "disk-sessions-"));
    writeFileSync(
      join(files, "1.json"),
      JSON.stringify({ pid: process.pid, sessionId: "alive", cwd: "C:\\a" }),
    );
    writeFileSync(
      join(files, "2.json"),
      JSON.stringify({ pid: 2 ** 22 + 7, sessionId: "gone", cwd: "C:\\b" }),
    );
    const running = await readRunning(null, files);
    expect(running.known).toBe(true);
    expect([...running.ids]).toEqual(["alive"]);
    expect(running.folders).toEqual(["C:\\a"]);
  });
});
