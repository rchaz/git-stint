/**
 * Tests for CLI argument parsing and command dispatch.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dirname, "..", "..", "dist", "cli.js");

function runCli(...args) {
  return execFileSync("node", [CLI, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function runCliInDir(dir, ...args) {
  return execFileSync("node", [CLI, ...args], {
    encoding: "utf-8",
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function runCliInDirFails(dir, ...args) {
  try {
    execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.fail("Expected CLI to exit with non-zero");
  } catch (err) {
    return {
      stderr: (err.stderr || "").trim(),
      stdout: (err.stdout || "").trim(),
    };
  }
}

function runCliFails(...args) {
  try {
    execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.fail("Expected CLI to exit with non-zero");
  } catch (err) {
    return (err.stderr || "").trim();
  }
}

function createCliTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "git-stint-cli-test-"));
  execFileSync("git", ["init", dir], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@git-stint.dev"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "git-stint-test"], { stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-m", "Initial commit"], { stdio: "pipe" });
  return dir;
}

describe("CLI", () => {
  describe("--version", () => {
    it("prints version with --version", () => {
      const output = runCli("--version");
      assert.match(output, /git-stint \d+\.\d+\.\d+/);
    });

    it("prints version with -v", () => {
      const output = runCli("-v");
      assert.match(output, /git-stint \d+\.\d+\.\d+/);
    });

    it("prints version with version command", () => {
      const output = runCli("version");
      assert.match(output, /git-stint \d+\.\d+\.\d+/);
    });
  });

  describe("help", () => {
    it("prints help with no arguments", () => {
      const output = runCli();
      assert.ok(output.includes("Usage:"));
      assert.ok(output.includes("Commands:"));
    });

    it("prints help with --help", () => {
      const output = runCli("--help");
      assert.ok(output.includes("install-hooks"));
    });

    it("includes version in help output", () => {
      const output = runCli("help");
      assert.match(output, /git-stint \d+\.\d+\.\d+/);
    });
  });

  describe("unknown command", () => {
    it("reports unknown command", () => {
      const stderr = runCliFails("nonexistent");
      assert.ok(stderr.includes("Unknown command: nonexistent"));
    });
  });

  describe("help includes uninstall-hooks", () => {
    it("lists uninstall-hooks in help output", () => {
      const output = runCli("help");
      assert.ok(output.includes("uninstall-hooks"));
    });
  });
});

describe("CLI flag parsing", () => {
  it("commit requires -m flag", () => {
    const stderr = runCliFails("commit");
    assert.ok(stderr.includes("Usage: git stint commit"));
  });

  it("squash requires -m flag", () => {
    const stderr = runCliFails("squash");
    assert.ok(stderr.includes("Usage: git stint squash"));
  });

  it("track requires file arguments", () => {
    const stderr = runCliFails("track");
    assert.ok(stderr.includes("Usage: git stint track"));
  });
});

describe("CLI commands via binary", () => {
  let repoDir;

  beforeEach(() => {
    repoDir = createCliTempRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("start creates a session via CLI", () => {
    const output = runCliInDir(repoDir, "start", "cli-test");
    assert.ok(output.includes("Session 'cli-test' started"));
    assert.ok(output.includes("stint/cli-test"));
  });

  it("list --json outputs valid JSON via CLI", () => {
    runCliInDir(repoDir, "start", "json-cli");
    const output = runCliInDir(repoDir, "list", "--json");
    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "json-cli");
  });

  it("commit with -m flag via CLI", () => {
    runCliInDir(repoDir, "start", "commit-cli");
    const wtDir = join(repoDir, ".stint", "commit-cli");
    writeFileSync(join(wtDir, "new.txt"), "content\n");
    const output = runCliInDir(wtDir, "commit", "-m", "CLI commit");
    assert.ok(output.includes("Committed"));
    assert.ok(output.includes("CLI commit"));
  });

  it("--session flag specifies session explicitly", () => {
    runCliInDir(repoDir, "start", "explicit");
    const output = runCliInDir(repoDir, "status", "--session", "explicit");
    assert.ok(output.includes("explicit"));
    assert.ok(output.includes("stint/explicit"));
  });

  it("--session=value syntax works", () => {
    runCliInDir(repoDir, "start", "eq-syntax");
    const output = runCliInDir(repoDir, "status", "--session=eq-syntax");
    assert.ok(output.includes("eq-syntax"));
  });
});

describe("install-hooks / uninstall-hooks", () => {
  let tmpDir;
  let settingsPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-stint-hooks-test-"));
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    settingsPath = join(claudeDir, "settings.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("install adds hooks and uninstall removes them", async () => {
    const { install, uninstall } = await import("../../dist/install-hooks.js");

    // Run install with project scope from tmpDir
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      install("project");

      // Verify hooks were added
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.ok(settings.hooks);
      assert.ok(settings.hooks.PreToolUse);
      assert.ok(settings.hooks.Stop);
      assert.ok(settings.hooks.PreToolUse.some((h) =>
        h.hooks?.some((hh) => hh.command === "git-stint-hook-pre-tool")));
      assert.ok(settings.hooks.Stop.some((h) =>
        h.hooks?.some((hh) => hh.command === "git-stint-hook-stop")));

      // Now uninstall
      uninstall("project");

      // Verify hooks were removed
      const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.ok(!after.hooks, "hooks key should be removed when empty");
    } finally {
      process.chdir(origCwd);
    }
  });

  it("uninstall preserves non-stint hooks", async () => {
    const { install, uninstall } = await import("../../dist/install-hooks.js");

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // Write settings with an existing non-stint hook
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Write", hooks: [{ type: "command", command: "my-other-hook" }] },
          ],
        },
      }, null, 2));

      // Install stint hooks
      install("project");

      // Verify both hooks exist
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.equal(settings.hooks.PreToolUse.length, 2);

      // Uninstall stint hooks
      uninstall("project");

      // Verify only the non-stint hook remains
      const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.ok(after.hooks.PreToolUse);
      assert.equal(after.hooks.PreToolUse.length, 1);
      assert.equal(after.hooks.PreToolUse[0].hooks[0].command, "my-other-hook");
    } finally {
      process.chdir(origCwd);
    }
  });

  it("uninstall reports nothing when no hooks present", async () => {
    const { uninstall } = await import("../../dist/install-hooks.js");

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      writeFileSync(settingsPath, "{}");
      const logs = [];
      const origLog = console.log;
      console.log = (...a) => logs.push(a.join(" "));
      try {
        uninstall("project");
      } finally {
        console.log = origLog;
      }
      assert.ok(logs.some((l) => l.includes("Nothing to uninstall")));
    } finally {
      process.chdir(origCwd);
    }
  });
});
