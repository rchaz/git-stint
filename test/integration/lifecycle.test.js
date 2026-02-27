/**
 * Integration tests: full session lifecycle.
 *
 * These tests exercise the complete flow from start to end,
 * including multi-session scenarios and conflict detection.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempRepo } from "../helpers/temp-repo.js";
import {
  start,
  track,
  sessionCommit,
  squash,
  undo,
  end,
  abort,
  prune,
} from "../../dist/session.js";
import {
  loadManifest,
  listManifests,
  getWorktreePath,
} from "../../dist/manifest.js";
import { checkConflicts } from "../../dist/conflicts.js";
import * as git from "../../dist/git.js";

let repo;

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
