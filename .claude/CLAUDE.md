# CLAUDE.md

Instructions for AI agents working on this codebase.

## What is git-stint?

Session-scoped change tracking for AI coding agents. Each session = real git branch + worktree.

## Build & Test

```bash
npm run build        # Compile TypeScript
npm run test:all     # Build + run all tests
```

Always build before testing — tests import from `dist/`.

## Source Files

| File | Purpose |
|------|---------|
| `src/git.ts` | Git command wrappers (execFileSync, array args) |
| `src/manifest.ts` | Session state CRUD (`.git/sessions/<name>.json`) |
| `src/session.ts` | Core commands: start, commit, squash, merge, pr, end, abort, undo, allowMain |
| `src/config.ts` | `.stint.json` loading + validation (shared_dirs, main_branch_policy, force_cleanup) |
| `src/conflicts.ts` | Cross-session file overlap detection |
| `src/test-session.ts` | Worktree-based testing + combined testing |
| `src/cli.ts` | Entry point, argument parsing, command dispatch |
| `src/install-hooks.ts` | Claude Code hook installation/removal |
| `adapters/claude-code/hooks/git-stint-hook-pre-tool` | PreToolUse hook (bash) — reads `.stint.json`, enforces main_branch_policy, skips gitignored files |
| `adapters/claude-code/hooks/git-stint-hook-stop` | Stop hook (bash) — auto-commits WIP on conversation end |

## Coding Rules

- Use `execFileSync` (array args), NEVER `execSync` (string args)
- Use `getGitCommonDir()` not `getGitDir()` — worktrees have different git dirs
- Use `getRepoRoot()` not `getTopLevel()` — the latter returns worktree root
- Use `saveManifest()` for writes — atomic temp+rename
- Session names: `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, no `..`, no spaces
- Zero runtime dependencies
- Config is loaded via `loadConfig(repoRoot)` from `src/config.ts` — always merges with defaults

## When Making Changes

1. `npm run build` to check compilation
2. `npm run test:all` to verify all tests pass
3. New commands need tests in `test/unit/session.test.js`; hook changes need tests in `test/unit/hook-pre-tool.test.js`
4. Config-related changes need tests in `test/unit/config.test.js`
5. Git operations go through `src/git.ts` — don't call git directly
6. Manifest changes must be backward compatible
7. Hook changes go in `adapters/claude-code/hooks/` (bash scripts)

## Key Concepts

- **shared_dirs**: Symlinks from worktree to main repo for gitignored dirs (caches, data). Created on `start()`, unlinked before `cleanup()`.
- **main_branch_policy**: `"block"` (auto-session), `"prompt"` (check flag), `"allow"` (pass through). Enforced by the PreToolUse hook.
- **allow-main flag**: `.git/stint-main-allowed-<PID>` — per-client flag created by `allowMain(clientId?)`. Scoped to a single Claude Code instance via PID. Stale flags cleaned by `prune()`.
- **adopt changes**: `start()` stashes uncommitted changes from main, pops into worktree. Stash happens before symlink creation to avoid conflicts.
- **clientId**: Session affinity via `$PPID`. Each Claude Code instance maps to its own session.
- **remote branch cleanup**: `cleanup()` deletes the remote branch when all changes are verified merged **on the remote**. Checks against remote tracking refs (`origin/main`), not local branches — a local `git stint merge` won't delete the remote branch until main is pushed. Two-tier check: `--is-ancestor` (regular merges) then content diff of changed files (squash/rebase merges). Checks both default and current branch on remote. Network errors are caught — never blocks `end`.

## Publishing

After changes are committed and pushed to `main`, publish to npm:

1. Bump the version in **both** `package.json` and `package-lock.json`
2. Commit: `git commit -am "v0.X.Y"`
3. Push: `git push origin main`
4. Tag and push: `git tag v0.X.Y && git push origin v0.X.Y`

The tag push triggers CI (tests on ubuntu + macos, Node 22 + 24) then publishes to npm.
Use **patch** bumps for fixes, **minor** bumps for features.
