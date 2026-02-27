import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempRepo } from "../helpers/temp-repo.js";
import {
  loadManifest,
  saveManifest,
  listManifests,
  deleteManifest,
  resolveSession,
  getSessionsDir,
  getRepoRoot,
  getWorktreePath,
  hasAnySessions,
} from "../../dist/manifest.js";

let repo;

describe("manifest", () => {
  beforeEach(() => {
    repo = createTempRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  describe("getSessionsDir()", () => {
    it("creates .git/sessions/ if it does not exist", () => {
      const dir = getSessionsDir();
      assert.ok(existsSync(dir));
      assert.ok(dir.endsWith("/sessions"));
    });

    it("returns same path on repeated calls", () => {
      const a = getSessionsDir();
      const b = getSessionsDir();
      assert.equal(a, b);
    });
  });

  describe("saveManifest() / loadManifest()", () => {
    it("round-trips a manifest correctly", () => {
      const manifest = makeManifest("test-session");
      saveManifest(manifest);
      const loaded = loadManifest("test-session");
      assert.deepStrictEqual(loaded, manifest);
    });

    it("preserves all fields including changesets", () => {
      const manifest = makeManifest("with-changesets");
      manifest.changesets = [
        {
          id: 1,
          sha: "abc123def456",
          message: "First commit",
          files: ["src/foo.ts", "src/bar.ts"],
          timestamp: "2026-02-25T14:00:00.000Z",
        },
      ];
      manifest.pending = ["src/baz.ts"];
      saveManifest(manifest);
      const loaded = loadManifest("with-changesets");
      assert.equal(loaded.changesets.length, 1);
      assert.deepStrictEqual(loaded.changesets[0].files, ["src/foo.ts", "src/bar.ts"]);
      assert.deepStrictEqual(loaded.pending, ["src/baz.ts"]);
    });

    it("writes atomically via temp file", () => {
      const manifest = makeManifest("atomic-test");
      saveManifest(manifest);
      const dir = getSessionsDir();
      // tmp file should be cleaned up after rename
      assert.ok(!existsSync(join(dir, "atomic-test.json.tmp")));
      assert.ok(existsSync(join(dir, "atomic-test.json")));
    });
  });

  describe("loadManifest()", () => {
    it("returns null for non-existent manifest", () => {
      assert.equal(loadManifest("nonexistent"), null);
    });

    it("returns null for corrupted JSON", () => {
      const dir = getSessionsDir();
      writeFileSync(join(dir, "corrupt.json"), "{invalid json!!!");
      assert.equal(loadManifest("corrupt"), null);
    });

    it("defaults version to 1 for old manifests without version field", () => {
      const dir = getSessionsDir();
      const old = {
        name: "old-style",
        startedAt: "abc123",
        baseline: "abc123",
        branch: "stint/old-style",
        worktree: ".stint/old-style",
        changesets: [],
        pending: [],
      };
      writeFileSync(join(dir, "old-style.json"), JSON.stringify(old));
      const loaded = loadManifest("old-style");
      assert.equal(loaded.version, 1);
    });

    it("returns null for manifest missing required fields", () => {
      const dir = getSessionsDir();
      // Missing 'branch', 'worktree', 'changesets', 'pending'
      writeFileSync(join(dir, "incomplete.json"), JSON.stringify({
        name: "incomplete",
        startedAt: "abc123",
        baseline: "abc123",
      }));
      assert.equal(loadManifest("incomplete"), null);
    });

    it("returns null for manifest with empty name", () => {
      const dir = getSessionsDir();
      writeFileSync(join(dir, "empty-name.json"), JSON.stringify({
        name: "",
        startedAt: "abc123",
        baseline: "abc123",
        branch: "stint/x",
        worktree: ".stint/x",
        changesets: [],
        pending: [],
      }));
      assert.equal(loadManifest("empty-name"), null);
    });
  });

  describe("listManifests()", () => {
    it("returns empty array when no manifests exist", () => {
      const manifests = listManifests();
      assert.equal(manifests.length, 0);
    });

    it("returns all saved manifests", () => {
      saveManifest(makeManifest("alpha"));
      saveManifest(makeManifest("beta"));
      saveManifest(makeManifest("gamma"));
      const manifests = listManifests();
      assert.equal(manifests.length, 3);
      const names = manifests.map((m) => m.name).sort();
      assert.deepStrictEqual(names, ["alpha", "beta", "gamma"]);
    });

    it("skips .tmp files", () => {
      saveManifest(makeManifest("real"));
      const dir = getSessionsDir();
      writeFileSync(join(dir, "leftover.json.tmp"), "{}");
      const manifests = listManifests();
      assert.equal(manifests.length, 1);
      assert.equal(manifests[0].name, "real");
    });

    it("skips corrupted manifests", () => {
      saveManifest(makeManifest("good"));
      const dir = getSessionsDir();
      writeFileSync(join(dir, "bad.json"), "not json");
      const manifests = listManifests();
      assert.equal(manifests.length, 1);
    });
  });

  describe("deleteManifest()", () => {
    it("removes the manifest file", () => {
      saveManifest(makeManifest("to-delete"));
      deleteManifest("to-delete");
      assert.equal(loadManifest("to-delete"), null);
    });

    it("also cleans up .tmp file if present", () => {
      saveManifest(makeManifest("with-tmp"));
      const dir = getSessionsDir();
      writeFileSync(join(dir, "with-tmp.json.tmp"), "{}");
      deleteManifest("with-tmp");
      assert.ok(!existsSync(join(dir, "with-tmp.json.tmp")));
    });

    it("does not throw for non-existent manifest", () => {
      assert.doesNotThrow(() => deleteManifest("ghost"));
    });
  });

  describe("hasAnySessions()", () => {
    it("returns false when no sessions exist", () => {
      assert.equal(hasAnySessions(), false);
    });

    it("returns true when sessions exist", () => {
      saveManifest(makeManifest("exists"));
      assert.equal(hasAnySessions(), true);
    });
  });

  describe("resolveSession()", () => {
    it("resolves by explicit name", () => {
      saveManifest(makeManifest("explicit"));
      const m = resolveSession("explicit");
      assert.equal(m.name, "explicit");
    });

    it("throws for missing explicit name", () => {
      assert.throws(() => resolveSession("ghost"), /not found/);
    });

    it("auto-resolves when only one session exists", () => {
      saveManifest(makeManifest("only-one"));
      const m = resolveSession();
      assert.equal(m.name, "only-one");
    });

    it("throws when no sessions exist and no name given", () => {
      assert.throws(() => resolveSession(), /No active sessions/);
    });

    it("throws when multiple sessions exist and no name given", () => {
      saveManifest(makeManifest("alpha"));
      saveManifest(makeManifest("beta"));
      assert.throws(() => resolveSession(), /Multiple active sessions/);
    });

    it("error message mentions git stint list for multiple sessions", () => {
      saveManifest(makeManifest("alpha"));
      saveManifest(makeManifest("beta"));
      assert.throws(() => resolveSession(), /git stint list/);
    });
  });

  describe("getRepoRoot()", () => {
    it("returns the repo root directory", () => {
      const root = getRepoRoot();
      // Normalize both paths — macOS has /var → /private/var symlink
      assert.equal(realpathSync(root), realpathSync(repo.dir));
    });
  });

  describe("getWorktreePath()", () => {
    it("returns absolute path from manifest worktree field", () => {
      const manifest = makeManifest("wt-test");
      const path = getWorktreePath(manifest);
      assert.ok(path.startsWith("/"));
      assert.ok(path.endsWith(".stint/wt-test"));
    });
  });
});

function makeManifest(name) {
  return {
    version: 1,
    name,
    startedAt: "abc123def456789",
    baseline: "abc123def456789",
    branch: `stint/${name}`,
    worktree: `.stint/${name}`,
    changesets: [],
    pending: [],
  };
}
