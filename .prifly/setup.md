---
setup:
  - bun install --frozen-lockfile
---

A Bun project with dev dependencies only (Biome, TypeScript, `@types/bun`); `bun install`
from `bun.lock` is all a fresh worktree needs. Then, as the README's Develop section says:
`bun test`, `bun run typecheck`, `bun run check`.

Relies on outside the worktree:
- `bun` on the PATH.
- The fastdu binaries are downloaded on first use (into `cache/` on Linux/macOS,
  `%LOCALAPPDATA%\prifly-disk\` on Windows), not at setup; some tests may need network for that.
- `config.json` is untracked and optional (`config.example.json` shows it); without it no
  Postgres database is read.
