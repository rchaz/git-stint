# CLAUDE.md — Instructions for AI Agents

This file tells Claude Code (and other AI agents) how to work with the git-stint codebase.

## What is git-stint?

Session-scoped change tracking for AI coding agents. Each session = real git branch + worktree. `git stint` handles all branch/worktree management.

## Project Structure

```
src/
├── git.ts           # Git plumbing wrapper (execFileSync, no shell)
├── manifest.ts      # Session state CRUD (.git/sessions/<name>.json)
├── session.ts       # Core commands (start, commit, squash, pr, end...)
├── conflicts.ts     # Cross-session file overlap detection
├── test-session.ts  # Worktree-based test execution
└── cli.ts           # Entry point, arg parsing

adapters/claude-code/
├── hooks/           # PreToolUse + Stop hook scripts (bash)
└── install.ts       # Hook installer

test/
├── helpers/         # Test utilities (temp repo creation)
├── unit/            # Unit tests for manifest and session
├── security/        # Injection prevention, name validation
└── integration/     # Full lifecycle tests
```

## Build & Test

```bash
npm run build              # Compile TypeScript
npm test                   # Unit tests
npm run test:security      # Security tests
npm run test:integration   # Integration tests
npm run test:all           # Everything
```

Always run `npm run build` before testing — tests import from `dist/`.

## Key Rules

### Git Operations
- Use `execFileSync` (array args) NEVER `execSync` (string args)
- Use `getGitCommonDir()` not `getGitDir()` — worktrees have different git dirs
- Use `getRepoRoot()` not `getTopLevel()` — the latter returns worktree root

### Manifests
- Always use `saveManifest()` for writes — it does atomic temp+rename
- Include `version: MANIFEST_VERSION` when creating new manifests
- `loadManifest()` returns null for missing or corrupted files

### Session Names
- Validated: `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`
- No `..`, no shell metacharacters, no spaces
- Empty string `""` falls through to random name generation

### Testing
- Tests use `node:test` (built-in, no external framework)
- Each test creates a temp git repo via `createTempRepo()`
- Tests `process.chdir()` into the temp repo, clean up in `afterEach`
- Tests import from `../../dist/` (compiled output)

## Dependencies

Zero runtime dependencies. Dev dependencies: TypeScript + @types/node only.

## When Making Changes

1. Run `npm run build` to check compilation
2. Run `npm run test:all` to verify all tests pass
3. If adding new commands, add corresponding tests in `test/unit/session.test.js`
4. If adding git operations, use functions from `src/git.ts` — don't call git directly
5. If modifying manifests, ensure backward compatibility (check `loadManifest` version defaulting)

## Publishing

After changes are committed and pushed to `main`, publish to npm:

1. Bump the version in **both** `package.json` and `package-lock.json`
2. Commit: `git commit -am "v0.X.Y"`
3. Push: `git push origin main`
4. Tag and push: `git tag v0.X.Y && git push origin v0.X.Y`

The tag push triggers CI (tests on ubuntu + macos, Node 22 + 24) then publishes to npm.
Use **patch** bumps for fixes, **minor** bumps for features.
