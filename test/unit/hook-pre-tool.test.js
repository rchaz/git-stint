/**
 * Tests for the PreToolUse hook (git-stint-hook-pre-tool).
 *
 * Executes the actual bash hook script against temp repos
 * to verify file-path routing, gitignore bypass, and policy enforcement.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTempRepo } from "../helpers/temp-repo.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

const HOOK_PATH = join(PROJECT_ROOT, "adapters", "claude-code", "hooks", "git-stint-hook-pre-tool");

// Ensure the project's bin/ is on PATH so the hook can find `git-stint`.
// In CI, git-stint is not installed globally — it's only available via the local bin/.
const BIN_PATH = join(PROJECT_ROOT, "bin");
const TEST_ENV = { ...process.env, PATH: `${BIN_PATH}:${process.env.PATH}` };

/**
 * Run the PreToolUse hook with a given file_path.
 * Returns { exitCode, stderr, stdout }.
 */
function runHook(filePath, cwd) {
  const input = JSON.stringify({ tool_input: { file_path: filePath } });
  try {
    const stdout = execFileSync("bash", [HOOK_PATH], {
      input,
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: TEST_ENV,
    });
    return { exitCode: 0, stderr: "", stdout };
  } catch (err) {
    return {
      exitCode: err.status,
      stderr: err.stderr || "",
      stdout: err.stdout || "",
    };
  }
}

/**
 * Create a temp repo and resolve its path through symlinks.
 * On macOS, /tmp → /private/tmp, but git rev-parse --show-toplevel
 * resolves symlinks. Paths must match for the hook's "inside repo" check.
 */
function createResolvedTempRepo() {
  const repo = createTempRepo();
  const realDir = realpathSync(repo.dir);
  return { ...repo, dir: realDir };
}

describe("hook: gitignore bypass", () => {
  let repo;

  beforeEach(() => {
    repo = createResolvedTempRepo();
    // Set policy to "prompt" so non-ignored files get blocked (exit 2)
    writeFileSync(
      join(repo.dir, ".stint.json"),
      JSON.stringify({ main_branch_policy: "prompt" }),
    );
    execFileSync("git", ["-C", repo.dir, "add", ".stint.json"], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", repo.dir, "commit", "-m", "Add stint config"],
      { stdio: "pipe" },
    );
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("allows writes to gitignored files", () => {
    writeFileSync(join(repo.dir, ".gitignore"), "node_modules/\n*.log\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", repo.dir, "commit", "-m", "Add gitignore"],
      { stdio: "pipe" },
    );

    const result = runHook(join(repo.dir, "node_modules", "foo", "index.js"), repo.dir);
    assert.equal(result.exitCode, 0, "gitignored file should be allowed");
  });

  it("blocks writes to non-gitignored files under prompt policy", () => {
    const result = runHook(join(repo.dir, "src", "app.ts"), repo.dir);
    assert.equal(result.exitCode, 2, "non-ignored file should be blocked");
    assert.ok(result.stderr.includes("BLOCKED"), "should show BLOCKED message");
  });

  it("allows writes to files matching wildcard gitignore patterns", () => {
    writeFileSync(join(repo.dir, ".gitignore"), "*.log\ndist/\n.env*\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", repo.dir, "commit", "-m", "Add gitignore"],
      { stdio: "pipe" },
    );

    const cases = [
      [join(repo.dir, "debug.log"), "*.log pattern"],
      [join(repo.dir, "dist", "bundle.js"), "dist/ pattern"],
      [join(repo.dir, ".env"), ".env* pattern"],
      [join(repo.dir, ".env.local"), ".env* pattern"],
    ];

    for (const [filePath, desc] of cases) {
      const result = runHook(filePath, repo.dir);
      assert.equal(result.exitCode, 0, `${desc}: ${filePath} should be allowed`);
    }
  });

  it("respects negation patterns in .gitignore", () => {
    writeFileSync(join(repo.dir, ".gitignore"), "*.log\n!important.log\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", repo.dir, "commit", "-m", "Add gitignore with negation"],
      { stdio: "pipe" },
    );

    // debug.log is ignored → allowed
    const ignored = runHook(join(repo.dir, "debug.log"), repo.dir);
    assert.equal(ignored.exitCode, 0, "debug.log should be allowed (ignored)");

    // important.log is NOT ignored (negation) → blocked
    const notIgnored = runHook(join(repo.dir, "important.log"), repo.dir);
    assert.equal(notIgnored.exitCode, 2, "important.log should be blocked (negation pattern)");
  });

  it("respects nested .gitignore files", () => {
    writeFileSync(join(repo.dir, ".gitignore"), "");
    mkdirSync(join(repo.dir, "sub"), { recursive: true });
    writeFileSync(join(repo.dir, "sub", ".gitignore"), "*.tmp\n");
    execFileSync("git", ["-C", repo.dir, "add", "-A"], { stdio: "pipe" });
    execFileSync(
      "git",
      ["-C", repo.dir, "commit", "-m", "Add nested gitignore"],
      { stdio: "pipe" },
    );

    // sub/test.tmp is ignored by sub/.gitignore → allowed
    const ignored = runHook(join(repo.dir, "sub", "test.tmp"), repo.dir);
    assert.equal(ignored.exitCode, 0, "sub/test.tmp should be allowed");

    // root test.tmp is NOT ignored → blocked
    const notIgnored = runHook(join(repo.dir, "test.tmp"), repo.dir);
    assert.equal(notIgnored.exitCode, 2, "root test.tmp should be blocked");
  });

  it("respects .git/info/exclude", () => {
    const excludePath = join(repo.dir, ".git", "info", "exclude");
    mkdirSync(join(repo.dir, ".git", "info"), { recursive: true });
    writeFileSync(excludePath, "secret_file\n");

    const result = runHook(join(repo.dir, "secret_file"), repo.dir);
    assert.equal(result.exitCode, 0, "file in .git/info/exclude should be allowed");
  });

  it("handles nonexistent gitignored paths (file not yet created)", () => {
    writeFileSync(join(repo.dir, ".gitignore"), "build/\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", repo.dir, "commit", "-m", "Add gitignore"],
      { stdio: "pipe" },
    );

    assert.ok(!existsSync(join(repo.dir, "build", "output.js")));
    const result = runHook(join(repo.dir, "build", "output.js"), repo.dir);
    assert.equal(result.exitCode, 0, "nonexistent gitignored path should be allowed");
  });
});

describe("hook: policy enforcement (non-gitignored files)", () => {
  let repo;

  beforeEach(() => {
    repo = createResolvedTempRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("allows writes under allow policy", () => {
    writeFileSync(
      join(repo.dir, ".stint.json"),
      JSON.stringify({ main_branch_policy: "allow" }),
    );
    execFileSync("git", ["-C", repo.dir, "add", ".stint.json"], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", repo.dir, "commit", "-m", "Add config"],
      { stdio: "pipe" },
    );

    const result = runHook(join(repo.dir, "src", "app.ts"), repo.dir);
    assert.equal(result.exitCode, 0, "allow policy should permit writes");
  });

  it("blocks writes under prompt policy without allow-main flag", () => {
    writeFileSync(
      join(repo.dir, ".stint.json"),
      JSON.stringify({ main_branch_policy: "prompt" }),
    );
    execFileSync("git", ["-C", repo.dir, "add", ".stint.json"], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", repo.dir, "commit", "-m", "Add config"],
      { stdio: "pipe" },
    );

    const result = runHook(join(repo.dir, "src", "app.ts"), repo.dir);
    assert.equal(result.exitCode, 2, "prompt policy should block");
    assert.ok(result.stderr.includes("BLOCKED"));
  });

  it("allows writes to files outside the repo", () => {
    const result = runHook("/tmp/some-other-file.txt", repo.dir);
    assert.equal(result.exitCode, 0, "file outside repo should be allowed");
  });

  it("allows writes when no file_path in input", () => {
    const input = JSON.stringify({ tool_input: { command: "ls" } });
    try {
      execFileSync("bash", [HOOK_PATH], {
        input,
        cwd: repo.dir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: TEST_ENV,
      });
    } catch (err) {
      assert.fail(`hook should allow when no file_path: exit ${err.status}`);
    }
  });
});
