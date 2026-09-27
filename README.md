# Disk space for prifly

How full each drive is, what takes the space, and what could be cleaned — and
a Claude Code skill that proposes what to clean, asks you, and does it
without losing work.

- **Status bar**: free space on every drive (`WSL 724 GB free · C: 256 GB free · D: 2.5 TB free`),
  amber below 10 % free, red below 5 %. Its tooltip says how much could be cleaned.
- **Disk space window** (status bar button): a bar per drive split into what fills it, the
  biggest folders and files per drive, and the cleanup candidates grouped by how careful
  removing them must be.
- **Clean up** on any candidate, or **Clean up all** on a group, starts a session in a window
  of its own (Opus, asking before each tool) told exactly what was picked: it checks each item
  again, asks you once, saves what must be saved, cleans it, and scans again. Start several,
  close the Disk space window, carry on; the drives are rescanned when each session ends.
  This needs a prifly with `prifly-launch` (panels asking the window to start a session).
- **Clean up disk space** in the New session launcher starts a session that runs the
  `disk-cleanup` skill: it shows the drives, proposes what to clean with a questionnaire,
  removes only what you pick, saves uncommitted work and unpushed commits first, and reports
  each drive's free space before and after. Any session can do the same when asked to
  "clean up disk space".

## What it looks at

| Where | Offered as | How careful |
|---|---|---|
| WSL and Docker Desktop disk images (`.vhdx`) that take far more than their Linux holds | trim (sparse image) or compact | safe · needs downtime |
| Claude Code scratch folders, `/tmp/claude-<uid>/<project>/<session>` | per session | safe when archived, check when not running |
| Git worktrees under your home folder and `~/src` that no running session uses | per worktree | safe when clean, pushed and quiet for a day |
| Docker dangling images and build cache; unused tagged images | two groups | safe · check |
| Local Postgres databases no checkout's `.env` names (when configured) | per database | check — cannot be undone |

Your own data (games, Documents, Steam) shows under what takes the space but is never offered.

**Running** sessions are the ones Claude Code has a live process for
(`~/.claude/sessions/<pid>.json`); **archived** comes from prifly. Nothing a running session
works in — its folder, its scratch folder, worktrees inside it — is offered, and neither are
locked worktrees (a sub-agent is in them).

The scan runs at start and every half hour, in the background, and **Scan now** in the
window starts one; while it runs, the window shows each part — Linux folders, Windows
folders, disk images, Docker, databases, scratch folders, worktrees — with what it has
counted so far. `disk-scan` prints the last scan in a session (`--fresh` scans now, with
each part's progress on standard error; `--json` for JSON).

## How it reads sizes fast

A directory listing is cheap; asking the file system about each file is what costs.

- **Windows drives** are read by `fastdu` (`scan/windows/fastdu.cs`), a small C# program
  compiled on first use with the compiler every Windows has. Windows' directory listing
  (`FindFirstFileEx`) already carries each file's size, so a whole drive is summed from the
  listings alone, on several threads — no file is opened or stat-ed. `C:\Program Files`
  (152,000 files) took 3.3 s where PowerShell's `Get-ChildItem` took 28.6 s, to the same
  byte; all of C: and D: (2.0 million files, 2.3 TB) about 40 s.
- **Linux** listings carry no sizes, so every file does need an `lstat`. Those run on a
  thread per two cores (`scan/walk.ts`), and the home folder and `/tmp` are walked once —
  every folder's size comes out of the one pass, and the scratch folders, worktrees and
  biggest folders are looked up in it. `~/src` (1.1 million files) took 7.6 s where `du`
  took 17 s warm and 119 s cold. Counted like `du -x`: allocated blocks, one file system,
  a file with several hard links once.
- **Postgres** names its databases, and their sizes come from their folders under `base\`,
  read by `fastdu` — `pg_database_size` stats every segment file, which took 50 s on a
  979 GB database on NTFS against 0.8 s.

A full scan of this machine — 4.2 million files on Linux, 2.0 million on Windows — takes
about a minute and a half.

When the fast way fails, the slow one stands in and the part says so: PowerShell's
`Get-ChildItem` for the Windows folders when `fastdu` cannot be built or started, and
`pg_database_size` for the databases when their folders cannot be read. macOS runs the
Linux walk for now; a `getattrlistbulk` scanner, its equivalent of `fastdu`, can come later.

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
