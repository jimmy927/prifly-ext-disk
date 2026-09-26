# Disk space for prifly

How full each drive is, what takes the space, and what could be cleaned — and
a Claude Code skill that proposes what to clean, asks you, and does it
without losing work.

- **Status bar**: free space on every drive (`WSL 724 GB free · C: 256 GB free · D: 2.5 TB free`),
  amber below 10 % free, red below 5 %. Its tooltip says how much could be cleaned.
- **Disk space window** (status bar button): a bar per drive split into what fills it, the
  biggest folders and files per drive, and the cleanup candidates grouped by how careful
  removing them must be.
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

The scan runs at start and every half hour, in the background; the window's **Scan again**
starts one. **Read Windows folders** walks each Windows drive's top-level folders, which
takes minutes on large drives, and is kept until you read again. `disk-scan` prints the last
scan in a session (`--fresh` scans now, `--json` for JSON).

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
