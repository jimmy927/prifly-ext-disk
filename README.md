# Disk space for prifly

How full each drive is, what takes the space, and what could be cleaned — and
a Claude Code skill that proposes what to clean, asks you, and does it
without losing work.

- **Disk space window** (status bar button): a bar per drive split into what fills it, the
  biggest folders and files per drive, and the cleanup candidates grouped by how careful
  removing them must be.
- **Clean up** on any candidate, or **Clean up all** on a group, starts a session in a window
  of its own (Opus, asking before each tool) told exactly what was picked: it checks each item
  again, asks you once, saves what must be saved, cleans it, and scans again. Start several,
  close the Disk space window, carry on; the drives are rescanned when each session ends.
  This needs a prifly with `prifly-launch` (panels asking the window to start a session).
- **The `disk-cleanup` skill**: any session asked to "clean up disk space" shows the drives,
  proposes what to clean with a questionnaire, removes only what you pick, saves uncommitted
  work and unpushed commits first, and reports each drive's free space before and after.

## What it looks at

| Where | Offered as | How careful |
|---|---|---|
| WSL and Docker Desktop disk images (`.vhdx`) that take far more than their Linux holds | trim (sparse image) or compact | safe · needs downtime |
| Claude Code scratch folders, `/tmp/claude-<uid>/<project>/<session>` (on Windows `%TEMP%\claude\…`) | per session | safe when archived, check when not running |
| Git worktrees under your home folder and `~/src` that no running session uses | per worktree | safe when clean, pushed and quiet for a day |
| Docker dangling images and build cache; unused tagged images | two groups | safe · check |
| Local Postgres databases no checkout's `.env` names (when configured) | per database | check — cannot be undone |

Your own data (games, Documents, Steam) shows under what takes the space but is never offered.

**Running** sessions are the ones Claude Code has a live process for
(`~/.claude/sessions/<pid>.json`); **archived** comes from prifly. Nothing a running session
works in — its folder, its scratch folder, worktrees inside it — is offered, and neither are
locked worktrees (a sub-agent is in them).

The scan runs only when asked — **Scan now** in the window, and after a cleanup
started from the window ends; while it runs, the window shows each part — Linux folders, Windows
folders, disk images, Docker, databases, scratch folders, worktrees — with what it has
counted so far. `disk-scan` prints the last scan in a session (`--fresh` scans now, with
each part's progress on standard error; `--json` for JSON).

## How it reads sizes fast

Folder sizes come from [fastdu](https://github.com/jimmy927/fastdu), a `du` in C for
Windows and Linux that uses every core and asks the file system as little as it can — each
system walked by its own build, with `-x` so neither walk crosses into the other's disks
(`/mnt/c` under WSL, a volume mounted in a folder on Windows): all
of `C:\` (1.86 M files) in 13.1 s where gdu takes 16.2 s, and `~/src` (1.15 M files) in
1.5 s where ncdu takes 2.5 s. Its README says how, and has the benchmarks.

- **Windows drives**: fastdu's release, downloaded on first use into
  `%LOCALAPPDATA%\prifly-disk\`. Without it, `fastdu.cs` — the same walk in C#, 22 s on
  `C:\` (15 s with the server garbage collector) — is compiled with the compiler every
  Windows has, and without that, PowerShell reads the drives.
- **Linux and macOS**: fastdu's release for the system and processor, downloaded on first
  use into `cache/`.
  The home folder and `/tmp` are walked once — every folder's size comes out of the one
  pass, and the scratch folders, worktrees and biggest folders are looked up in it.
  Without fastdu, the same walk runs in TypeScript (`scan/walk.ts`), 7.9 s on `~/src`.
  Counted like `du -x`: allocated blocks, one file system per root, a file with several
  hard links once.
- **WSL from Windows**: when prifly runs on Windows itself, the default WSL distro's home
  folder and `/tmp` are walked inside it: fastdu's Linux build, downloaded into
  `%LOCALAPPDATA%\prifly-disk\`, started through `wsl.exe` — only while the distro runs, as
  starting it would boot WSL. Its disk shows as the drive **WSL**. The scratch folders and
  worktrees offered are then Windows' own, where sessions run.
- **Postgres** names its databases, and their sizes come from their folders under `base\`,
  read by fastdu — `pg_database_size` stats every segment file, which took 50 s on a
  979 GB database on NTFS against 0.8 s.

The version and each binary's SHA-256 are pinned in `scan/fastdu-release.ts`; a download
that does not match is refused.

A full scan of this machine — 4.2 million files on Linux, 2.0 million on Windows — takes
about a minute and a half.

When the fast way fails, the slow one stands in and the part says so: PowerShell's
`Get-ChildItem` for the Windows folders when fastdu can neither be had nor started, the
TypeScript walk for the Linux folders, and `pg_database_size` for the databases when their
folders cannot be read. On macOS, fastdu's macOS build walks the folders.

On Windows, with no `/proc`, a session runs while the process its
`~/.claude/sessions/<pid>.json` names lives, and works in that file's folder; other
programs' folders cannot be read there, which a worktree's "changed N hours ago" guards.

**Where running sessions cannot be read** — no `/proc`, as on macOS — no scratch folder or
worktree is offered for cleaning: every session would look ended, and a running one's
folders would look safe to remove. They are still counted; Docker's cache, disk images and
databases, which do not depend on sessions, are still offered.

## Settings

`config.json` beside the manifest (see `config.example.json`), all optional:

- `roots`: where repositories are looked for, one level down. Default: your home folder and `~/src`.
- `postgres`: a local server to look for unused databases on, read with `psql -w`
  (a `~/.pgpass` entry or trust authentication). Left out, no database is read.

## Install

In prifly: Extensions → install from `https://github.com/jimmy927/prifly-ext-disk`, or link a
checkout into `~/.local/share/prifly/extensions/` and restart prifly, then enable it.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run check
```
