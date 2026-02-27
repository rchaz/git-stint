/**
 * Test helper: creates disposable git repos for testing.
 *
 * Each call returns a fresh git repo with an initial commit,
 * configured with test user/email to avoid leaking real identity.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

/**
 * Create a temporary git repository with an initial commit.
 * Automatically chdir's into the repo so git-stint functions work.
 *
 * @returns {{ dir: string, cleanup: () => void }}
 */
export function createTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "git-stint-test-"));
  const originalCwd = process.cwd();

  execFileSync("git", ["init", dir], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@git-stint.dev"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "git-stint-test"], { stdio: "pipe" });

  writeFileSync(join(dir, "README.md"), "# Test Repo\n");
  execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-m", "Initial commit"], { stdio: "pipe" });

  process.chdir(dir);

  return {
    dir,
    originalCwd,
    /**
     * Write a file to the repo (relative to repo root).
     */
    writeFile(relPath, content = "") {
      writeFileSync(join(dir, relPath), content);
    },
    /**
     * Restore CWD and delete the temp directory.
     */
    cleanup() {
      process.chdir(originalCwd);
      try {
        // Force-remove worktrees first (they create locks)
        execFileSync("git", ["-C", dir, "worktree", "prune"], { stdio: "pipe" });
      } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
