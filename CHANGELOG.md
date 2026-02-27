# Changelog

All notable changes to git-stint will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
