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
    assert.equal(config.main_branch_policy, "prompt");
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
    assert.equal(config.main_branch_policy, "prompt");
  });

  it("ignores invalid policy values", () => {
    writeFileSync(join(dir, ".stint.json"), JSON.stringify({
      main_branch_policy: "yolo",
      force_cleanup: 42,
    }));
    const config = loadConfig(dir);
    assert.equal(config.main_branch_policy, "prompt");
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
    assert.equal(config.main_branch_policy, "prompt");
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
});
