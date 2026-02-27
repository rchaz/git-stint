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

## Coding Rules

- Use `execFileSync` (array args), NEVER `execSync` (string args)
- Use `getGitCommonDir()` not `getGitDir()` — worktrees have different git dirs
- Use `getRepoRoot()` not `getTopLevel()` — the latter returns worktree root
- Use `saveManifest()` for writes — atomic temp+rename
- Session names: `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, no `..`, no spaces
- Zero runtime dependencies

## When Making Changes

1. `npm run build` to check compilation
2. `npm run test:all` to verify all tests pass
3. New commands need tests in `test/unit/session.test.js`
4. Git operations go through `src/git.ts` — don't call git directly
5. Manifest changes must be backward compatible

## Publishing

After changes are committed and pushed to `main`, publish to npm:

1. Bump the version in **both** `package.json` and `package-lock.json`
2. Commit: `git commit -am "v0.X.Y"`
3. Push: `git push origin main`
4. Tag and push: `git tag v0.X.Y && git push origin v0.X.Y`

The tag push triggers CI (tests on ubuntu + macos, Node 22 + 24) then publishes to npm.
Use **patch** bumps for fixes, **minor** bumps for features.
