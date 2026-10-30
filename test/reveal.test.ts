import { describe, expect, test } from "bun:test";
import {
  fileManagerName,
  type Host,
  localPath,
  revealCommand,
  scannedPath,
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

  test("no path, a non-string, or no scan at all", () => {
    expect(scannedPath(scan([IMAGE]), "")).toHaveProperty("error");
    expect(scannedPath(scan([IMAGE]), 42)).toHaveProperty("error");
    expect(scannedPath(null, IMAGE)).toHaveProperty("error");
  });
});

describe("what is started", () => {
  test("a Windows folder, from WSL and from Windows: Explorer opens it", () => {
    for (const host of [fromWsl, onWindows]) {
      expect(revealCommand(host, "C:\\Users\\jimmy", false)).toEqual({
        program: "explorer",
        args: ["C:\\Users\\jimmy"],
        ignoreExit: true,
      });
    }
  });

  test("a Windows file is selected in its folder", () => {
    expect(revealCommand(fromWsl, IMAGE, true)).toEqual({
      program: "explorer",
      args: [`/select,${IMAGE}`],
      ignoreExit: true,
    });
  });

  test("a Windows path under /mnt, from WSL, is Explorer's C:\\", () => {
    expect(revealCommand(fromWsl, "/mnt/c/Users/jimmy", false)).toEqual({
      program: "explorer",
      args: ["C:\\Users\\jimmy"],
      ignoreExit: true,
    });
    expect(windowsPath(fromWsl, "/mnt/d")).toEqual({ path: "D:\\" });
  });

  test("a WSL folder, from WSL and from Windows, is reached as \\\\wsl$\\<distro>", () => {
    for (const host of [fromWsl, onWindows]) {
      expect(revealCommand(host, "/home/jimmy/src", false)).toEqual({
        program: "explorer",
        args: ["\\\\wsl$\\Ubuntu-20.04\\home\\jimmy\\src"],
        ignoreExit: true,
      });
    }
  });

  test("a WSL file is selected by its \\\\wsl$ path", () => {
    expect(revealCommand(fromWsl, "/home/jimmy/big.bin", true)).toEqual({
      program: "explorer",
      args: ["/select,\\\\wsl$\\Ubuntu-20.04\\home\\jimmy\\big.bin"],
      ignoreExit: true,
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
    expect(revealCommand(onMac, "/Users/jimmy/Library", false)).toEqual({
      program: "open",
      args: ["-R", "/Users/jimmy/Library"],
      ignoreExit: false,
    });
    expect(revealCommand(onMac, "/Applications/Xcode.app", false)).toEqual({
      program: "open",
      args: ["-R", "/Applications/Xcode.app"],
      ignoreExit: false,
    });
    expect(revealCommand(onMac, "/Users/jimmy/big.dmg", true)).toEqual({
      program: "open",
      args: ["-R", "/Users/jimmy/big.dmg"],
      ignoreExit: false,
    });
  });

  test("Linux: xdg-open opens a folder, and a file's folder", () => {
    expect(revealCommand(onLinux, "/var/lib/docker", false)).toEqual({
      program: "xdg-open",
      args: ["/var/lib/docker"],
      ignoreExit: false,
    });
    expect(revealCommand(onLinux, "/var/lib/big.img", true)).toEqual({
      program: "xdg-open",
      args: ["/var/lib"],
      ignoreExit: false,
    });
  });

  test("a Windows path where there is no Windows is an error", () => {
    expect(revealCommand(onLinux, "C:\\Users", false)).toHaveProperty("error");
    expect(revealCommand(onMac, "C:\\Users", false)).toHaveProperty("error");
  });
});

describe("the path to look at on this host", () => {
  test("a Windows path from WSL is under /mnt; a WSL path from Windows is the UNC one", () => {
    expect(localPath(fromWsl, "C:\\Users\\jimmy")).toBe("/mnt/c/Users/jimmy");
    expect(localPath(fromWsl, "/home/jimmy")).toBe("/home/jimmy");
    expect(localPath(onWindows, "C:\\Users")).toBe("C:\\Users");
    expect(localPath(onWindows, "/home/jimmy")).toBe("\\\\wsl$\\Ubuntu-20.04\\home\\jimmy");
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
