# git-stint

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js: 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)

Session-scoped change tracking for AI coding agents. Each session gets a real git branch and worktree — isolated by default, mergeable at the end.

Built to replace GitButler for AI-agent workflows. No virtual branches, no custom merge engine, no state corruption. Just git.

## Why

AI coding agents (Claude Code, Cursor, Copilot) edit files but have no clean way to:

1. **Track what they changed** — separate agent changes from human changes
2. **Isolate sessions** — two parallel agents editing the same repo shouldn't conflict
3. **Produce clean commits** — agent work should result in reviewable, mergeable PRs
4. **Test in isolation** — verify one session's changes without interference

git-stint solves this with ~2,000 lines of TypeScript + bash on top of standard git primitives.

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- [git](https://git-scm.com) 2.20+ (worktree support)
- [`gh` CLI](https://cli.github.com) (optional, for PR creation)

## Install

### With Claude Code (recommended)

Tell Claude Code:

> Install git-stint globally (`npm install -g git-stint`), set up hooks for this repo, and create a .stint.json

Claude Code will:
1. Run `npm install -g git-stint`
2. Run `git stint install-hooks` (writes to `.claude/settings.json`)
3. Create a `.stint.json` with your preferred `main_branch_policy`

### Manual install

```bash
# 1. Install
npm install -g git-stint       # from npm
# — or from source —
git clone https://github.com/rchaz/git-stint.git
cd git-stint && npm install && npm run build && npm link

# 2. Set up hooks in your project
cd /path/to/your/repo
git stint install-hooks

# 3. Configure (optional)
cat > .stint.json << 'EOF'
{
  "shared_dirs": [],
  "main_branch_policy": "prompt"
}
EOF
```

## Quick Start

```bash
# Start a session (creates branch + worktree)
git stint start auth-fix
cd .stint/auth-fix/

# Work normally — make changes, edit files...

# Commit progress (advances baseline)
git stint commit -m "Fix token refresh logic"

# More changes...
git stint commit -m "Add refresh token tests"

# Squash into a single clean commit
git stint squash -m "Fix auth token refresh"

# Create PR and clean up
git stint pr --title "Fix auth bug"
git stint end
```

## Commands

| Command | Description |
|---------|-------------|
| `git stint start [name]` | Create a new session (branch + worktree) |
| `git stint list` | List all active sessions |
| `git stint status` | Show current session state |
| `git stint track <file...>` | Add files to the pending list |
| `git stint diff` | Show uncommitted changes in worktree |
| `git stint commit -m "msg"` | Commit changes, advance baseline |
| `git stint log` | Show session commit history |
| `git stint squash -m "msg"` | Collapse all commits into one |
| `git stint merge` | Merge session into current branch (no PR) |
| `git stint pr [--title "..."]` | Push branch and create GitHub PR |
| `git stint end` | Finalize session, clean up everything (deletes remote branch if merged) |
| `git stint abort` | Discard session — delete all changes |
| `git stint undo` | Revert last commit, changes become pending |
| `git stint conflicts` | Check file overlap with other sessions |
| `git stint test [-- cmd]` | Run tests in the session worktree |
| `git stint test --combine A B` | Test multiple sessions merged together |
| `git stint prune` | Clean up orphaned worktrees/branches |
| `git stint allow-main [--client-id <PID>]` | Allow writes to main branch (scoped to one process/session) |
| `git stint install-hooks` | Install Claude Code hooks |
| `git stint uninstall-hooks` | Remove Claude Code hooks |

### Options

- `--session <name>` — Specify which session (auto-detected from CWD)
- `--client-id <id>` — Client identifier (used by hooks). For `start`, tags the session. For `allow-main`, scopes the flag to that client.
- `--adopt` / `--no-adopt` — Override `adopt_changes` config for this start
- `-m "message"` — Commit or squash message
- `--title "title"` — PR title
- `--version` — Show version number

## Configuration — `.stint.json`

Create a `.stint.json` file in your repo root to configure git-stint behavior:

```json
{
  "shared_dirs": [
    "backend/data",
    "backend/results",
    "backend/logs"
  ],
  "main_branch_policy": "prompt",
  "force_cleanup": "prompt",
  "adopt_changes": "always"
}
```

| Field | Values | Default | Description |
|-------|--------|---------|-------------|
| `shared_dirs` | `string[]` | `[]` | Directories to symlink from worktree to main repo on `start`. Use for gitignored data dirs (caches, build outputs, logs) that shouldn't be duplicated per session. |
| `main_branch_policy` | `"prompt"` / `"allow"` / `"block"` | `"prompt"` | What happens when writing to main with hooks enabled. `"block"` auto-creates a session. `"allow"` passes through. `"prompt"` blocks with instructions to run `git stint allow-main` or `git stint start`. |
| `force_cleanup` | `"prompt"` / `"force"` / `"fail"` | `"prompt"` | What happens when non-force worktree removal fails. `"force"` retries with `--force`. `"fail"` throws an error. `"prompt"` retries with force (default, same as previous behavior). |
| `adopt_changes` | `"always"` / `"never"` / `"prompt"` | `"always"` | What happens when `git stint start` is called with uncommitted changes on main. `"always"` stashes and moves them into the new worktree. `"never"` leaves them on main. `"prompt"` warns and suggests `--adopt` or `--no-adopt`. |

### Shared Directories

When a worktree is created, gitignored directories (caches, build outputs, data) don't exist in it. Without `shared_dirs`, you'd need to manually symlink or recreate them.

With `shared_dirs` configured, `git stint start` automatically:
1. Creates symlinks from the worktree to the main repo for each listed directory
2. On `git stint end` / `abort`, removes the symlinks before deleting the worktree — so linked data is never lost

```
# Main repo                          # Worktree (.stint/my-session/)
backend/data/  (200MB cache)    ←──  backend/data → symlink to main
backend/results/                ←──  backend/results → symlink to main
```

The directories listed in `shared_dirs` should typically be gitignored, since they contain large or generated data that shouldn't be committed.

### Main Branch Policy

Controls what happens when Claude Code (or another agent) tries to write directly to the main branch while hooks are installed:

- **`"block"`** — Auto-creates a session and blocks the write, forcing the agent to work in the worktree. This is the most protective mode.
- **`"prompt"`** (default) — Blocks with a message that includes the exact command to unblock, e.g. `git stint allow-main --client-id 56193`. Lets you choose per-situation.
- **`"allow"`** — Passes through silently. Hooks still track files in existing worktrees, but don't enforce session usage.

The `allow-main` flag is scoped per-process. When the hook blocks a write, it prints the exact command with the correct `--client-id` (the Claude Code instance's PID). Running that command creates `.git/stint-main-allowed-<PID>`, which only unblocks that specific instance. Other Claude Code sessions remain blocked.

**Important:** Always use the `--client-id` value from the hook's block message. Running `allow-main` without `--client-id` from a separate terminal will NOT unblock Claude Code (different process tree). The intended flow is:

1. Hook blocks Claude's write and prints: `git stint allow-main --client-id <PID>`
2. Claude (or the user telling Claude) runs that exact command
3. Claude retries the write — it succeeds

Stale flags from dead processes are cleaned up by `git stint prune`.

### Adopting Uncommitted Changes

When you run `git stint start` with uncommitted changes on main, behavior depends on `adopt_changes`:

- **`"always"`** (default) — Stashes changes (staged + unstaged + untracked), pops them into the new worktree, leaves main clean. Your work carries over seamlessly.
- **`"never"`** — Leaves uncommitted changes on main. The new worktree starts clean.
- **`"prompt"`** — Warns about uncommitted changes and suggests using `--adopt` or `--no-adopt`.

CLI flags override the config for a single invocation:

```bash
git stint start my-feature --adopt       # Force adopt (overrides "never")
git stint start my-feature --no-adopt    # Force skip (overrides "always")
```

## Claude Code Integration

git-stint includes hooks that make it work seamlessly with [Claude Code](https://docs.anthropic.com/en/docs/claude-code):

- **PreToolUse hook**: When Claude writes/edits a file inside a session worktree, the file is automatically tracked. If Claude tries to write to the main repo, behavior depends on `main_branch_policy` in `.stint.json`. Writes to gitignored files (e.g. `node_modules/`, `dist/`, `.env`) are always allowed through — they can't be committed, so they don't need branch isolation.
- **Stop hook**: When a Claude Code conversation ends, pending changes are auto-committed as a WIP checkpoint.
- **Session affinity**: Each Claude Code instance is mapped to its own session via `clientId` (process ID). Multiple Claude instances can work in parallel without hijacking each other's sessions.

### Setup for Claude Code

```bash
# 1. Install git-stint globally
npm install -g git-stint

# 2. Navigate to your project
cd /path/to/your/repo

# 3. Install hooks (writes to .claude/settings.json)
git stint install-hooks

# 4. (Optional) Configure shared dirs and branch policy
cat > .stint.json << 'EOF'
{
  "shared_dirs": [],
  "main_branch_policy": "prompt"
}
EOF

# 5. Done — Claude Code will now auto-track files in sessions
```

To install hooks globally (all repos):

```bash
git stint install-hooks --user
```

### Workflow with Claude Code

**Option A: Session-based (isolated branch)**

```bash
# Start a session before asking Claude to work
git stint start my-feature
cd .stint/my-feature/

# Tell Claude to work on things — hooks handle tracking automatically

# When done, squash and PR
git stint squash -m "Implement feature X"
git stint pr
git stint end
```

Or let the hooks auto-create sessions — just start coding with Claude and the hook will create a session on the first write (when `main_branch_policy` is `"block"`).

**Option B: Quick edits on main (allow-main)**

For small changes that don't need a branch, the hook blocks and tells Claude exactly what to run:

```
BLOCKED: Writing to main branch.
To allow, run: git stint allow-main --client-id 56193
To create a session instead, run: git stint start <name>
```

Claude runs the printed command, then retries the write — it succeeds. The flag only applies to that specific Claude Code session. Other instances stay blocked.

## How It Works

### Session Model

Each session creates:
- A **git branch** (`stint/<name>`) forked from HEAD
- A **worktree** (`.stint/<name>/`) for isolated file access
- A **manifest** (`.git/sessions/<name>.json`) tracking state

```
Session starts at HEAD = abc123
  |
Edit config.ts, server.ts
  |
"commit" -> changeset 1 (baseline advances to new SHA)
  |
Edit server.ts (again), test.ts
  |
"commit" -> changeset 2 (only NEW changes since last commit)
```

The **baseline cursor** advances on each commit. `git diff baseline..HEAD` always gives exactly the uncommitted work. No virtual branches, no custom merge engine.

### Parallel Sessions

Multiple sessions run simultaneously with full isolation:

```
Session A: edits config.ts, server.ts     -> .stint/session-a/
Session B: edits server.ts, constants.ts  -> .stint/session-b/
                  ^ overlap detected by `git stint conflicts`
```

Each session has its own worktree — no interference. Conflicts resolve at PR merge time, using git's standard merge machinery.

### Testing

```bash
# Test a single session in its worktree
git stint test -- npm test

# Test multiple sessions merged together
git stint test --combine auth-fix perf-update -- npm test
```

Combined testing creates a temporary octopus merge of the specified sessions, runs the test command, then cleans up. No permanent state changes.

## Architecture

```
                          +----------------+
                          |  .stint.json   |
                          |  (config)      |
                          +-------+--------+
                                  |
+-----------+    +-----------+    v    +----------------+
|  CLI      |    | Session   |------->|  Config        |
| (cli.ts)  |--->|(session.ts)|       | (config.ts)    |
| arg parse |    | commands  |---+    +----------------+
+-----------+    +-----+-----+  |
                       |        +--->+----------------+
                +------v------+      |  Manifest      |
                |  Git        |      | (manifest.ts)  |
                | (git.ts)    |      |  JSON state    |
                |  plumbing   |      +----------------+
                +-------------+
```

| File | Purpose | Lines |
|------|---------|-------|
| `src/git.ts` | Git command wrapper (`execFileSync`) | ~180 |
| `src/manifest.ts` | Session state CRUD in `.git/sessions/` | ~200 |
| `src/session.ts` | Core commands (start, commit, squash, pr, end...) | ~830 |
| `src/config.ts` | `.stint.json` loading and validation | ~60 |
| `src/conflicts.ts` | Cross-session file overlap detection | ~55 |
| `src/test-session.ts` | Worktree-based testing + combined testing | ~140 |
| `src/cli.ts` | Entry point, argument parsing | ~300 |
| `src/install-hooks.ts` | Claude Code hook installation/removal | ~170 |
| `adapters/claude-code/hooks/` | Bash hooks (PreToolUse + Stop) | ~220 |

### Design Decisions

- **Real git branches** — not virtual branches. Every git tool works: `git log`, `git diff`, lazygit, tig, VS Code.
- **Worktrees for isolation** — the default state is isolated. No unapply/apply dance.
- **JSON manifests** — stored in `.git/sessions/`. Disposable. Worst case: delete and start over.
- **No custom merge engine** — git's built-in merge handles everything. Source of most GitButler complexity eliminated.
- **`execFileSync` everywhere** — array arguments prevent shell injection. No `execSync` with string interpolation.
- **Atomic manifest writes** — write to `.tmp`, then `rename()`. Crash-safe.
- **Symlinks for shared data** — gitignored dirs (caches, data) symlink into worktrees instead of being copied or lost.
- **Safe remote branch cleanup** — on `end`/`merge`, deletes the remote branch only when all changes are verified merged **on the remote**. Checks against remote tracking refs (`origin/main`), not local branches — so a local-only merge won't delete the remote branch until you push. Uses a two-tier check (commit ancestry + content diff) that handles regular merges, squash merges, and rebase merges. Unmerged branches are always preserved with a warning.
- **Zero runtime dependencies** — only Node.js built-ins. Dev deps are TypeScript and @types/node.

## git-stint vs GitButler

| Aspect | git-stint | GitButler |
|--------|-----------|-----------|
| Isolation | Default (each branch IS isolated) | Opt-in (unapply other branches) |
| Branch storage | Real git branches | Virtual branches (TOML + SQLite) |
| Working dir | One branch per worktree | Permanent octopus merge overlay |
| Merge engine | Git's built-in | Custom hunk-level engine |
| Git compatibility | Full — all git tools work | Partial — writes break state |
| State | JSON manifests (disposable) | SQLite + TOML (can corrupt) |
| Code size | ~2,000 lines TypeScript + bash | ~100k+ lines Rust |
| Dependencies | git, gh (optional) | Tauri desktop app |

git-stint is designed for AI agent workflows where sessions are independent and short-lived. GitButler is a full-featured branch management GUI for teams.

## Development

```bash
git clone https://github.com/rchaz/git-stint.git
cd git-stint
npm install
npm run build
npm link          # Install globally for testing

# Run tests
npm test              # Unit tests
npm run test:security     # Security tests
npm run test:integration  # Integration tests
npm run test:all          # Everything (build + all tests)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and PR guidelines.

Please note that this project is released with a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to abide by its terms.

## License

MIT — see [LICENSE](LICENSE)
