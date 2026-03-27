/**
 * Integration tests: full session lifecycle.
 *
 * These tests exercise the complete flow from start to end,
 * including multi-session scenarios and conflict detection.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTempRepo } from "../helpers/temp-repo.js";
import {
  start,
  track,
  sessionCommit,
  squash,
  merge,
  undo,
  end,
  abort,
  prune,
  resume,
} from "../../dist/session.js";
import {
  loadManifest,
  listManifests,
  getWorktreePath,
} from "../../dist/manifest.js";
import { checkConflicts } from "../../dist/conflicts.js";
import * as git from "../../dist/git.js";

let repo;

describe("integration: resume session after client change", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("start -> commit -> resume with new client -> commit -> end", () => {
    start("resume-lifecycle", "client-1");
    const m1 = loadManifest("resume-lifecycle");
    const wt = getWorktreePath(m1);

    writeFileSync(join(wt, "part1.ts"), "export const step1 = true;\n");
    sessionCommit("Part 1", "resume-lifecycle");
    assert.equal(loadManifest("resume-lifecycle").changesets.length, 1);

    resume("resume-lifecycle", "client-2");
    const m2 = loadManifest("resume-lifecycle");
    assert.equal(m2.clientId, "client-2");
    assert.equal(m2.changesets.length, 1);

    writeFileSync(join(wt, "part2.ts"), "export const step2 = true;\n");
    sessionCommit("Part 2", "resume-lifecycle");
    assert.equal(loadManifest("resume-lifecycle").changesets.length, 2);

    end("resume-lifecycle");
    assert.equal(loadManifest("resume-lifecycle"), null);
    assert.ok(!existsSync(wt));
  });
});

describe("integration: full session lifecycle", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("start → edit → commit → commit → squash → end", () => {
    // 1. Start a session
    start("feature-x");
    const m1 = loadManifest("feature-x");
    assert.ok(m1);
    const wt = getWorktreePath(m1);
    assert.ok(existsSync(wt));

    // 2. Edit and commit first batch
    writeFileSync(join(wt, "config.ts"), "export const PORT = 3000;\n");
    writeFileSync(join(wt, "server.ts"), "import { PORT } from './config';\n");
    sessionCommit("Add server config", "feature-x");

    const m2 = loadManifest("feature-x");
    assert.equal(m2.changesets.length, 1);
    assert.notEqual(m2.baseline, m2.startedAt);

    // 3. Edit and commit second batch
    writeFileSync(join(wt, "server.ts"), "import { PORT } from './config';\nconsole.log(PORT);\n");
    writeFileSync(join(wt, "test.ts"), "assert(true);\n");
    sessionCommit("Wire config and add test", "feature-x");

    const m3 = loadManifest("feature-x");
    assert.equal(m3.changesets.length, 2);

    // 4. Squash into single commit
    squash("Feature X: server with config", "feature-x");

    const m4 = loadManifest("feature-x");
    assert.equal(m4.changesets.length, 1);
    assert.equal(m4.changesets[0].message, "Feature X: server with config");
    // All files should be in the squashed changeset
    const files = m4.changesets[0].files.sort();
    assert.ok(files.includes("config.ts"));
    assert.ok(files.includes("server.ts"));
    assert.ok(files.includes("test.ts"));

    // 5. End session — should clean everything up
    end("feature-x");
    assert.equal(loadManifest("feature-x"), null);
    assert.ok(!existsSync(wt));
    assert.ok(!git.branchExists("stint/feature-x"));
  });

  it("start → commit → undo → recommit → end", () => {
    start("undo-flow");
    const m = loadManifest("undo-flow");
    const wt = getWorktreePath(m);

    // Commit something
    writeFileSync(join(wt, "mistake.txt"), "oops\n");
    sessionCommit("Wrong approach", "undo-flow");
    assert.equal(loadManifest("undo-flow").changesets.length, 1);

    // Undo it
    undo("undo-flow");
    const afterUndo = loadManifest("undo-flow");
    assert.equal(afterUndo.changesets.length, 0);
    assert.ok(afterUndo.pending.includes("mistake.txt"));

    // Fix and recommit
    writeFileSync(join(wt, "mistake.txt"), "fixed\n");
    sessionCommit("Better approach", "undo-flow");
    assert.equal(loadManifest("undo-flow").changesets.length, 1);
    assert.equal(loadManifest("undo-flow").changesets[0].message, "Better approach");

    end("undo-flow");
  });

  it("abort discards everything including uncommitted changes", () => {
    start("to-discard");
    const m = loadManifest("to-discard");
    const wt = getWorktreePath(m);

    writeFileSync(join(wt, "committed.txt"), "committed\n");
    sessionCommit("A commit", "to-discard");

    writeFileSync(join(wt, "uncommitted.txt"), "not committed\n");

    abort("to-discard");

    assert.equal(loadManifest("to-discard"), null);
    assert.ok(!existsSync(wt));
    assert.ok(!git.branchExists("stint/to-discard"));
  });
});

describe("integration: parallel sessions", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("supports multiple concurrent sessions", () => {
    start("session-a");
    start("session-b");

    const manifests = listManifests();
    assert.equal(manifests.length, 2);

    const a = loadManifest("session-a");
    const b = loadManifest("session-b");

    // Both should have their own worktrees
    const wtA = getWorktreePath(a);
    const wtB = getWorktreePath(b);
    assert.ok(existsSync(wtA));
    assert.ok(existsSync(wtB));
    assert.notEqual(wtA, wtB);

    // Edit different files in each
    writeFileSync(join(wtA, "feature-a.txt"), "session A work\n");
    sessionCommit("Session A work", "session-a");

    writeFileSync(join(wtB, "feature-b.txt"), "session B work\n");
    sessionCommit("Session B work", "session-b");

    // Both should have their commits
    assert.equal(loadManifest("session-a").changesets.length, 1);
    assert.equal(loadManifest("session-b").changesets.length, 1);

    // Clean up
    end("session-a");
    end("session-b");
    assert.equal(listManifests().length, 0);
  });

  it("detects file conflicts between sessions", () => {
    start("conflict-a");
    start("conflict-b");

    const a = loadManifest("conflict-a");
    const b = loadManifest("conflict-b");
    const wtA = getWorktreePath(a);
    const wtB = getWorktreePath(b);

    // Both edit the same file
    writeFileSync(join(wtA, "shared.txt"), "version A\n");
    sessionCommit("Edit shared from A", "conflict-a");

    writeFileSync(join(wtB, "shared.txt"), "version B\n");
    sessionCommit("Edit shared from B", "conflict-b");

    // Check conflicts from A's perspective
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      checkConflicts("conflict-a");
    } finally {
      console.log = origLog;
    }

    assert.ok(logs.some((l) => l.includes("shared.txt")));
    assert.ok(logs.some((l) => l.includes("conflict-b")));

    end("conflict-a");
    end("conflict-b");
  });
});

describe("integration: prune handles orphans", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("cleans up branches without manifests", () => {
    // Create orphaned branch
    git.createBranch("stint/orphan-branch", "HEAD");
    assert.ok(git.branchExists("stint/orphan-branch"));

    prune();
    assert.ok(!git.branchExists("stint/orphan-branch"));
  });

  it("cleans up manifests without worktrees", () => {
    start("ghost-session");
    const m = loadManifest("ghost-session");
    const wt = getWorktreePath(m);

    // Forcibly remove worktree without going through end()
    git.removeWorktree(wt, true);
    assert.ok(!existsSync(wt));

    // Manifest still exists
    assert.ok(loadManifest("ghost-session"));

    // Prune should clean it up
    prune();
    assert.equal(loadManifest("ghost-session"), null);
  });
});

describe("integration: shared dirs lifecycle", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("start → write through symlink → end → data persists in main repo", () => {
    // Set up shared dirs (gitignored, as in real usage — cached data)
    mkdirSync(join(repo.dir, "data", "cache"), { recursive: true });
    mkdirSync(join(repo.dir, "results"), { recursive: true });
    writeFileSync(join(repo.dir, "data", "cache", "existing.parquet"), "existing data");

    // Gitignore shared dirs so stash doesn't capture them
    writeFileSync(join(repo.dir, ".gitignore"), "data/\nresults/\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo.dir, "commit", "-m", "Add gitignore"], { stdio: "pipe" });

    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_dirs: ["data", "results"],
    }));

    // Start session
    start("shared-lifecycle");
    const m = loadManifest("shared-lifecycle");
    const wt = getWorktreePath(m);

    // Verify symlinks exist
    assert.ok(lstatSync(join(wt, "data")).isSymbolicLink());
    assert.ok(lstatSync(join(wt, "results")).isSymbolicLink());

    // Write data through symlinks
    writeFileSync(join(wt, "data", "cache", "new.parquet"), "new cached data");
    writeFileSync(join(wt, "results", "output.json"), '{"result": true}');

    // Also make a regular code change and commit
    writeFileSync(join(wt, "src.ts"), "export const x = 1;\n");
    sessionCommit("Add src", "shared-lifecycle");

    // End session
    end("shared-lifecycle");

    // Shared data should persist in main repo
    assert.equal(
      readFileSync(join(repo.dir, "data", "cache", "existing.parquet"), "utf-8"),
      "existing data",
    );
    assert.equal(
      readFileSync(join(repo.dir, "data", "cache", "new.parquet"), "utf-8"),
      "new cached data",
    );
    assert.equal(
      readFileSync(join(repo.dir, "results", "output.json"), "utf-8"),
      '{"result": true}',
    );

    // Worktree should be gone
    assert.ok(!existsSync(wt));
  });

  it("abort also preserves shared dir data", () => {
    mkdirSync(join(repo.dir, "data"), { recursive: true });
    writeFileSync(join(repo.dir, "data", "precious.dat"), "precious");

    // Gitignore data dir
    writeFileSync(join(repo.dir, ".gitignore"), "data/\n");
    execFileSync("git", ["-C", repo.dir, "add", ".gitignore"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo.dir, "commit", "-m", "Add gitignore"], { stdio: "pipe" });

    writeFileSync(join(repo.dir, ".stint.json"), JSON.stringify({
      shared_dirs: ["data"],
    }));

    start("shared-abort");
    const m = loadManifest("shared-abort");
    const wt = getWorktreePath(m);

    // Write through symlink
    writeFileSync(join(wt, "data", "added.dat"), "added");

    abort("shared-abort");

    // Data should survive abort
    assert.equal(readFileSync(join(repo.dir, "data", "precious.dat"), "utf-8"), "precious");
    assert.equal(readFileSync(join(repo.dir, "data", "added.dat"), "utf-8"), "added");
  });
});

describe("integration: adopt uncommitted changes", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("uncommitted changes move from main to worktree and back on merge", () => {
    // Create uncommitted work on main
    writeFileSync(join(repo.dir, "wip.ts"), "const draft = true;\n");
    writeFileSync(join(repo.dir, "README.md"), "updated readme\n");

    // Start session — should adopt changes
    start("adopt-merge");
    const m = loadManifest("adopt-merge");
    const wt = getWorktreePath(m);

    // Main should be clean
    assert.ok(!git.hasUncommittedChanges(repo.dir));

    // Worktree should have the changes
    assert.ok(existsSync(join(wt, "wip.ts")));

    // Commit in worktree
    sessionCommit("Adopt and commit", "adopt-merge");

    // Merge back to main
    merge("adopt-merge");

    // Main should now have the file (committed)
    assert.ok(existsSync(join(repo.dir, "wip.ts")));
    assert.equal(readFileSync(join(repo.dir, "wip.ts"), "utf-8"), "const draft = true;\n");
  });
});

describe("integration: session resolution from worktree CWD", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it("auto-resolves session when CWD is inside its worktree", () => {
    start("auto-resolve");
    const m = loadManifest("auto-resolve");
    const wt = getWorktreePath(m);

    // cd into the worktree
    process.chdir(wt);

    // Track should auto-resolve the session
    track(["some-file.ts"]);
    const updated = loadManifest("auto-resolve");
    assert.ok(updated.pending.includes("some-file.ts"));

    // Go back to repo root to clean up
    process.chdir(repo.dir);
    end("auto-resolve");
  });
});
