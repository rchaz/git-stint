# Changelog

All notable changes to git-stint will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-02-28

### Added
- **Remote branch cleanup** — `end` and `merge` now delete the remote branch when all changes are verified merged into the target branch
- Two-tier merge detection: commit ancestry (`--is-ancestor`) for regular merges, content diff for squash and rebase merges
- Checks against both the default branch and the current branch (supports non-main workflows like `develop`)
- Guards against false positives when the main repo is checked out to the session branch
- Graceful handling of network errors and missing remotes — warnings with manual deletion commands, never blocks the `end` operation
- Unmerged remote branches are always preserved with a clear warning and the exact `git push origin --delete` command to run manually

## [0.2.3] - 2026-02-28

### Added
- Skip gitignored files in PreToolUse hook — writes to `node_modules/`, `dist/`, `.env`, etc. no longer trigger session creation or blocking
- Hook test suite covering gitignore patterns, negation, nesting, `.git/info/exclude`, and policy enforcement

### Fixed
- Prevent `shared_dirs` symlinks from being staged by `git add -A` — symlinks (mode 120000) aren't matched by trailing-slash gitignore rules

## [0.2.0] - 2026-02-27

### Added
- **`shared_dirs`** config — symlink gitignored directories (caches, data, logs) from main repo into worktrees automatically on `start`
- **`main_branch_policy`** config — `"block"` (auto-create session), `"prompt"` (block with instructions), `"allow"` (pass through)
- **`force_cleanup`** config — control worktree removal behavior (`"prompt"`, `"force"`, `"fail"`)
- **`adopt_changes`** config — carry uncommitted changes from main into new worktrees (`"always"`, `"never"`, `"prompt"`)
- `--adopt` / `--no-adopt` CLI flags to override `adopt_changes` per invocation
- Per-client `allow-main` flag scoped by PID — multiple Claude Code instances stay isolated
- `install-hooks` now scaffolds `.stint.json` with defaults if it doesn't exist
- Updated Claude Code hook format to match current settings schema

## [0.1.0] - 2026-02-26

### Added
- Core session commands: `start`, `commit`, `squash`, `merge`, `pr`, `end`, `abort`, `undo`
- Session listing: `list`, `list --json`
- File tracking: `track`, `status`, `diff`, `log`
- Cross-session conflict detection: `conflicts`
- Worktree-based test isolation: `test`, `test --combine`
- Orphan cleanup: `prune`
- Claude Code adapter with PreToolUse and Stop hooks
- Hook installer for `.claude/settings.json`
- Manifest schema versioning for forward compatibility
- Automated test suite: unit, security, and integration tests
- PR body generation from session changeset history
