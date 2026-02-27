# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/rchaz/git-stint/security/advisories).

**Do not open a public issue for security vulnerabilities.**

## In-Scope Vulnerabilities

- Command injection via session names, file paths, or commit messages
- Path traversal in worktree or manifest operations
- Manifest corruption leading to data loss
- Unintended code execution via hooks
- Git state corruption from concurrent operations

## Out-of-Scope

- Issues requiring physical access to the machine
- Social engineering attacks
- Denial of service via large repositories
- Bugs in git itself
- Issues in the `gh` CLI

## Security Model

git-stint follows these security principles:

### Command Execution
- All git commands use `execFileSync` with array arguments (never `execSync` with string interpolation)
- The `gh` CLI is called via `execFileSync` with explicit argument arrays
- Test commands use `execFileSync("sh", ["-c", cmd])` — the command string comes from the user, not from untrusted input

### Input Validation
- Session names are validated against `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`
- Path traversal (`..`) is explicitly rejected
- Shell metacharacters (`;`, `|`, `&`, etc.) are rejected in session names

### State Safety
- Manifest writes use atomic temp-file-then-rename pattern
- Cleanup operations delete manifest last (enables `prune` recovery)
- Branch and worktree creation has rollback on failure

### Automated Verification
- Security tests scan source code to verify `execFileSync` usage
- Name validation tests cover injection attempts
- These tests run in CI on every push

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
