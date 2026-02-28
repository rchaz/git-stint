# Contributing to git-stint

Thanks for your interest in contributing! git-stint is a small, focused tool — contributions that keep it simple and reliable are welcome.

## Quick Links

- [Issues](https://github.com/rchaz/git-stint/issues) — Bug reports and feature requests
- [README](README.md) — Usage and commands

## Reporting Bugs

Please include:
1. **What happened** — actual behavior
2. **What you expected** — expected behavior
3. **Steps to reproduce** — minimal reproduction
4. **Environment** — OS, Node.js version, git version

## Development Setup

**Prerequisites:**
- Node.js 20+
- git 2.20+ (worktree support)
- `gh` CLI (optional, for PR creation)

**Setup:**

```bash
git clone https://github.com/rchaz/git-stint.git
cd git-stint
npm install
npm run build
npm link    # Install globally as `git-stint`
```

**Build:**

```bash
npm run build       # Compile TypeScript → dist/
npm run dev         # Watch mode
```

## Testing

Tests use Node.js built-in `node:test` runner — no external test framework.

```bash
npm test                  # Unit tests (fast)
npm run test:security     # Security validation
npm run test:integration  # Full lifecycle tests
npm run test:all          # Everything
```

**Test structure:**

```
test/
├── helpers/
│   └── temp-repo.js           # Creates disposable git repos
├── unit/
│   ├── cli.test.js             # CLI arg parsing, hook installation
│   ├── config.test.js          # Config loading + validation
│   ├── hook-pre-tool.test.js   # PreToolUse hook (gitignore, policy enforcement)
│   ├── manifest.test.js        # Manifest CRUD + session resolution
│   ├── session.test.js         # All session commands
│   └── test-session.test.js    # Worktree-based test execution
├── security/
│   └── validation.test.js      # Injection prevention, name validation
└── integration/
    └── lifecycle.test.js        # Full start → commit → squash → end flows
```

Each test creates a temporary git repo, runs operations, and cleans up. Tests are isolated — no shared state.

## Project Structure

```
src/
├── git.ts              # Git plumbing (execFileSync wrappers)
├── manifest.ts         # Session state: JSON in .git/sessions/
├── session.ts          # Commands: start, commit, squash, pr, end...
├── config.ts           # .stint.json loading + validation
├── conflicts.ts        # Cross-session file overlap detection
├── test-session.ts     # Worktree-based test execution
├── install-hooks.ts    # Claude Code hook installation/removal
└── cli.ts              # Entry point, arg parsing

adapters/
└── claude-code/
    └── hooks/          # PreToolUse + Stop hook scripts (bash)

test/                # All tests (see above)
```

## Pull Request Guidelines

1. **Keep PRs focused** — one feature or fix per PR
2. **Run tests** — `npm run test:all` must pass
3. **Build must succeed** — `npm run build` with no errors
4. **Follow existing patterns** — match the code style you see
5. **No new dependencies** — git-stint has zero runtime dependencies by design

### Commit Messages

Use imperative form:
```
Fix session resolution when CWD is in nested subdirectory
Add --dry-run flag to squash command
```

### Security Rules

- **Never use `execSync` with string arguments** — always `execFileSync` with array args
- **Validate all user input** — session names, file paths
- **Atomic writes** — use temp file + rename for manifest writes

## Design Principles

git-stint is deliberately minimal. Before adding something, ask:

1. **Does git already do this?** — If yes, don't wrap it.
2. **Is this needed for AI agent workflows?** — If not, it's out of scope.
3. **Can this corrupt state?** — If yes, add safeguards.
4. **Does this add a dependency?** — If yes, find another way.

### What we explicitly don't do

- Hunk-level tracking (branches are already isolated)
- Custom merge engine (git's merge is sufficient)
- Stacked branches (sessions are independent)
- Desktop GUI (CLI + editor integrations are enough)

## AI Contributions

If you used AI tools to help write code, that's fine — mention it in the PR description. All contributions are reviewed the same way regardless of how they were written.

## Security Vulnerabilities

If you find a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/rchaz/git-stint/security/advisories) rather than opening a public issue.
