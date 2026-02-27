# git-session — Session-Scoped Change Tracking for AI Coding Agents

> **Note:** This was the original design proposal written under the name "git-session". The project was subsequently renamed to **git-stint**. All references to `git-session` below reflect the original proposal; the implementation uses `git stint` commands.

**Date:** 2026-02-25
**Status:** Proposal (implemented as git-stint)
**Author:** Rahul Chandrasekaran
**Origin:** Pain points from GitButler + Claude Code parallel sessions in trading system

---

## Problem

AI coding agents (Claude Code, Cursor, Copilot) edit files but have no clean way to:

1. **Track what they changed** — separate agent changes from human changes
2. **Isolate sessions** — two parallel agents editing the same repo shouldn't conflict
3. **Produce clean commits** — agent work should result in reviewable, mergeable PRs
4. **Handle multiple commit points** — a session may commit several times before finishing
5. **Test in isolation** — verify one session's changes without interference from others

GitButler solves a superset of this with virtual branches, but it's heavy — custom
merge engine, conflict resolution UI, workspace mode that replaces normal git. The
complexity exceeds the need. Most of the value comes from one thing: **knowing which
files this session touched.**

## Core Insight

The problem is a **cursor advancing through a session's changes**:

```
Session starts at HEAD = abc123
  ↓
Edit config.py, runner.py, constants.py
  ↓
"commit what we have" → changeset 1
  ↓
Baseline advances to new commit SHA
  ↓
Edit runner.py (again), tests.py
  ↓
"commit" → changeset 2 has only the NEW runner.py diff + tests.py
```

Each commit advances the baseline. `git diff <baseline> -- <pending files>` always
gives exactly the uncommitted session work. No virtual branches, no custom merge
engine. Just git.

## Design

### State Model

Per-session manifest stored in `.git/sessions/<session-id>.json`:

```json
{
  "id": "a5f18c",
  "started_at": "abc123",
  "baseline": "abc123",
  "branch": "session/a5f18c",
  "changesets": [
    {
      "id": 1,
      "sha": "def456",
      "message": "Add quote-level entry config",
      "files": ["src/config.py", "src/constants.py"],
      "timestamp": "2026-02-25T14:45:00"
    }
  ],
  "pending": ["src/runner.py", "tests/test_new.py"]
}
```

- `started_at` — HEAD when session began (never changes)
- `baseline` — advances on each commit (last committed SHA)
- `pending` — files tracked since last commit (resets on commit)
- `changesets` — ordered list of commits in this session

### CLI

```bash
git session start                # baseline = HEAD, pending = []
git session track <file>         # add file to pending list
git session status               # show pending files + changesets
git session diff                 # git diff baseline -- pending files
git session commit -m "msg"      # commit pending, advance baseline, clear pending
git session log                  # all changesets in this session
git session squash -m "msg"      # collapse all changesets into one commit
git session pr                   # push branch + gh pr create
git session end                  # finalize session (commit if pending, clean up)
git session test                 # test this session in isolation (worktree)
git session test --combine A B   # test multiple sessions merged together
git session undo                 # revert last changeset, changes become pending
git session conflicts            # check file overlap with other active sessions
```

Implemented as git subcommands (`git-session` on PATH). ~300 lines.

### Lifecycle

```
start → [track, track, ...] → commit → [track, track, ...] → commit → squash → pr
  │                              │                               │
  │     baseline = HEAD          │     baseline advances         │     all collapsed
  │     pending = []             │     pending = []              │     single commit
```

### Parallel Sessions

Two sessions can run simultaneously:

```
Session A: edits config.py, runner.py
Session B: edits runner.py, constants.py
                    ↑ overlap on runner.py
```

Each session branches from the same base. Conflicts resolve at PR merge time — the
same model every team already uses. No file locking, no virtual branches. Git's merge
machinery handles it.

If desired, a `git session conflicts` command can warn about overlap before PR time:

```bash
$ git session conflicts
WARNING: runner.py also modified by session b3c92e (active)
```

## Isolation & Testing

This is the critical capability that differentiates a real tool from a simple wrapper.

### How GitButler does it

GitButler maintains a **permanent octopus merge commit** as its workspace:

```
gitbutler/workspace = merge(main, branch_A, branch_B, branch_C)
```

The working directory always shows ALL applied branches overlaid. Each virtual branch
is a real git commit stored in `.git/objects/`, tracked by `virtual_branches.toml`
with an `in_workspace = true/false` flag.

**Apply/unapply rebuilds the merge:**

```
but unapply branch_B:
  1. Set in_workspace = false in TOML
  2. Rebuild workspace: merge(main, branch_A, branch_C)
  3. Write new tree to disk — branch_B's changes vanish

but apply branch_B:
  1. Set in_workspace = true in TOML
  2. Rebuild workspace: merge(main, branch_A, branch_B, branch_C)
  3. Write new tree — branch_B's changes reappear
```

The branch commits never move. Apply/unapply controls inclusion in the merge.

**This is why GitButler needs hunk-level tracking:** When two applied branches both
modify `runner.py`, the merge must combine both sets of hunks into one file. GitButler
tracks which hunks belong to which branch so it can cleanly include/exclude them
during rebuild.

### How git-session does it

git-session uses **real git branches**, not a shared overlay. Each session's branch
already contains ONLY its changes on top of main. Isolation is the default state —
not a special mode you enter.

**Three isolation modes:**

#### 1. Worktree isolation (default — best for AI agents)

```bash
git session test
```

Under the hood:
```bash
git worktree add /tmp/session-a5f18c session/a5f18c
cd /tmp/session-a5f18c
uv run pytest tests/ -x -q       # only this session's changes visible
cd -
git worktree remove /tmp/session-a5f18c
```

**Advantages over GitButler's unapply:**
- Original working directory untouched — session continues working
- No risk of forgetting to reapply branches
- True filesystem isolation — no runtime interference between sessions
- Other sessions keep running in parallel unaffected
- No hunk-level tracking needed — branch already has only its changes

#### 2. Combined testing (multiple sessions together)

```bash
git session test --combine A B     # test A+B together without C
```

Under the hood:
```bash
git worktree add /tmp/combined main
cd /tmp/combined
git merge session/A session/B      # octopus merge — same as GitButler does
uv run pytest tests/ -x -q
cd -
git worktree remove /tmp/combined
```

This gives GitButler's "test these sessions together" capability without the permanent
overlay model. The merge is temporary, created on demand, discarded after testing.

#### 3. Inline isolation (lightweight, single-directory)

```bash
git session test --inline
```

Under the hood:
```bash
git stash push -m "git-session: parking other work"
git checkout session/a5f18c
# ... run tests ...
git checkout -
git stash pop
```

Simpler but blocks the working directory while testing. Suitable for single-agent
workflows where no other session is active.

### Why file-level is sufficient (no hunk-level needed)

GitButler needs hunk-level tracking because of its **shared-directory overlay model**.
When you unapply branch B but B edited `runner.py` line 50 and A edited `runner.py`
line 200, GitButler must surgically remove only B's hunks while keeping A's.

**git-session doesn't have this problem** because branches are real git branches:
- Session A's `runner.py` has only A's changes on top of main
- Session B's `runner.py` has only B's changes on top of main
- No surgical removal needed — isolation is inherent

At **merge time** (PR or `--combine`), git handles non-overlapping changes in the same
file automatically. If hunks overlap, git reports a conflict — same as any team workflow.

For AI agents, file-level tracking is the right granularity. Agents tend to own entire
files or logical units, not share individual hunks within a file. If two agents touch
the same file, that's typically a signal they should be sequential.

## VS Code Extension

Sidebar panel showing real-time session state:

```
SESSION: a5f18c (active since 2:34pm)
Baseline: abc123

── Pending (3 files) ──────────────
  M  src/config.py
  M  src/runner.py
  A  tests/test_new.py

── Changeset #1 (2:45pm) ──────────
  "Add quote-level entry config"
  M  src/constants.py
  M  src/strategy/config.py

── Changeset #2 (3:12pm) ──────────
  "Wire config to strategy"
  M  src/strategy/spy_momentum.py

  [Commit Pending]  [Squash & PR]  [Test Isolated]
```

Extension is ~5 files, ~300 lines:

| File | Purpose |
|------|---------|
| `extension.ts` | Register commands, init sidebar |
| `sidebar.ts` | TreeView showing pending/changesets |
| `watcher.ts` | `onDidSaveTextDocument` → `git session track <file>` |
| `session-client.ts` | Shell out to `git-session` CLI |
| `test-runner.ts` | Worktree-based isolation test execution |

The extension calls the CLI. No duplicated logic.

## Claude Code Adapter

Three hooks that call `git-session`:

| Hook | Action |
|------|--------|
| `PreToolUse` (Write/Edit) | `git session track <file>` |
| `PostToolUse` | no-op (tracking happens pre) |
| `Stop` | `git session commit -m "session work"` |

User-triggered:
- "commit what we have" → `git session commit -m "description"`
- "squash and PR" → `git session squash -m "msg" && git session pr`
- "test my changes" → `git session test`

Install: `npx git-session install-hooks` → writes to `.claude/settings.json`

## Package Structure

```
git-session/
├── cli/                          # Core logic
│   ├── src/
│   │   ├── session.ts            # start, track, commit, squash, pr, end
│   │   ├── manifest.ts           # read/write .git/sessions/<id>.json
│   │   ├── git.ts                # thin git wrapper (diff, branch, commit)
│   │   ├── test.ts               # worktree-based isolation testing
│   │   └── conflicts.ts          # cross-session overlap detection
│   ├── bin/
│   │   └── git-session           # CLI entry point
│   └── package.json
│
├── vscode/                       # VS Code extension
│   ├── src/
│   │   ├── extension.ts
│   │   ├── sidebar.ts
│   │   ├── watcher.ts
│   │   ├── session-client.ts
│   │   └── test-runner.ts
│   └── package.json
│
├── adapters/
│   └── claude-code/              # Hook scripts
│       ├── hooks.json
│       └── install.sh
│
├── LICENSE                       # MIT
└── README.md
```

## Comparison: git-session vs GitButler

### Feature Coverage

| Feature | git-session | GitButler | Notes |
|---------|------------|-----------|-------|
| Session/branch tracking | ✓ | ✓ | |
| File-level change tracking | ✓ | ✓ | |
| Hunk-level change tracking | ✗ | ✓ | Not needed — branches are already isolated |
| Multiple branches simultaneously | Via worktree | Via overlay merge | Different model, same result |
| Test in isolation | ✓ worktree | ✓ unapply/apply | Worktree is better — non-destructive |
| Test combined sessions | ✓ `--combine` | ✓ apply both | Worktree merge vs permanent overlay |
| Baseline cursor (mid-session commit) | ✓ | ✗ | git-session advantage |
| Undo/rollback | ✓ per-changeset | ✓ full oplog snapshots | GitButler's is more granular |
| Conflict early warning | ✓ `conflicts` | ✓ real-time | GitButler's is automatic |
| Squash + PR | ✓ | ✓ | |
| AI commit messages | ✗ | ✓ | Agent writes its own |
| Stacked branches | ✗ | ✓ | Team workflow, not needed for AI sessions |
| Drag-and-drop UI | ✗ | ✓ | GUI feature, agents don't use |
| Standard git compatible | ✓ fully | ✗ read-only | git-session advantage |

### Architecture

| Aspect | git-session | GitButler |
|--------|------------|-----------|
| Working directory | One branch at a time (worktrees for parallel) | Permanent octopus merge of all applied branches |
| Branch storage | Real git branches (`refs/heads/session/*`) | Virtual branches (TOML + SQLite in `.git/gitbutler/`) |
| Isolation model | Default — each branch IS isolated | Opt-in — unapply other branches to isolate |
| Merge engine | Git's built-in merge | Custom merge engine (hunk-level) |
| State | JSON manifests in `.git/sessions/` | SQLite + TOML in `.git/gitbutler/` |
| Dependencies | git, gh (optional) | Rust binary, Tauri desktop app |
| Code size | ~550 lines total | ~100k+ lines |
| Git compatibility | Full — all git tools work | Partial — writes (`commit`, `checkout`, `merge`) break state |

### What git-session deliberately omits

| GitButler Feature | Why omitted |
|---|---|
| **Hunk-level assignment** | Unnecessary when branches are real git branches. Isolation is inherent. Git's merge handles non-overlapping hunks in the same file. |
| **Permanent workspace overlay** | Complexity driver. Forces custom merge engine, hunk tracking, and state corruption risk. Worktrees achieve the same isolation without it. |
| **Full oplog/snapshot undo** | Over-engineered for AI sessions. Per-changeset undo + git reflog covers the need. |
| **Stacked branches** | Team workflow for dependent PR chains. AI sessions are independent by nature. |
| **Desktop GUI** | VS Code sidebar is sufficient. Agents don't need drag-and-drop. |
| **Custom merge engine** | The source of most GitButler complexity and bugs. Git's merge is battle-tested. |

### What git-session does better

| Advantage | Why |
|---|---|
| **Isolation by default** | Each session branch has ONLY its changes. No unapply dance needed. |
| **Baseline cursor** | Mid-session commits advance the boundary cleanly. GitButler has no equivalent — each commit is independent. |
| **Non-destructive testing** | Worktrees don't touch the working directory. GitButler's unapply/apply modifies the tree. |
| **Full git compatibility** | `git log`, `git diff`, `git bisect`, lazygit, tig — everything works. GitButler breaks on any git write command. |
| **No state corruption risk** | JSON manifests are disposable. Worst case: delete `.git/sessions/` and start over. GitButler's SQLite + TOML state can corrupt and require `but teardown`. |
| **Portable** | Works with any AI agent, any editor, any CI. Not tied to a specific binary. |

## Why Not Just Git Branches?

You could manually `git checkout -b my-session`, work, commit, PR. The gap:

1. **No automatic file tracking** — you don't know what the AI agent changed
2. **No baseline cursor** — after mid-session commit, you lose the boundary
3. **No session isolation** — agent must manually manage branch switching
4. **No visibility** — VS Code has no sidebar showing session-specific state
5. **No isolation testing** — no `git session test` with automatic worktree management

git-session adds the tracking layer. Everything else is git.

## Open Questions

1. **Session ID source** — Claude Code provides `CLAUDE_SESSION_ID`. For other tools,
   generate a UUID or use PID? Allow user-provided names?
2. **Stale session cleanup** — sessions that never called `end`. Garbage collect after
   N days? `git session prune`?
3. **Cross-session file warnings** — warn in real-time when two sessions touch the same
   file, or only at `git session conflicts` time?
4. **Rebase vs merge** — should `git session commit` rebase onto latest main, or branch
   from original baseline? Rebase keeps history clean but can fail.
5. **Monorepo support** — path-scoped sessions (only track changes under `backend/`)?
6. **Test command customization** — allow `.git-session.json` config to define the test
   command (e.g., `uv run pytest tests/ -x -q`) so `git session test` runs it
   automatically in the worktree?

## Next Steps

1. Build CLI core (~300 lines TypeScript)
2. Build Claude Code hooks adapter (~50 lines)
3. Test with trading system (replace GitButler hooks)
4. Build VS Code extension (~300 lines)
5. Publish to npm + VS Code marketplace
6. Write README with demo GIF
