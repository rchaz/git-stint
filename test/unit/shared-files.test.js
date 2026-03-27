import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTempRepo } from "../helpers/temp-repo.js";
import { start, end } from "../../dist/session.js";
import { loadManifest, getWorktreePath } from "../../dist/manifest.js";

let repo;

describe("shared_files", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("copies configured files into new worktree", () => {
    // Create files to share
    writeFileSync(join(repo.dir, ".env"), "SECRET=abc123\n");
    writeFileSync(join(repo.dir, ".python-version"), "3.12\n");

    // Configure shared_files
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_files: [".env", ".python-version"],
    }));

    start("shared-test");
    const m = loadManifest("shared-test");
    const wt = getWorktreePath(m);

    assert.ok(existsSync(join(wt, ".env")), ".env should be copied to worktree");
    assert.ok(existsSync(join(wt, ".python-version")), ".python-version should be copied");
    assert.equal(readFileSync(join(wt, ".env"), "utf-8"), "SECRET=abc123\n");
    assert.equal(readFileSync(join(wt, ".python-version"), "utf-8"), "3.12\n");

    end("shared-test");
  });

  it("skips files that do not exist with a warning", () => {
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_files: ["nonexistent.txt"],
    }));

    // Should not throw
    start("missing-file");
    const m = loadManifest("missing-file");
    const wt = getWorktreePath(m);
    assert.ok(!existsSync(join(wt, "nonexistent.txt")));
    end("missing-file");
  });

  it("does not overwrite files already in worktree", () => {
    // Create a file that's tracked in git
    writeFileSync(join(repo.dir, "existing.txt"), "from-git\n");
    execFileSync("git", ["-C", repo.dir, "add", "existing.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo.dir, "commit", "-m", "add existing"], { stdio: "pipe" });

    // Also create it as a shared_file with different content
    writeFileSync(join(repo.dir, "existing.txt"), "from-main-updated\n");

    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_files: ["existing.txt"],
      adopt_changes: "never",
    }));

    start("no-overwrite");
    const m = loadManifest("no-overwrite");
    const wt = getWorktreePath(m);

    // The worktree should have the git-tracked version, not the copied one
    assert.equal(readFileSync(join(wt, "existing.txt"), "utf-8"), "from-git\n");
    end("no-overwrite");
  });

  it("copies files in nested directories", () => {
    mkdirSync(join(repo.dir, "config"), { recursive: true });
    writeFileSync(join(repo.dir, "config/secrets.yaml"), "key: value\n");

    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_files: ["config/secrets.yaml"],
    }));

    start("nested-file");
    const m = loadManifest("nested-file");
    const wt = getWorktreePath(m);
    assert.ok(existsSync(join(wt, "config/secrets.yaml")));
    assert.equal(readFileSync(join(wt, "config/secrets.yaml"), "utf-8"), "key: value\n");
    end("nested-file");
  });

  it("rejects path traversal attempts", () => {
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_files: ["../../../etc/passwd"],
      adopt_changes: "never",
    }));

    // Should not throw, but should skip the traversal path
    start("traversal-test");
    const m = loadManifest("traversal-test");
    const wt = getWorktreePath(m);
    assert.ok(!existsSync(join(wt, "../../../etc/passwd")));
    end("traversal-test");
  });
});

describe("post_create", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("runs configured commands in the new worktree", () => {
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      post_create: ["touch setup-ran.txt"],
    }));

    start("hook-test");
    const m = loadManifest("hook-test");
    const wt = getWorktreePath(m);
    assert.ok(existsSync(join(wt, "setup-ran.txt")), "post_create command should have run in worktree");
    end("hook-test");
  });

  it("runs multiple commands in sequence", () => {
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      post_create: ["echo first > first.txt", "echo second > second.txt"],
    }));

    start("multi-hook");
    const m = loadManifest("multi-hook");
    const wt = getWorktreePath(m);
    assert.ok(existsSync(join(wt, "first.txt")));
    assert.ok(existsSync(join(wt, "second.txt")));
    end("multi-hook");
  });

  it("continues after a failing command with a warning", () => {
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      post_create: ["false", "touch after-failure.txt"],
    }));

    // Should not throw — failing hooks are warnings, not errors
    start("fail-hook");
    const m = loadManifest("fail-hook");
    const wt = getWorktreePath(m);
    assert.ok(existsSync(join(wt, "after-failure.txt")), "subsequent commands should still run");
    end("fail-hook");
  });

  it("accepts a single string for post_create", () => {
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      post_create: "touch single.txt",
    }));

    start("single-hook");
    const m = loadManifest("single-hook");
    const wt = getWorktreePath(m);
    assert.ok(existsSync(join(wt, "single.txt")));
    end("single-hook");
  });
});
