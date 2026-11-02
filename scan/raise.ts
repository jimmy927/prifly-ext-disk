/**
 * Bringing the Explorer window "Show in Explorer" opened to the front, on
 * Windows. prifly's host runs this extension as a windowless background
 * process, and Windows' foreground lock keeps a window such a process starts
 * from taking the foreground: Explorer opened behind every other window, seen
 * only in the taskbar.
 *
 * Before Explorer starts, the Explorer windows already open are noted; after,
 * the first new one to show within `RAISE_MS` is raised, once — a synthetic
 * Alt key press, which lifts the foreground lock, then `SetForegroundWindow`,
 * then `AttachThreadInput` to the foreground thread if that was refused.
 * Nothing is raised after `RAISE_MS`, so the focus is never taken later.
 *
 * user32 is called in this process through `bun:ffi`, not from a PowerShell
 * helper: PowerShell took 5 s only to start on a busy machine (2026-11-02,
 * load 20), by when the reader has moved on. No program is started, so no
 * path is ever part of a command line.
 */

import type { Pointer } from "bun:ffi";

/** How long after Explorer starts its new window may still be raised. */
export const RAISE_MS = 3000;

/** How often the open Explorer windows are looked at while waiting. */
const POLL_MS = 100;

/** How a window came to the front, or null where Windows refused. */
export type Raised = "already in front" | "alt key" | "attached input" | null;

/** The windows this needs, as Windows' user32 has them; a test replaces it. */
export type Desktop = {
  /** The visible top-level Explorer windows (class `CabinetWClass`), as handles. */
  explorers: () => number[];
  /** Brings `window` to the front, restored if it was minimised. */
  raise: (window: number) => Raised;
};

/** The first of `now` that is not in `before`: the window Explorer just opened. */
export function newWindow(before: ReadonlySet<number>, now: number[]): number | null {
  return now.find((window) => !before.has(window)) ?? null;
}

/** A raise begun: `opened` is called once Explorer is started, and says how it went. */
export type Raising = { opened: () => Promise<string> };

/**
 * Notes the Explorer windows open now; `opened` then waits, at most
 * `RAISE_MS`, for a new one and raises it. Throws if `desktop` cannot be had.
 */
export function startRaise(desktop: () => Desktop = user32Desktop): Raising {
  const windows = desktop();
  const before = new Set(windows.explorers());
  return {
    opened: async () => {
      const deadline = Date.now() + RAISE_MS;
      for (;;) {
        const found = newWindow(before, windows.explorers());
        if (found !== null) {
          const how = windows.raise(found);
          return how === null
            ? "not raised: Windows kept the foreground where it was"
            : `raised (${how})`;
        }
        if (Date.now() >= deadline)
          return `not raised: no new Explorer window within ${RAISE_MS / 1000} s`;
        await Bun.sleep(POLL_MS);
      }
    },
  };
}

const SW_RESTORE = 9;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 2;

let loaded: Desktop | null = null;

/** user32 through `bun:ffi`, loaded once; only on Windows. */
export function user32Desktop(): Desktop {
  if (loaded !== null) return loaded;
  if (process.platform !== "win32") throw new Error("Windows' user32 is only on Windows.");
  // Required here, not imported at the top: off Windows there is no user32 to open.
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const { symbols: u } = dlopen("user32.dll", {
    FindWindowExW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
    IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
    IsIconic: { args: [FFIType.ptr], returns: FFIType.i32 },
    ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetForegroundWindow: { args: [], returns: FFIType.ptr },
    SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
    BringWindowToTop: { args: [FFIType.ptr], returns: FFIType.i32 },
    keybd_event: {
      args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.ptr],
      returns: FFIType.void,
    },
    GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  });
  const { symbols: k } = dlopen("kernel32.dll", {
    GetCurrentThreadId: { args: [], returns: FFIType.u32 },
  });
  const cabinet = Buffer.from("CabinetWClass\0", "utf16le");
  // Window handles are numbers here; FFI takes them back as pointers.
  const handle = (window: number) => window as Pointer;
  const front = () => Number(u.GetForegroundWindow() ?? 0);
  loaded = {
    explorers: () => {
      const found: number[] = [];
      let after: Pointer | null = null;
      for (;;) {
        const window = u.FindWindowExW(null, after, ptr(cabinet), null);
        if (window === null || Number(window) === 0) return found;
        if (u.IsWindowVisible(window) !== 0) found.push(Number(window));
        after = window as Pointer;
      }
    },
    raise: (window) => {
      if (u.IsIconic(handle(window)) !== 0) u.ShowWindow(handle(window), SW_RESTORE);
      if (front() === window) return "already in front";
      // A key press lifts the foreground lock for the next SetForegroundWindow.
      u.keybd_event(VK_MENU, 0, 0, null);
      u.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, null);
      u.SetForegroundWindow(handle(window));
      if (front() === window) return "alt key";
      const theirs = u.GetWindowThreadProcessId(u.GetForegroundWindow(), null);
      const mine = k.GetCurrentThreadId();
      u.AttachThreadInput(mine, theirs, 1);
      u.BringWindowToTop(handle(window));
      u.SetForegroundWindow(handle(window));
      u.AttachThreadInput(mine, theirs, 0);
      return front() === window ? "attached input" : null;
    },
  };
  return loaded;
}
