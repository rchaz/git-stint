import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createTempRepo } from "../helpers/temp-repo.js";
import {
  start,
  track,
  status,
  diff,
  sessionCommit,
  log,
  squash,
  merge,
  undo,
  end,
  abort,
  list,
  listJson,
  prune,
  allowMain,
} from "../../dist/session.js";
import {
  loadManifest,
  listManifests,
  getWorktreePath,
} from "../../dist/manifest.js";
import * as git from "../../dist/git.js";

let repo;

describe("session", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  describe("start()", () => {
    it("creates a branch, worktree, and manifest", () => {
      start("my-feature");
      const m = loadManifest("my-feature");
      assert.ok(m, "manifest should exist");
      assert.equal(m.name, "my-feature");
      assert.equal(m.branch, "stint/my-feature");
      assert.equal(m.worktree, ".stint/my-feature");
      assert.ok(m.startedAt.length > 0, "startedAt should be set");
      assert.equal(m.baseline, m.startedAt);
      assert.deepStrictEqual(m.changesets, []);
      assert.deepStrictEqual(m.pending, []);
      assert.equal(m.version, 1);

      // Branch should exist
      assert.ok(git.branchExists("stint/my-feature"));

      // Worktree should exist
      const wtPath = getWorktreePath(m);
      assert.ok(existsSync(wtPath));
    });

    it("generates a name when none provided", () => {
      start();
      const manifests = listManifests();
      assert.equal(manifests.length, 1);
      assert.ok(manifests[0].name.includes("-"), "generated name should be adjective-noun");
    });

    it("rejects invalid names", () => {
      assert.throws(() => start("../evil"), /Invalid session name/);
      assert.throws(() => start("; rm -rf /"), /Invalid session name/);
      assert.throws(() => start("  "), /cannot be empty/);
      assert.throws(() => start("-starts-with-dash"), /Invalid session name/);
    });

    it("rejects names with path traversal", () => {
      assert.throws(() => start("foo..bar"), /cannot contain/);
    });

    it("appends suffix for duplicate names", () => {
      start("dupe");
      start("dupe");
      const manifests = listManifests();
      assert.equal(manifests.length, 2);
      const names = manifests.map((m) => m.name).sort();
      assert.deepStrictEqual(names, ["dupe", "dupe-2"]);
    });

    it("throws in non-git directory", () => {
      const { cleanup: c } = createTempNonGitDir();
      try {
        assert.throws(() => start("test"), /Not inside a git repository/);
      } finally {
        c();
      }
    });

    it("adds .stint/ to .git/info/exclude", () => {
      start("excluded");
      const commonDir = git.getGitCommonDir();
      const excludePath = join(commonDir, "info", "exclude");
      const content = readFileSync(excludePath, "utf-8");
      assert.ok(content.includes(".stint/"));
    });

    it("rolls back branch on worktree failure", () => {
      // Create a file where the worktree would go to cause a failure
      const wtDir = join(repo.dir, ".stint", "blocker");
      execFileSync("mkdir", ["-p", wtDir]);
      writeFileSync(join(wtDir, "conflict"), "blocks worktree");
      // git worktree add will fail because directory exists with content
      // The branch should be cleaned up
      const branchExistedBefore = git.branchExists("stint/blocker");
      assert.equal(branchExistedBefore, false);
      try {
        start("blocker");
      } catch {
        // Expected failure — verify branch was rolled back
        assert.equal(git.branchExists("stint/blocker"), false);
      }
    });
  });

  describe("track()", () => {
    it("adds files to pending list", () => {
      start("track-test");
      const m = loadManifest("track-test");
      const wt = getWorktreePath(m);
      process.chdir(wt);

      track(["src/foo.ts", "src/bar.ts"], "track-test");
      const updated = loadManifest("track-test");
      assert.deepStrictEqual(updated.pending, ["src/foo.ts", "src/bar.ts"]);
    });

    it("deduplicates files", () => {
      start("dedup-test");
      const m = loadManifest("dedup-test");
      const wt = getWorktreePath(m);
      process.chdir(wt);

      track(["src/foo.ts"], "dedup-test");
      track(["src/foo.ts", "src/bar.ts"], "dedup-test");
      const updated = loadManifest("dedup-test");
      assert.deepStrictEqual(updated.pending, ["src/foo.ts", "src/bar.ts"]);
    });

    it("handles absolute paths inside worktree", () => {
      start("abs-test");
      const m = loadManifest("abs-test");
      const wt = getWorktreePath(m);
      process.chdir(wt);

      track([join(wt, "src/absolute.ts")], "abs-test");
      const updated = loadManifest("abs-test");
      assert.deepStrictEqual(updated.pending, ["src/absolute.ts"]);
    });
  });

  describe("sessionCommit()", () => {
    it("commits changes and advances baseline", () => {
      start("commit-test");
      const m = loadManifest("commit-test");
      const wt = getWorktreePath(m);
      const originalBaseline = m.baseline;

      // Make a change in the worktree
      writeFileSync(join(wt, "newfile.txt"), "hello world\n");

      sessionCommit("Add newfile", "commit-test");

      const updated = loadManifest("commit-test");
      assert.notEqual(updated.baseline, originalBaseline);
      assert.equal(updated.changesets.length, 1);
      assert.equal(updated.changesets[0].id, 1);
      assert.equal(updated.changesets[0].message, "Add newfile");
      assert.ok(updated.changesets[0].files.includes("newfile.txt"));
      assert.deepStrictEqual(updated.pending, []);
    });

    it("does nothing when there are no changes", () => {
      start("no-changes");
      // Capture console output
      const logs = captureConsole(() => {
        sessionCommit("Nothing here", "no-changes");
      });
      assert.ok(logs.some((l) => l.includes("Nothing to commit")));
    });

    it("records multiple changesets with incrementing IDs", () => {
      start("multi-commit");
      const m = loadManifest("multi-commit");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "file1.txt"), "first\n");
      sessionCommit("First commit", "multi-commit");

      writeFileSync(join(wt, "file2.txt"), "second\n");
      sessionCommit("Second commit", "multi-commit");

      const updated = loadManifest("multi-commit");
      assert.equal(updated.changesets.length, 2);
      assert.equal(updated.changesets[0].id, 1);
      assert.equal(updated.changesets[1].id, 2);
    });
  });

  describe("squash()", () => {
    it("collapses all changesets into one", () => {
      start("squash-test");
      const m = loadManifest("squash-test");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "a.txt"), "aaa\n");
      sessionCommit("Add a", "squash-test");

      writeFileSync(join(wt, "b.txt"), "bbb\n");
      sessionCommit("Add b", "squash-test");

      squash("Combined work", "squash-test");

      const updated = loadManifest("squash-test");
      assert.equal(updated.changesets.length, 1);
      assert.equal(updated.changesets[0].id, 1);
      assert.equal(updated.changesets[0].message, "Combined work");
      const files = updated.changesets[0].files.sort();
      assert.ok(files.includes("a.txt"));
      assert.ok(files.includes("b.txt"));
    });

    it("does nothing with zero changesets", () => {
      start("empty-squash");
      const logs = captureConsole(() => {
        squash("Nothing", "empty-squash");
      });
      assert.ok(logs.some((l) => l.includes("Nothing to squash")));
    });

    it("rejects squash with uncommitted changes", () => {
      start("dirty-squash");
      const m = loadManifest("dirty-squash");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "a.txt"), "aaa\n");
      sessionCommit("Add a", "dirty-squash");

      writeFileSync(join(wt, "dirty.txt"), "not committed\n");
      assert.throws(() => squash("Should fail", "dirty-squash"), /Uncommitted changes/);
    });
  });

  describe("undo()", () => {
    it("reverts the last commit and restores files to pending", () => {
      start("undo-test");
      const m = loadManifest("undo-test");
      const wt = getWorktreePath(m);
      const originalBaseline = m.baseline;

      writeFileSync(join(wt, "undoable.txt"), "will be undone\n");
      sessionCommit("Will undo this", "undo-test");

      undo("undo-test");

      const updated = loadManifest("undo-test");
      assert.equal(updated.baseline, originalBaseline);
      assert.equal(updated.changesets.length, 0);
      assert.ok(updated.pending.includes("undoable.txt"));

      // File should still exist in worktree (unstaged)
      assert.ok(existsSync(join(wt, "undoable.txt")));
    });

    it("does nothing with zero changesets", () => {
      start("nothing-undo");
      const logs = captureConsole(() => {
        undo("nothing-undo");
      });
      assert.ok(logs.some((l) => l.includes("Nothing to undo")));
    });

    it("can undo to intermediate changeset", () => {
      start("undo-mid");
      const m = loadManifest("undo-mid");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "first.txt"), "first\n");
      sessionCommit("First", "undo-mid");

      const afterFirst = loadManifest("undo-mid");
      const firstBaseline = afterFirst.baseline;

      writeFileSync(join(wt, "second.txt"), "second\n");
      sessionCommit("Second", "undo-mid");

      undo("undo-mid");

      const updated = loadManifest("undo-mid");
      assert.equal(updated.baseline, firstBaseline);
      assert.equal(updated.changesets.length, 1);
      assert.equal(updated.changesets[0].message, "First");
    });
  });

  describe("diff()", () => {
    it("shows unstaged changes", () => {
      start("diff-test");
      const m = loadManifest("diff-test");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "README.md"), "modified content\n");

      const logs = captureConsole(() => diff("diff-test"));
      assert.ok(logs.some((l) => l.includes("modified content") || l.includes("README.md")));
    });

    it("shows no changes when clean", () => {
      start("diff-clean");
      const logs = captureConsole(() => diff("diff-clean"));
      assert.ok(logs.some((l) => l.includes("No changes")));
    });
  });

  describe("merge()", () => {
    it("merges session branch into current branch", () => {
      start("merge-test");
      const m = loadManifest("merge-test");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "merged.txt"), "merge me\n");
      sessionCommit("Add merged file", "merge-test");

      // Merge should work — we're on main, session is on stint/merge-test
      merge("merge-test");

      // Session should be cleaned up
      assert.equal(loadManifest("merge-test"), null);

      // The file should now be in the main repo
      assert.ok(existsSync(join(repo.dir, "merged.txt")));
    });

    it("auto-commits pending changes before merging", () => {
      start("merge-auto");
      const m = loadManifest("merge-auto");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "uncommitted.txt"), "auto committed\n");

      // Merge should auto-commit the pending changes first
      merge("merge-auto");

      assert.equal(loadManifest("merge-auto"), null);
      assert.ok(existsSync(join(repo.dir, "uncommitted.txt")));
    });

    it("merges cleanly when session has no commits", () => {
      start("merge-noop");
      merge("merge-noop");
      assert.equal(loadManifest("merge-noop"), null);
      assert.ok(!git.branchExists("stint/merge-noop"));
    });
  });

  describe("end()", () => {
    it("cleans up worktree, branch, and manifest", () => {
      start("end-test");
      const m = loadManifest("end-test");
      const wt = getWorktreePath(m);

      end("end-test");

      assert.equal(loadManifest("end-test"), null);
      assert.ok(!existsSync(wt));
      assert.ok(!git.branchExists("stint/end-test"));
    });

    it("auto-commits pending changes before ending", () => {
      start("auto-commit-end");
      const m = loadManifest("auto-commit-end");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "uncommitted.txt"), "will be committed\n");

      // The end function should auto-commit before cleanup
      end("auto-commit-end");

      // Verify by checking that the branch had a commit (branch is deleted,
      // but we can check manifest was deleted — it ran without error)
      assert.equal(loadManifest("auto-commit-end"), null);
    });

    it("deletes remote branch when PR merged on remote (regular merge)", () => {
      // Set up a bare remote
      const remoteDir = mkdtempSync(join(tmpdir(), "git-stint-remote-"));
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "-u", "origin", "main"], { stdio: "pipe" });

      start("remote-merged");
      const m = loadManifest("remote-merged");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "feature.txt"), "new feature\n");
      sessionCommit("Add feature", "remote-merged");

      // Push session branch to remote
      git.push(m.branch);
      assert.ok(git.remoteBranchExists(m.branch));

      // Simulate PR merged on GitHub: merge locally and push main to remote
      execFileSync("git", ["-C", repo.dir, "merge", m.branch], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "origin", "main"], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "fetch", "origin"], { stdio: "pipe" });

      // Now end — remote main has the changes
      end("remote-merged");

      execFileSync("git", ["-C", repo.dir, "fetch", "--prune", "origin"], { stdio: "pipe" });
      assert.ok(!git.remoteBranchExists("stint/remote-merged"));

      rmSync(remoteDir, { recursive: true, force: true });
    });

    it("deletes remote branch when squash-merged on remote", () => {
      // Set up a bare remote
      const remoteDir = mkdtempSync(join(tmpdir(), "git-stint-remote-"));
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "-u", "origin", "main"], { stdio: "pipe" });

      start("squash-merged");
      const m = loadManifest("squash-merged");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "feature.txt"), "squashed feature\n");
      sessionCommit("Add squashed feature", "squash-merged");

      // Push session branch to remote
      git.push(m.branch);
      assert.ok(git.remoteBranchExists(m.branch));

      // Simulate GitHub "Squash and merge": squash commit on main, pushed to remote
      writeFileSync(join(repo.dir, "feature.txt"), "squashed feature\n");
      execFileSync("git", ["-C", repo.dir, "add", "-A"], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "commit", "-m", "Squash: Add squashed feature"], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "origin", "main"], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "fetch", "origin"], { stdio: "pipe" });

      // Now end — remote main has the squashed changes
      end("squash-merged");

      execFileSync("git", ["-C", repo.dir, "fetch", "--prune", "origin"], { stdio: "pipe" });
      assert.ok(!git.remoteBranchExists("stint/squash-merged"));

      rmSync(remoteDir, { recursive: true, force: true });
    });

    it("does NOT delete remote after local-only merge (not pushed)", () => {
      // Set up a bare remote
      const remoteDir = mkdtempSync(join(tmpdir(), "git-stint-remote-"));
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "-u", "origin", "main"], { stdio: "pipe" });

      start("local-merge");
      const m = loadManifest("local-merge");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "feature.txt"), "local feature\n");
      sessionCommit("Add feature", "local-merge");

      git.push(m.branch);
      assert.ok(git.remoteBranchExists(m.branch));

      // Merge locally — does NOT push main to remote
      merge("local-merge");

      // Remote branch should be preserved — origin/main doesn't have the merge
      assert.ok(git.remoteBranchExists("stint/local-merge"));

      rmSync(remoteDir, { recursive: true, force: true });
    });

    it("does NOT delete remote branch when changes are unmerged", () => {
      // Set up a bare remote
      const remoteDir = mkdtempSync(join(tmpdir(), "git-stint-remote-"));
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "-u", "origin", "main"], { stdio: "pipe" });

      start("unmerged");
      const m = loadManifest("unmerged");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "feature.txt"), "unmerged work\n");
      sessionCommit("Add unmerged work", "unmerged");

      // Push branch to remote
      git.push(m.branch);
      assert.ok(git.remoteBranchExists(m.branch));

      // End WITHOUT merging — remote branch should be preserved
      end("unmerged");

      // Remote branch should still exist
      assert.ok(git.remoteBranchExists("stint/unmerged"));

      rmSync(remoteDir, { recursive: true, force: true });
    });

    it("does NOT delete remote branch when only partially squash-merged", () => {
      // Set up a bare remote
      const remoteDir = mkdtempSync(join(tmpdir(), "git-stint-remote-"));
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "-u", "origin", "main"], { stdio: "pipe" });

      start("partial-squash");
      const m = loadManifest("partial-squash");
      const wt = getWorktreePath(m);

      // Branch changes two files
      writeFileSync(join(wt, "file-a.txt"), "content a\n");
      writeFileSync(join(wt, "file-b.txt"), "content b\n");
      sessionCommit("Add two files", "partial-squash");

      git.push(m.branch);

      // Simulate squash-merge that only includes file-a, pushed to remote
      writeFileSync(join(repo.dir, "file-a.txt"), "content a\n");
      execFileSync("git", ["-C", repo.dir, "add", "-A"], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "commit", "-m", "Partial squash"], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "origin", "main"], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "fetch", "origin"], { stdio: "pipe" });

      end("partial-squash");

      // Remote branch should be preserved — file-b is not in origin/main
      assert.ok(git.remoteBranchExists("stint/partial-squash"));

      rmSync(remoteDir, { recursive: true, force: true });
    });

    it("deletes remote branch when merged into non-default branch on remote", () => {
      // Set up a bare remote
      const remoteDir = mkdtempSync(join(tmpdir(), "git-stint-remote-"));
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "-u", "origin", "main"], { stdio: "pipe" });

      // Create and push a 'develop' branch
      execFileSync("git", ["-C", repo.dir, "checkout", "-b", "develop"], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "-u", "origin", "develop"], { stdio: "pipe" });

      start("develop-merge");
      const m = loadManifest("develop-merge");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "feature.txt"), "develop feature\n");
      sessionCommit("Add develop feature", "develop-merge");

      git.push(m.branch);
      assert.ok(git.remoteBranchExists(m.branch));

      // Simulate PR merged into develop on remote
      execFileSync("git", ["-C", repo.dir, "merge", m.branch], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "origin", "develop"], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "fetch", "origin"], { stdio: "pipe" });

      // End — origin/develop has the changes
      end("develop-merge");

      execFileSync("git", ["-C", repo.dir, "fetch", "--prune", "origin"], { stdio: "pipe" });
      assert.ok(!git.remoteBranchExists("stint/develop-merge"));

      // Switch back to main for afterEach cleanup
      execFileSync("git", ["-C", repo.dir, "checkout", "main"], { stdio: "pipe" });
      rmSync(remoteDir, { recursive: true, force: true });
    });

    it("does NOT delete remote when main repo is on the session branch", () => {
      // Set up a bare remote
      const remoteDir = mkdtempSync(join(tmpdir(), "git-stint-remote-"));
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "remote", "add", "origin", remoteDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repo.dir, "push", "-u", "origin", "main"], { stdio: "pipe" });

      start("self-checkout");
      const m = loadManifest("self-checkout");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "feature.txt"), "important work\n");
      sessionCommit("Add important work", "self-checkout");

      git.push(m.branch);

      // Detach worktree so we can checkout the session branch in the main repo.
      // Worktrees lock the branch, so detach via plumbing.
      execFileSync("git", ["-C", wt, "checkout", "--detach"], { stdio: "pipe" });

      // Checkout the session branch in the main repo (unusual but possible)
      execFileSync("git", ["-C", repo.dir, "checkout", m.branch], { stdio: "pipe" });

      // End the session — should NOT delete remote because the "merge" is just
      // the main repo being on the session branch, not a real merge into main
      end("self-checkout");

      // Remote branch should be preserved — changes are NOT in origin/main
      assert.ok(git.remoteBranchExists("stint/self-checkout"));

      // Cleanup
      execFileSync("git", ["-C", repo.dir, "checkout", "main"], { stdio: "pipe" });
      rmSync(remoteDir, { recursive: true, force: true });
    });

    it("handles no remote gracefully", () => {
      // No remote configured — end should work fine without touching remotes
      start("no-remote");
      const m = loadManifest("no-remote");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "local.txt"), "local only\n");
      sessionCommit("Local work", "no-remote");

      end("no-remote");

      assert.equal(loadManifest("no-remote"), null);
      assert.ok(!git.branchExists("stint/no-remote"));
    });
  });

  describe("abort()", () => {
    it("discards session without committing", () => {
      start("abort-test");
      const m = loadManifest("abort-test");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "discard.txt"), "thrown away\n");

      abort("abort-test");

      assert.equal(loadManifest("abort-test"), null);
      assert.ok(!existsSync(wt));
      assert.ok(!git.branchExists("stint/abort-test"));
    });
  });

  describe("list()", () => {
    it("shows no sessions message when empty", () => {
      const logs = captureConsole(() => list());
      assert.ok(logs.some((l) => l.includes("No active sessions")));
    });

    it("shows sessions in table format", () => {
      start("alpha");
      start("beta");
      const logs = captureConsole(() => list());
      assert.ok(logs.some((l) => l.includes("alpha")));
      assert.ok(logs.some((l) => l.includes("beta")));
      assert.ok(logs.some((l) => l.includes("NAME")));
    });
  });

  describe("listJson()", () => {
    it("outputs valid JSON array", () => {
      start("json-test");
      const logs = captureConsole(() => listJson());
      assert.equal(logs.length, 1);
      const parsed = JSON.parse(logs[0]);
      assert.ok(Array.isArray(parsed));
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].name, "json-test");
      assert.equal(parsed[0].branch, "stint/json-test");
      assert.equal(parsed[0].worktree, ".stint/json-test");
      assert.equal(parsed[0].commits, 0);
      assert.equal(parsed[0].pending, 0);
    });

    it("outputs empty array when no sessions", () => {
      const logs = captureConsole(() => listJson());
      const parsed = JSON.parse(logs[0]);
      assert.deepStrictEqual(parsed, []);
    });
  });

  describe("status()", () => {
    it("shows session information", () => {
      start("status-test");
      const logs = captureConsole(() => status("status-test"));
      assert.ok(logs.some((l) => l.includes("status-test")));
      assert.ok(logs.some((l) => l.includes("stint/status-test")));
    });
  });

  describe("log()", () => {
    it("shows commit history", () => {
      start("log-test");
      const m = loadManifest("log-test");
      const wt = getWorktreePath(m);

      writeFileSync(join(wt, "logged.txt"), "logged\n");
      sessionCommit("Logged commit", "log-test");

      const logs = captureConsole(() => log("log-test"));
      assert.ok(logs.some((l) => l.includes("Logged commit")));
    });

    it("shows no commits message when empty", () => {
      start("empty-log");
      const logs = captureConsole(() => log("empty-log"));
      assert.ok(logs.some((l) => l.includes("No commits")));
    });
  });

  describe("prune()", () => {
    it("cleans up orphaned branches", () => {
      // Create a stint branch without a manifest
      git.createBranch("stint/orphan", "HEAD");
      assert.ok(git.branchExists("stint/orphan"));

      prune();
      assert.ok(!git.branchExists("stint/orphan"));
    });

    it("reports nothing when clean", () => {
      const logs = captureConsole(() => prune());
      assert.ok(logs.some((l) => l.includes("Nothing to clean")));
    });

    it("handles non-directory entries in .stint/", () => {
      // Create a file inside .stint/ — prune should not crash
      const stintDir = join(repo.dir, ".stint");
      execFileSync("mkdir", ["-p", stintDir]);
      writeFileSync(join(stintDir, "stray-file.txt"), "not a worktree");

      // prune should succeed without error
      const logs = captureConsole(() => prune());
      // The stray file should not cause a crash
      assert.ok(!logs.some((l) => l.includes("stray-file.txt")));
    });

    it("cleans up leftover stint-combine worktrees", () => {
      // Simulate a crashed testCombine by creating a combine worktree + branch
      const combineName = "stint-combine-1234567890";
      git.createBranch(combineName, "HEAD");
      const combineDir = join(repo.dir, ".stint", combineName);
      git.addWorktree(combineDir, combineName);
      assert.ok(existsSync(combineDir));

      const logs = captureConsole(() => prune());
      assert.ok(logs.some((l) => l.includes("leftover combine worktree")));
      assert.ok(!git.branchExists(combineName));
    });
  });
});

describe("shared dirs", () => {
  let repo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("symlinks shared_dirs from config into worktree", () => {
    // Create shared dirs in main repo (gitignored, as in real usage)
    mkdirSync(join(repo.dir, "backend", "data"), { recursive: true });
    writeFileSync(join(repo.dir, "backend", "data", "cache.parquet"), "data");
    writeFileSync(join(repo.dir, ".gitignore"), "backend/data/\n.stint.json\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo.dir, "commit", "-m", "gitignore"], { stdio: "pipe" });

    // Write config
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_dirs: ["backend/data"],
    }));

    start("shared-test");
    const m = loadManifest("shared-test");
    const wt = getWorktreePath(m);

    // Symlink should exist and be a symlink
    const target = join(wt, "backend", "data");
    assert.ok(existsSync(target), "symlink target should exist");
    assert.ok(lstatSync(target).isSymbolicLink(), "should be a symlink");

    // Data should be accessible through symlink
    assert.equal(readFileSync(join(target, "cache.parquet"), "utf-8"), "data");

    end("shared-test");
  });

  it("preserves shared dir data after cleanup", () => {
    mkdirSync(join(repo.dir, "backend", "data"), { recursive: true });
    writeFileSync(join(repo.dir, "backend", "data", "important.dat"), "keep me");
    writeFileSync(join(repo.dir, ".gitignore"), "backend/data/\n.stint.json\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo.dir, "commit", "-m", "gitignore"], { stdio: "pipe" });

    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_dirs: ["backend/data"],
    }));

    start("preserve-test");
    const m = loadManifest("preserve-test");
    const wt = getWorktreePath(m);

    // Write data through symlink
    writeFileSync(join(wt, "backend", "data", "new.dat"), "new data");

    end("preserve-test");

    // Original data should still be intact
    assert.equal(readFileSync(join(repo.dir, "backend", "data", "important.dat"), "utf-8"), "keep me");
    assert.equal(readFileSync(join(repo.dir, "backend", "data", "new.dat"), "utf-8"), "new data");
  });

  it("warns when shared_dirs entry does not exist", () => {
    writeFileSync(join(repo.dir, ".gitignore"), ".stint.json\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo.dir, "commit", "-m", "gitignore"], { stdio: "pipe" });

    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_dirs: ["nonexistent/dir"],
    }));

    const logs = captureConsole(() => start("warn-test"));
    assert.ok(logs.some((l) => l.includes("not found in repo")));

    end("warn-test");
  });

  it("prints shared dir summary on start", () => {
    mkdirSync(join(repo.dir, "data"), { recursive: true });
    writeFileSync(join(repo.dir, ".gitignore"), "data/\n.stint.json\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo.dir, "commit", "-m", "gitignore"], { stdio: "pipe" });

    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_dirs: ["data"],
    }));

    const logs = captureConsole(() => start("summary-test"));
    assert.ok(logs.some((l) => l.includes("Shared directories")));
    assert.ok(logs.some((l) => l.includes("data")));

    end("summary-test");
  });
});

describe("adopt uncommitted changes", () => {
  let repo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("carries uncommitted changes into new session", () => {
    // Make uncommitted changes on main
    writeFileSync(join(repo.dir, "wip.txt"), "work in progress\n");

    const logs = captureConsole(() => start("adopt-test"));
    assert.ok(logs.some((l) => l.includes("Carried over")));

    const m = loadManifest("adopt-test");
    const wt = getWorktreePath(m);

    // Changes should be in worktree
    assert.ok(existsSync(join(wt, "wip.txt")));
    assert.equal(readFileSync(join(wt, "wip.txt"), "utf-8"), "work in progress\n");

    // Main repo should be clean
    assert.ok(!git.hasUncommittedChanges(repo.dir));

    end("adopt-test");
  });

  it("handles modified tracked files", () => {
    // Modify existing tracked file
    writeFileSync(join(repo.dir, "README.md"), "modified content\n");

    const logs = captureConsole(() => start("adopt-modified"));
    assert.ok(logs.some((l) => l.includes("Carried over")));

    const m = loadManifest("adopt-modified");
    const wt = getWorktreePath(m);
    assert.equal(readFileSync(join(wt, "README.md"), "utf-8"), "modified content\n");

    end("adopt-modified");
  });

  it("--no-adopt leaves changes on main", () => {
    writeFileSync(join(repo.dir, "wip.txt"), "stay here\n");

    start("no-adopt-test", undefined, false);

    // Changes should still be on main
    assert.ok(existsSync(join(repo.dir, "wip.txt")));
    assert.equal(readFileSync(join(repo.dir, "wip.txt"), "utf-8"), "stay here\n");

    const m = loadManifest("no-adopt-test");
    const wt = getWorktreePath(m);
    // File should NOT be in worktree (it's untracked and wasn't adopted)
    assert.ok(!existsSync(join(wt, "wip.txt")));

    end("no-adopt-test");
  });

  it("adopt_changes: never skips adoption", () => {
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({ adopt_changes: "never" }));
    writeFileSync(join(repo.dir, "wip.txt"), "stay here\n");

    start("never-adopt-test");

    // Changes should still be on main
    assert.ok(existsSync(join(repo.dir, "wip.txt")));

    end("never-adopt-test");
  });

  it("adopt_changes: prompt warns without adopting", () => {
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({ adopt_changes: "prompt" }));
    writeFileSync(join(repo.dir, "wip.txt"), "stay here\n");

    const logs = captureConsole(() => start("prompt-adopt-test"));
    assert.ok(logs.some((l) => l.includes("uncommitted file(s)")));
    assert.ok(logs.some((l) => l.includes("--adopt")));

    // Changes should still be on main (not adopted)
    assert.ok(existsSync(join(repo.dir, "wip.txt")));

    end("prompt-adopt-test");
  });

  it("--adopt overrides adopt_changes: never", () => {
    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({ adopt_changes: "never" }));
    writeFileSync(join(repo.dir, "wip.txt"), "override\n");

    const logs = captureConsole(() => start("override-adopt-test", undefined, true));
    assert.ok(logs.some((l) => l.includes("Carried over")));

    const m = loadManifest("override-adopt-test");
    const wt = getWorktreePath(m);
    assert.ok(existsSync(join(wt, "wip.txt")));

    end("override-adopt-test");
  });
});

describe("allowMain()", () => {
  let repo;

  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("creates flag file in .git", () => {
    allowMain();
    const commonDir = git.getGitCommonDir();
    const flagPath = join(commonDir, `stint-main-allowed-${process.ppid}`);
    assert.ok(existsSync(flagPath));
  });

  it("flag is removed when starting a session", () => {
    allowMain();
    const commonDir = git.getGitCommonDir();
    const flagPath = join(commonDir, `stint-main-allowed-${process.ppid}`);
    assert.ok(existsSync(flagPath));

    start("revoke-test");
    assert.ok(!existsSync(flagPath), "flag should be removed on start");

    end("revoke-test");
  });
});

// --- Helpers ---

function captureConsole(fn) {
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return logs;
}

function createTempNonGitDir() {
  const dir = mkdtempSync(join(tmpdir(), "git-stint-no-git-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  return {
    dir,
    cleanup() {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
