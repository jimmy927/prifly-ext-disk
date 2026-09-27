/**
 * Build the native Windows fastdu (`fastdu.c`) with Visual Studio's compiler,
 * as `fastdu-c-<hash>.exe` beside the source, replacing older builds.
 *
 *   bun scan/windows/build.ts
 *
 * Run it after changing `fastdu.c`, from WSL on a Windows machine with Visual
 * Studio (or its Build Tools) and the C++ workload. Machines without one use
 * the committed exe; until it is rebuilt, a changed source falls back to
 * `fastdu.cs`, which every Windows can compile.
 */

import { copyFileSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../run";
import { nativeName } from "./fastdu";

const HERE = import.meta.dir;
const CMD = "/mnt/c/Windows/System32/cmd.exe";
const VSWHERE = "/mnt/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe";

async function main(): Promise<void> {
  if (!existsSync(VSWHERE)) throw new Error("No Visual Studio installer found (vswhere.exe).");
  const install = (
    await run(
      [
        VSWHERE,
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      60_000,
      "/mnt/c",
    )
  ).trim();
  if (install === "") throw new Error("Visual Studio has no C++ build tools installed.");
  const work = "/mnt/c/Windows/Temp/prifly-fastdu-build";
  await run(["mkdir", "-p", work]);
  copyFileSync(join(HERE, "fastdu.c"), join(work, "fastdu.c"));
  writeFileSync(
    join(work, "build.bat"),
    [
      "@echo off",
      `call "${install}\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul`,
      "cd /d C:\\Windows\\Temp\\prifly-fastdu-build",
      "cl /nologo /O2 /W3 /Fe:fastdu.exe fastdu.c",
      "",
    ].join("\r\n"),
  );
  await run(
    [CMD, "/d", "/c", "C:\\Windows\\Temp\\prifly-fastdu-build\\build.bat"],
    300_000,
    "/mnt/c",
  );
  for (const old of readdirSync(HERE)) {
    if (old.startsWith("fastdu-c-") && old.endsWith(".exe")) rmSync(join(HERE, old));
  }
  copyFileSync(join(work, "fastdu.exe"), join(HERE, nativeName()));
  process.stdout.write(`${nativeName()}\n`);
}

await main();
