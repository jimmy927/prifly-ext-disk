import { describe, expect, test } from "bun:test";
import {
  distroFromScan,
  explorerQuote,
  fileManagerName,
  type Here,
  type Host,
  hostFor,
  localPath,
  type RevealDeps,
  reveal,
  revealCommand,
  scannedPath,
  windowsCommandLine,
  windowsPath,
} from "../scan/reveal";
import type { Scan } from "../scan/types";

const IMAGE = "C:\\Users\\jimmy\\AppData\\Local\\Packages\\Ubuntu20.04\\LocalState\\ext4.vhdx";

const fromWsl: Host = { platform: "linux", wsl: true, distro: "Ubuntu-20.04" };
const onWindows: Host = { platform: "win32", wsl: false, distro: "Ubuntu-20.04" };
const onMac: Host = { platform: "darwin", wsl: false, distro: null };
const onLinux: Host = { platform: "linux", wsl: false, distro: null };

function scan(paths: string[]): Scan {
  return {
    at: 0,
    took: 0,
    drives: [],
    candidates: [],
    notes: [],
    usage: paths.map((path) => ({ drive: "C:", path, bytes: 1, what: "folder" })),
  };
}

/** The scan prifly made on the reader's Windows machine, cut down to the cases. */
const REAL: Scan = {
  at: 0,
  took: 0,
  candidates: [],
  notes: [],
  drives: [
    { mount: "C:\\", label: "C:", sizeBytes: 3, usedBytes: 2, freeBytes: 1 },
    { mount: "/", label: "WSL", sizeBytes: 3, usedBytes: 2, freeBytes: 1 },
  ],
  usage: [
    { drive: "C:", path: "C:\\Program Files", bytes: 1, what: "folder" },
    { drive: "C:", path: IMAGE, bytes: 1, what: "WSL disk image (Ubuntu-20.04)" },
    {
      drive: "C:",
      path: "C:\\Users\\jimmy\\AppData\\Local\\Docker\\wsl\\disk\\docker_data.vhdx",
      bytes: 1,
      what: "Docker Desktop data disk image",
    },
    { drive: "WSL", path: "/home/jimmy/src", bytes: 1, what: "folder" },
  ],
};

describe("which path may be opened", () => {
  test("a path the scan listed", () => {
    expect(scannedPath(scan([IMAGE]), IMAGE)).toEqual({ path: IMAGE });
  });

  test("a path it did not list is refused, whatever it looks like", () => {
    const last = scan([IMAGE]);
    for (const path of ["C:\\Windows", "/etc", `${IMAGE}\\..\\x`, "calc.exe", `${IMAGE} `]) {
      expect(scannedPath(last, path)).toEqual({
        error: "That path is not in the last scan, so it is not opened.",
      });
    }
  });

  test("the top of a drive the scan listed, which a remainder tile is the rest of", () => {
    const last: Scan = {
      ...scan([IMAGE]),
      drives: [
        { mount: "/mnt/c", label: "C:", sizeBytes: 3, usedBytes: 2, freeBytes: 1 },
        { mount: "/", label: "WSL", sizeBytes: 3, usedBytes: 2, freeBytes: 1 },
      ],
    };
    expect(scannedPath(last, "C:\\")).toEqual({ path: "C:\\" });
    expect(scannedPath(last, "/")).toEqual({ path: "/" });
    expect(scannedPath(last, "D:\\")).toHaveProperty("error");
  });

  test("no path, a non-string, or no scan at all", () => {
    expect(scannedPath(scan([IMAGE]), "")).toHaveProperty("error");
    expect(scannedPath(scan([IMAGE]), 42)).toHaveProperty("error");
    expect(scannedPath(null, IMAGE)).toHaveProperty("error");
  });
});

describe("what is started", () => {
  test("a Windows folder, from WSL and from Windows: Explorer opens it", () => {
    expect(revealCommand(fromWsl, "C:\\Users\\jimmy", false)).toEqual({
      program: "explorer",
      args: ["C:\\Users\\jimmy"],
      ignoreExit: true,
      verbatim: false,
    });
    expect(revealCommand(onWindows, "C:\\Users\\jimmy", false)).toEqual({
      program: "explorer",
      args: ["C:\\Users\\jimmy"],
      ignoreExit: true,
      verbatim: true,
    });
  });

  test("a Windows file is selected in its folder", () => {
    expect(revealCommand(fromWsl, IMAGE, true)).toEqual({
      program: "explorer",
      args: [`/select,${IMAGE}`],
      ignoreExit: true,
      verbatim: false,
    });
  });

  test("a Windows path under /mnt, from WSL, is Explorer's C:\\", () => {
    expect(revealCommand(fromWsl, "/mnt/c/Users/jimmy", false)).toEqual({
      program: "explorer",
      args: ["C:\\Users\\jimmy"],
      ignoreExit: true,
      verbatim: false,
    });
    expect(windowsPath(fromWsl, "/mnt/d")).toEqual({ path: "D:\\" });
  });

  test("a WSL folder, from WSL and from Windows, is reached as \\\\wsl.localhost\\<distro>", () => {
    for (const host of [fromWsl, onWindows]) {
      expect(revealCommand(host, "/home/jimmy/src", false)).toMatchObject({
        program: "explorer",
        args: ["\\\\wsl.localhost\\Ubuntu-20.04\\home\\jimmy\\src"],
      });
    }
  });

  test("a WSL file is selected by its \\\\wsl.localhost path", () => {
    expect(revealCommand(fromWsl, "/home/jimmy/big.bin", true)).toMatchObject({
      args: ["/select,\\\\wsl.localhost\\Ubuntu-20.04\\home\\jimmy\\big.bin"],
    });
  });

  test("a WSL path with no known distro says so rather than guessing", () => {
    const lost: Host = { ...fromWsl, distro: null };
    expect(revealCommand(lost, "/home/jimmy", false)).toHaveProperty("error");
    expect(revealCommand({ ...onWindows, distro: "" }, "/home/jimmy", false)).toHaveProperty(
      "error",
    );
  });

  test("macOS: open -R for a folder, a .app bundle and a file, so none is launched", () => {
    for (const path of ["/Users/jimmy/Library", "/Applications/Xcode.app"]) {
      expect(revealCommand(onMac, path, false)).toEqual({
        program: "open",
        args: ["-R", path],
        ignoreExit: false,
        verbatim: false,
      });
    }
    expect(revealCommand(onMac, "/Users/jimmy/big.dmg", true)).toMatchObject({
      args: ["-R", "/Users/jimmy/big.dmg"],
    });
  });

  test("Linux: xdg-open opens a folder, and a file's folder", () => {
    expect(revealCommand(onLinux, "/var/lib/docker", false)).toEqual({
      program: "xdg-open",
      args: ["/var/lib/docker"],
      ignoreExit: false,
      verbatim: false,
    });
    expect(revealCommand(onLinux, "/var/lib/big.img", true)).toMatchObject({
      args: ["/var/lib"],
    });
  });

  test("a Windows path where there is no Windows is an error", () => {
    expect(revealCommand(onLinux, "C:\\Users", false)).toHaveProperty("error");
    expect(revealCommand(onMac, "C:\\Users", false)).toHaveProperty("error");
  });
});

describe("the command line Explorer receives on Windows", () => {
  const EXPLORER = "C:\\Windows\\explorer.exe";
  function line(path: string, isFile: boolean): string {
    const command = revealCommand(onWindows, path, isFile);
    if ("error" in command) throw new Error(command.error);
    expect(command.verbatim).toBe(true);
    return windowsCommandLine([EXPLORER, ...command.args]);
  }

  test("a folder with spaces is quoted as a whole", () => {
    expect(line("C:\\Program Files", false)).toBe('C:\\Windows\\explorer.exe "C:\\Program Files"');
  });

  test("a file is selected with only its path quoted, after /select,", () => {
    const spaced = "C:\\Program Files (x86)\\Steam\\big file.bin";
    expect(line(spaced, true)).toBe(`C:\\Windows\\explorer.exe /select,"${spaced}"`);
    expect(line(IMAGE, true)).toBe(`C:\\Windows\\explorer.exe /select,${IMAGE}`);
  });

  test("a WSL folder through \\\\wsl.localhost", () => {
    expect(line("/home/jimmy/src", false)).toBe(
      "C:\\Windows\\explorer.exe \\\\wsl.localhost\\Ubuntu-20.04\\home\\jimmy\\src",
    );
  });

  test("a drive's other files: C:\\ unquoted, its backslash kept", () => {
    expect(line("C:\\", false)).toBe("C:\\Windows\\explorer.exe C:\\");
  });

  test("commas and semicolons, Explorer's separators, are quoted too", () => {
    expect(explorerQuote("C:\\a,b")).toBe('"C:\\a,b"');
    expect(explorerQuote("C:\\a;b")).toBe('"C:\\a;b"');
    expect(explorerQuote("C:\\plain")).toBe("C:\\plain");
  });
});

describe("the WSL distro", () => {
  const windows: Here = { platform: "win32", wsl: false, envDistro: null };
  function counting(answer: { name: string } | { why: string }) {
    const calls = { n: 0 };
    const lookup = async () => {
      calls.n++;
      return answer;
    };
    return { calls, lookup };
  }

  test("is the scan's WSL disk image's, not Docker Desktop's", () => {
    expect(distroFromScan(REAL)).toBe("Ubuntu-20.04");
  });

  test("is not guessed from a scan with no image, or with two distros' images", () => {
    expect(distroFromScan(scan([IMAGE]))).toBeNull();
    expect(distroFromScan(null)).toBeNull();
    const two: Scan = {
      ...REAL,
      usage: [...REAL.usage, { drive: "C:", path: "x", bytes: 1, what: "WSL disk image (Debian)" }],
    };
    expect(distroFromScan(two)).toBeNull();
  });

  test("is never looked up for a Windows path on Windows", async () => {
    const { calls, lookup } = counting({ name: "Ubuntu-20.04" });
    for (const path of ["C:\\Program Files", IMAGE, "C:\\"]) {
      expect(await hostFor(windows, scan([]), path, lookup)).toEqual({
        platform: "win32",
        wsl: false,
        distro: null,
      });
    }
    expect(calls.n).toBe(0);
  });

  test("comes from the scan for a Linux path, wsl.exe not asked", async () => {
    const { calls, lookup } = counting({ why: "hangs" });
    expect(await hostFor(windows, REAL, "/home/jimmy/src", lookup)).toMatchObject({
      distro: "Ubuntu-20.04",
    });
    expect(calls.n).toBe(0);
  });

  test("is looked up only when the scan does not say, and its failure is the error", async () => {
    const found = counting({ name: "Debian" });
    expect(await hostFor(windows, scan([]), "/home", found.lookup)).toMatchObject({
      distro: "Debian",
    });
    expect(found.calls.n).toBe(1);
    const failed = counting({ why: "wsl.exe did not answer within 5 s" });
    const host = await hostFor(windows, scan([]), "/home", failed.lookup);
    expect(host).toEqual({
      error:
        "The WSL distro that holds /home is not known (wsl.exe did not answer within 5 s), so Explorer cannot reach it.",
    });
  });

  test("under WSL is this distro's own, no lookup", async () => {
    const { calls, lookup } = counting({ name: "other" });
    const here: Here = { platform: "linux", wsl: true, envDistro: "Ubuntu-20.04" };
    expect(await hostFor(here, scan([]), "/home", lookup)).toEqual(fromWsl);
    expect(calls.n).toBe(0);
  });
});

describe("reveal on Windows, with nothing started", () => {
  type Started = { argv: string[]; verbatim: boolean; windowsHide: boolean };
  function deps(kinds: Record<string, "file" | "folder" | null | "hang">, lookupCalls: string[]) {
    const started: Started[] = [];
    /** What happened, in order: "noted" (windows before Explorer), "explorer", "raised". */
    const order: string[] = [];
    const d: RevealDeps = {
      here: { platform: "win32", wsl: false, envDistro: null },
      lookup: async () => {
        lookupCalls.push("lookup");
        return { why: "not to be asked" };
      },
      kind: (path) => {
        const kind = kinds[path];
        if (kind === "hang") return new Promise(() => undefined);
        return Promise.resolve(kind ?? null);
      },
      spawn: (argv, options) => {
        started.push({ argv, verbatim: options.verbatim, windowsHide: options.windowsHide });
        order.push("explorer");
        return { exited: new Promise(() => undefined), stderr: null };
      },
      raise: () => {
        order.push("noted");
        return {
          opened: async () => {
            order.push("raised");
            return "raised (alt key)";
          },
        };
      },
    };
    return { d, started, order };
  }

  test("each case starts Explorer with its command line, at once, wsl.exe never asked", async () => {
    const lookups: string[] = [];
    const { d, started, order } = deps(
      {
        "C:\\Program Files": "folder",
        [IMAGE]: "file",
        "\\\\wsl.localhost\\Ubuntu-20.04\\home\\jimmy\\src": "folder",
        "C:\\": "folder",
      },
      lookups,
    );
    const begun = Date.now();
    for (const path of ["C:\\Program Files", IMAGE, "/home/jimmy/src", "C:\\"])
      await reveal(REAL, path, d);
    // Explorer's exit is not waited for (it never exits here).
    expect(Date.now() - begun).toBeLessThan(500);
    expect(lookups).toEqual([]);
    expect(started.every((each) => each.verbatim)).toBe(true);
    // prifly hides an extension's spawn that names no windowsHide: Explorer must say false.
    expect(started.map((each) => each.windowsHide)).toEqual([false, false, false, false]);
    expect(started.map((each) => windowsCommandLine(each.argv.slice(1)))).toEqual([
      '"C:\\Program Files"',
      `/select,${IMAGE}`,
      "\\\\wsl.localhost\\Ubuntu-20.04\\home\\jimmy\\src",
      "C:\\",
    ]);
    // Explorer's windows are noted before each start, and the new one raised after.
    expect(order).toEqual(Array(4).fill(["noted", "explorer", "raised"]).flat());
  });

  test("a raise that cannot start, fails, throws or never ends never fails the reveal", async () => {
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (text: string) => warned.push(text);
    try {
      const raises: RevealDeps["raise"][] = [
        () => {
          throw new Error("Windows' user32 is only on Windows.");
        },
        () => ({ opened: async () => "not raised: Windows kept the foreground where it was" }),
        () => ({ opened: () => Promise.reject(new Error("FFI call failed")) }),
        () => ({
          opened: () => {
            throw new Error("thrown at once");
          },
        }),
        () => ({ opened: () => new Promise<string>(() => undefined) }),
      ];
      for (const raise of raises) {
        const { d, started } = deps({ "C:\\Program Files": "folder" }, []);
        const begun = Date.now();
        await reveal(REAL, "C:\\Program Files", { ...d, raise });
        expect(Date.now() - begun).toBeLessThan(500);
        expect(started.length).toBe(1);
      }
      await Bun.sleep(0);
      expect(warned).toEqual([
        "Explorer's window is not brought to the front: Windows' user32 is only on Windows.",
        "Explorer's window for C:\\Program Files: not raised: Windows kept the foreground where it was",
        "Explorer's window for C:\\Program Files: not raised: FFI call failed",
        "Explorer's window for C:\\Program Files: not raised: thrown at once",
      ]);
    } finally {
      console.warn = warn;
    }
  });

  test("no raise is begun when Explorer cannot be started", async () => {
    const { d, order } = deps({ "C:\\Program Files": "folder" }, []);
    const broken: RevealDeps = {
      ...d,
      spawn: () => {
        throw new Error("ENOENT");
      },
    };
    await expect(reveal(REAL, "C:\\Program Files", broken)).rejects.toThrow("ENOENT");
    expect(order).toEqual(["noted"]);
  });

  test("a WSL share that does not answer fails in seconds, with why", async () => {
    const { d, started } = deps(
      { "\\\\wsl.localhost\\Ubuntu-20.04\\home\\jimmy\\src": "hang" },
      [],
    );
    const begun = Date.now();
    await expect(reveal(REAL, "/home/jimmy/src", d)).rejects.toThrow(
      "\\\\wsl.localhost\\Ubuntu-20.04\\home\\jimmy\\src did not answer within 2 s: WSL's file share is stopped or slow.",
    );
    expect(Date.now() - begun).toBeLessThan(3000);
    expect(started).toEqual([]);
  });

  test("a path that is gone, or a program that cannot start, says so", async () => {
    const { d } = deps({}, []);
    await expect(reveal(REAL, "C:\\Program Files", d)).rejects.toThrow(
      "C:\\Program Files is gone.",
    );
    const broken: RevealDeps = {
      ...deps({ "C:\\Program Files": "folder" }, []).d,
      spawn: () => {
        throw new Error("ENOENT");
      },
    };
    await expect(reveal(REAL, "C:\\Program Files", broken)).rejects.toThrow(
      "could not be started: ENOENT",
    );
  });
});

describe("off Windows", () => {
  test("no raise of Explorer's window is begun", async () => {
    for (const here of [
      { platform: "linux" as const, wsl: true, envDistro: "Ubuntu-20.04" },
      { platform: "darwin" as const, wsl: false, envDistro: null },
      { platform: "linux" as const, wsl: false, envDistro: null },
    ]) {
      let begun = 0;
      const d: RevealDeps = {
        here,
        lookup: async () => ({ why: "unused" }),
        kind: async () => "folder",
        spawn: () => ({ exited: Promise.resolve(0), stderr: null }),
        raise: () => {
          begun += 1;
          return { opened: async () => "raised (alt key)" };
        },
      };
      await reveal(scan(["/home/jimmy/src"]), "/home/jimmy/src", d);
      expect(begun).toBe(0);
    }
  });
});

describe("the path to look at on this host", () => {
  test("a Windows path from WSL is under /mnt; a WSL path from Windows is the UNC one", () => {
    expect(localPath(fromWsl, "C:\\Users\\jimmy")).toBe("/mnt/c/Users/jimmy");
    expect(localPath(fromWsl, "/home/jimmy")).toBe("/home/jimmy");
    expect(localPath(onWindows, "C:\\Users")).toBe("C:\\Users");
    expect(localPath(onWindows, "/home/jimmy")).toBe(
      "\\\\wsl.localhost\\Ubuntu-20.04\\home\\jimmy",
    );
    expect(localPath(onLinux, "C:\\Users")).toBeNull();
  });
});

describe("the file manager's name", () => {
  test("Explorer on Windows and under WSL, Finder on a Mac, Files elsewhere", () => {
    expect(fileManagerName(onWindows)).toBe("Explorer");
    expect(fileManagerName(fromWsl)).toBe("Explorer");
    expect(fileManagerName(onMac)).toBe("Finder");
    expect(fileManagerName(onLinux)).toBe("Files");
  });
});
