---
name: disk-cleanup
description: Freeing disk space with the user - what fills each drive, which of it can go, asking before anything is removed, and removing it without losing work. Use when the user asks to clean up, free space, look at what takes disk space, or when a drive is nearly full - including WSL and Docker Desktop disk images that never shrink by themselves, session scratch folders, leftover git worktrees, Docker images and unused dev databases.
---

# Disk cleanup

The `disk-scan` program (on the PATH of every session prifly runs) prints the
drives and a list of cleanup candidates, grouped by how careful removal must
be. The prifly extension rescans every half hour; `disk-scan --fresh` scans
now (a few minutes), `disk-scan --json` gives the same as JSON.

## The conversation
1. **DC-1 (MUST)** Run `disk-scan` first. Say how full each drive is and what takes the space, with real sizes from the scan, before proposing anything.
2. **DC-2 (MUST)** Propose with AskUserQuestion, `multiSelect: true`, one option per group of like things ("12 scratch folders of archived sessions — 1.9 GB"), largest win first and the recommended ones marked "(Recommended)". Nothing is removed that the user did not choose. If there are more than four groups, ask about the biggest four and offer the rest after.
3. **DC-3 (MUST)** In each option say what is lost, what stops, and whether it can be undone: "cannot be undone", "Docker stops for about 5 minutes", "an administrator prompt appears on Windows".
4. **DC-4 (MUST)** A dismissed or partly answered question removes nothing more than what was chosen. Never widen a choice ("the worktrees" means the listed ones, not every worktree).
5. **DC-5 (MUST)** Finish with each drive's free space before and after, from `df -h`, and what was left and why.

## Never remove
- **DC-10 (MUST NOT)** Anything a running session uses: its working folder, its scratch folder (`/tmp/claude-<uid>/<project>/<session id>`), worktrees inside that scratch folder, files it has open. Running sessions are the ones in `~/.claude/sessions/<pid>.json` whose process is alive; check `/proc/*/cwd` too. The user saying a session is active overrides any scan.
- **DC-11 (MUST NOT)** Locked worktrees (`git worktree list` says `locked`): a sub-agent is working in them.
- **DC-12 (MUST NOT)** The user's own data — games, Steam libraries, Documents, Downloads, photos — or a database a `.env` still names. Report them as what takes space; do not offer them.
- **DC-13 (MUST)** A candidate's `blockers` are real. "changed N hours ago" means a running session may have made it (sessions make worktrees outside their own folder); ask, do not assume.

## Keeping work before removing
- **DC-20 (MUST)** Uncommitted changes: save them first, never commit for the user. Tracked edits as a patch (`git diff --binary HEAD > <rescue>/<name>.patch`) plus a tar of new and changed files; put them in a rescue folder next to the repositories (`~/src/<repo>-rescue/`) and name it in the report.
- **DC-21 (MUST)** Commits not on any remote: `git bundle create <rescue>/<name>.bundle <branch> --not --remotes`, then `git bundle verify`. Only then remove. Say how to get them back: `git fetch <bundle> 'refs/heads/*:refs/heads/*'`.
- **DC-22 (KNOW)** A worktree whose admin folder is gone (`.git` points at a missing `…/.git/worktrees/<name>`) is invisible to git. Diff it with a throw-away index: `GIT_INDEX_FILE=<tmp> git --git-dir=<repo>/.git --work-tree=<wt> read-tree <branch> && … add -A && … diff --cached <branch>`. Its base may be older than the branch tip, so save the changed files, not just the diff.
- **DC-23 (MUST)** Remove a worktree with `git worktree remove` (`--force` only after DC-20/21), then `git worktree prune`. Removing the folder by hand leaves git a stale entry.

## How to remove what resists
- **DC-30 (KNOW)** Files owned by root (written by containers into bind mounts) make `rm` fail with "Permission denied". When `sudo -n true` fails, delete through a throw-away container, naming only that path: `docker run --rm -v <parent>:/h alpine rm -rf /h/<name>`.
- **DC-31 (KNOW)** Docker: `docker image prune -f` and `docker builder prune -f` remove only what nothing can use. `docker image prune -a` also removes images of stacks that are merely stopped; list them (`docker images`) and ask before that. Volumes hold data: never `docker volume prune` without naming each volume to the user.
- **DC-32 (KNOW)** A Postgres database: check `select count(*) from pg_stat_activity where datname = '<db>'` is 0 and that no `.env` names it, then `DROP DATABASE`. It cannot be undone; ask for each database by name.

## Disk images: space that deleting does not give back
WSL distros and Docker Desktop keep Linux inside `.vhdx` files on a Windows
drive. They grow and do not shrink when files inside are deleted. The scan
shows each image's size against what it holds.

- **DC-40 (KNOW)** A sparse image (the scan says so) gives trimmed space back by itself: trim, and it shrinks. Trimming is safe and needs no downtime; `docker run --rm --privileged --pid=host justincormack/nsenter1 /sbin/fstrim -av` trims Docker's disk and, through Docker's bind mounts, the WSL disk too.
- **DC-41 (MUST)** A non-sparse image needs compacting while its distro is stopped. For Docker Desktop's `docker_data.vhdx`:
  1. Note the running containers and their restart policy (`docker inspect -f '{{.Name}} {{.HostConfig.RestartPolicy.Name}}' $(docker ps -q)`); `unless-stopped` and `always` come back by themselves.
  2. `docker image prune -f; docker builder prune -f`, then trim (DC-40).
  3. Stop Docker Desktop from Windows' own CLI: `"/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" desktop stop`. Confirm with `wsl.exe -l -v` that `docker-desktop` is Stopped and `tasklist.exe` shows no `com.docker.backend.exe`.
  4. Write a diskpart script — `select vdisk file="<path>"`, `attach vdisk readonly`, `compact vdisk`, `detach vdisk` — and run it elevated: `powershell.exe -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-File','<script.ps1>'"`, the `.ps1` calling `diskpart /s <script.txt> *> <log>`. Tell the user an administrator prompt is waiting; it does nothing until they accept. Run it in the background and read the log.
  5. `docker.exe desktop start`, wait for `docker ps`, and check the containers from step 1 are back and healthy.
  On 2026-09-26 this took `docker_data.vhdx` from 822 GB to 66 GB in about five minutes.
- **DC-42 (MUST NOT)** Compact the WSL distro's own image while sessions run: it needs `wsl --shutdown`, which ends every WSL process, prifly's sessions and this one included. Offer it for when the user is done for the day, with the steps (shutdown, then the same diskpart script on `ext4.vhdx` from Windows), and do not run it yourself.
- **DC-43 (KNOW)** Commands through WSL interop: `powershell.exe`, `tasklist.exe` and friends may not be on the PATH; use `/mnt/c/Windows/System32/…` paths, and run them from `/mnt/c` so Windows does not warn about a UNC working folder. Their output can be UTF-16: `tr -d '\0'`.

## Moving instead of deleting
- **DC-50 (KNOW)** Moving a repository that running sessions work in breaks them unless the old path keeps working: `mv`, leave a symlink at the old path, `git worktree repair` from the new main checkout with every worktree path. Claude Code keys transcripts and memory by path (`~/.claude/projects/-home-…`): rename those folders the same way and symlink the old names. Remove the symlinks only once no session uses the old paths.
