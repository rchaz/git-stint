import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../dist/config.js";

describe("config", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stint-config-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no .stint.json exists", () => {
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.shared_dirs, []);
    assert.equal(config.main_branch_policy, "block");
    assert.equal(config.force_cleanup, "prompt");
  });

  it("parses valid .stint.json", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({
      shared_dirs: ["backend/data", "backend/logs"],
      main_branch_policy: "allow",
      force_cleanup: "force",
    }));
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.shared_dirs, ["backend/data", "backend/logs"]);
    assert.equal(config.main_branch_policy, "allow");
    assert.equal(config.force_cleanup, "force");
  });

  it("returns defaults for invalid JSON", () => {
    writeFileSync(join(dir, ".stint.json"), "not json{{{");
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.shared_dirs, []);
    assert.equal(config.main_branch_policy, "block");
  });

  it("ignores invalid policy values", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({
      main_branch_policy: "yolo",
      force_cleanup: 42,
    }));
    const config = loadConfig(dir);
    assert.equal(config.main_branch_policy, "block");
    assert.equal(config.force_cleanup, "prompt");
  });

  it("filters non-string entries from shared_dirs", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({
      shared_dirs: ["valid", 123, "", null, "also-valid"],
    }));
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.shared_dirs, ["valid", "also-valid"]);
  });

  it("handles empty object", () => {
    writeFileSync(join(dir, ".stint.json"), "{}");
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.shared_dirs, []);
    assert.equal(config.main_branch_policy, "block");
    assert.equal(config.force_cleanup, "prompt");
  });

  it("accepts all valid policy values", () => {
    for (const policy of ["prompt", "allow", "block"]) {
      writeFileSync(join(dir, ".stint.json"), JSON.stringify({ main_branch_policy: policy }));
      assert.equal(loadConfig(dir).main_branch_policy, policy);
    }
    for (const cleanup of ["prompt", "force", "fail"]) {
      writeFileSync(join(dir, ".stint.json"), JSON.stringify({ force_cleanup: cleanup }));
      assert.equal(loadConfig(dir).force_cleanup, cleanup);
    }
  });

  it("defaults adopt_changes to always", () => {
    const config = loadConfig(dir);
    assert.equal(config.adopt_changes, "always");
  });

  it("parses valid adopt_changes values", () => {
    for (const adopt of ["always", "never", "prompt"]) {
      writeFileSync(join(dir, ".stint.json"), JSON.stringify({ adopt_changes: adopt }));
      assert.equal(loadConfig(dir).adopt_changes, adopt);
    }
  });

  it("ignores invalid adopt_changes values", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({ adopt_changes: "yolo" }));
    assert.equal(loadConfig(dir).adopt_changes, "always");

    writeFileSync(join(dir, ".stint.json"), JSON.stringify({ adopt_changes: 42 }));
    assert.equal(loadConfig(dir).adopt_changes, "always");
  });

  it("defaults shared_files to empty array", () => {
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.shared_files, []);
  });

  it("parses shared_files array", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({
      shared_files: [".env", ".python-version"],
    }));
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.shared_files, [".env", ".python-version"]);
  });

  it("filters non-string entries from shared_files", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({
      shared_files: [".env", 123, "", null, ".python-version"],
    }));
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.shared_files, [".env", ".python-version"]);
  });

  it("defaults post_create to empty array", () => {
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.post_create, []);
  });

  it("parses post_create array", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({
      post_create: ["uv sync", "echo done"],
    }));
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.post_create, ["uv sync", "echo done"]);
  });

  it("accepts a single string for post_create", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({
      post_create: "npm install",
    }));
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.post_create, ["npm install"]);
  });

  it("filters non-string entries from post_create", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({
      post_create: ["uv sync", 42, "", null],
    }));
    const config = loadConfig(dir);
    assert.deepStrictEqual(config.post_create, ["uv sync"]);
  });
});
