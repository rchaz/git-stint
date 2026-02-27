import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as git from "./git.js";
import { WORKTREE_DIR } from "./manifest.js";
import { resolveSession, getWorktreePath, loadManifest, getRepoRoot } from "./manifest.js";

/**
 * Run a command in a directory. Uses shell: true to support piped/complex commands,
 * but passes the command as a single string to execFileSync to avoid arg-splitting issues.
 */
function runCommand(cmd: string, cwd: string): void {
  // Use execFileSync with shell to handle commands like "npm test" or "pytest -x"
  // while still avoiding uncontrolled injection from file paths.
  execFileSync("sh", ["-c", cmd], { cwd, stdio: "inherit" });
}

/**
 * Run tests in the current session's worktree.
 * The worktree already contains only this session's changes — it's isolated by default.
 */
export function test(sessionName?: string, testCmd?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);

  const cmd = testCmd || detectTestCommand(worktree);
  if (!cmd) {
    throw new Error("No test command detected. Pass a command: git stint test -- <command>");
  }

  console.log(`Running tests in ${worktree}...`);
  console.log(`  $ ${cmd}\n`);

  try {
    runCommand(cmd, worktree);
    console.log("\nTests passed.");
  } catch {
    // Throw instead of process.exit so callers can handle it.
    // cli.ts will catch and exit with code 1.
    throw new Error("Tests failed.");
  }
}

/**
 * Test multiple sessions combined by creating a temporary worktree
 * with an octopus merge of all specified session branches.
 *
 * Uses --detach to avoid "branch already checked out" errors,
 * then creates a temporary branch for the merge.
 */
export function testCombine(sessionNames: string[], testCmd?: string): void {
  const topLevel = getRepoRoot();
  const mainBranch = git.getDefaultBranch();
  const tmpName = `stint-combine-${Date.now()}`;
  const tmpWorktree = resolve(topLevel, `${WORKTREE_DIR}/${tmpName}`);

  // Validate all sessions exist
  const branches: string[] = [];
  for (const name of sessionNames) {
    const m = loadManifest(name);
    if (!m) throw new Error(`Session '${name}' not found.`);
    branches.push(m.branch);
  }

  console.log(`Testing combined: ${sessionNames.join(" + ")}`);

  try {
    // Create temp worktree in detached HEAD to avoid "already checked out" error
    git.addWorktreeDetached(tmpWorktree, mainBranch);

    // Create a temporary branch for the merge
    git.gitInDir(tmpWorktree, "checkout", "-b", tmpName);

    // Merge all session branches
    try {
      git.gitInDir(tmpWorktree, "merge", ...branches);
    } catch (err: unknown) {
      const e = err as Error;
      throw new Error(`Merge conflicts detected when combining sessions: ${e.message}`);
    }

    const cmd = testCmd || detectTestCommand(tmpWorktree);
    if (!cmd) {
      throw new Error("No test command detected. Pass a command: git stint test --combine A B -- <command>");
    }

    console.log(`Running: ${cmd}\n`);
    try {
      runCommand(cmd, tmpWorktree);
      console.log("\nCombined tests passed.");
    } catch {
      throw new Error("Combined tests failed.");
    }
  } finally {
    // Clean up temp worktree — always runs, even when we throw
    if (existsSync(tmpWorktree)) {
      try {
        git.removeWorktree(tmpWorktree, true);
      } catch { /* best effort */ }
    }
    // Delete the temp branch
    try {
      git.deleteBranch(tmpName);
    } catch { /* may not exist */ }
  }
}

function detectTestCommand(dir: string): string | null {
  if (existsSync(resolve(dir, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8"));
      if (pkg.scripts?.test && !pkg.scripts.test.includes("no test specified")) {
        return "npm test";
      }
    } catch { /* ignore */ }
  }

  if (existsSync(resolve(dir, "pyproject.toml")) || existsSync(resolve(dir, "pytest.ini"))) {
    return "pytest";
  }

  if (existsSync(resolve(dir, "Cargo.toml"))) {
    return "cargo test";
  }

  if (existsSync(resolve(dir, "go.mod"))) {
    return "go test ./...";
  }

  if (existsSync(resolve(dir, "Makefile"))) {
    try {
      const makefile = readFileSync(resolve(dir, "Makefile"), "utf-8");
      if (makefile.includes("test:")) {
        return "make test";
      }
    } catch { /* ignore */ }
  }

  return null;
}
