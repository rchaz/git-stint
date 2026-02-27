/**
 * Security tests: verify input validation and injection prevention.
 *
 * These tests scan actual source code to ensure security patterns are followed,
 * similar to claude-nonstop's security test approach.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dirname, "..", "..", "src");

describe("security: command injection prevention", () => {
  it("never uses execSync with string interpolation in src/", () => {
    const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      // execSync with template literals or string concatenation is dangerous
      assert.ok(
        !content.includes("execSync("),
        `${file} uses execSync — use execFileSync instead to prevent shell injection`,
      );
    }
  });

  it("uses execFileSync (array args) not execSync (string) for all git commands", () => {
    const gitTs = readFileSync(join(SRC_DIR, "git.ts"), "utf-8");
    assert.ok(gitTs.includes("execFileSync"), "git.ts should use execFileSync");
    assert.ok(!gitTs.includes("execSync("), "git.ts should not use execSync");
  });

  it("uses execFileSync for gh CLI calls", () => {
    const sessionTs = readFileSync(join(SRC_DIR, "session.ts"), "utf-8");
    // Find all execFileSync calls and verify they use array args
    const ghCalls = sessionTs.match(/execFileSync\s*\(\s*"gh"/g);
    assert.ok(ghCalls && ghCalls.length > 0, "session.ts should call gh via execFileSync");
    // Ensure no exec() or execSync() calls
    assert.ok(!sessionTs.match(/\bexecSync\s*\(/), "session.ts should not use execSync");
  });
});

describe("security: name validation", () => {
  // Import start to test name validation (it calls validateName internally)
  // We test the behavior, not the internal function

  it("rejects path traversal attempts", async () => {
    const { start } = await import("../../dist/session.js");
    const { createTempRepo } = await import("../helpers/temp-repo.js");
    const repo = createTempRepo();
    try {
      const dangerous = [
        "../escape",
        "../../etc/passwd",
        "foo/../bar",
        "..",
        "...",
      ];
      for (const name of dangerous) {
        assert.throws(() => start(name), Error, `Should reject '${name}'`);
      }
    } finally {
      repo.cleanup();
    }
  });

  it("rejects shell metacharacters", async () => {
    const { start } = await import("../../dist/session.js");
    const { createTempRepo } = await import("../helpers/temp-repo.js");
    const repo = createTempRepo();
    try {
      const dangerous = [
        "; rm -rf /",
        "$(whoami)",
        "`whoami`",
        "foo|bar",
        "foo&bar",
        "foo bar",
        "foo\nbar",
        "foo>bar",
        "foo<bar",
      ];
      for (const name of dangerous) {
        assert.throws(() => start(name), Error, `Should reject '${name}'`);
      }
    } finally {
      repo.cleanup();
    }
  });

  it("rejects whitespace-only names", async () => {
    const { start } = await import("../../dist/session.js");
    const { createTempRepo } = await import("../helpers/temp-repo.js");
    const repo = createTempRepo();
    try {
      // Empty string "" is falsy, so start("") generates a random name — that's OK.
      // But whitespace-only should be rejected since it has truthy length but no content.
      assert.throws(() => start("   "), /cannot be empty/);
    } finally {
      repo.cleanup();
    }
  });

  it("accepts valid session names", async () => {
    const { start } = await import("../../dist/session.js");
    const { loadManifest } = await import("../../dist/manifest.js");
    const { createTempRepo } = await import("../helpers/temp-repo.js");
    const repo = createTempRepo();
    try {
      const valid = [
        "my-feature",
        "fix_bug",
        "v2.0",
        "ALLCAPS",
        "CamelCase",
        "a1b2c3",
      ];
      for (const name of valid) {
        start(name);
        assert.ok(loadManifest(name), `Should accept '${name}'`);
      }
    } finally {
      repo.cleanup();
    }
  });
});

describe("security: test command execution", () => {
  it("test-session.ts uses execFileSync with sh -c, not raw exec", () => {
    const testTs = readFileSync(join(SRC_DIR, "test-session.ts"), "utf-8");
    // Verify the pattern: execFileSync("sh", ["-c", cmd], ...)
    assert.ok(
      testTs.includes('execFileSync("sh", ["-c"'),
      "test-session.ts should use execFileSync('sh', ['-c', cmd]) pattern",
    );
    assert.ok(!testTs.includes("execSync("), "test-session.ts should not use execSync");
  });
});

describe("security: manifest file safety", () => {
  it("saveManifest uses atomic write (temp file + rename)", () => {
    const manifestTs = readFileSync(join(SRC_DIR, "manifest.ts"), "utf-8");
    assert.ok(manifestTs.includes("renameSync"), "Should use renameSync for atomic write");
    assert.ok(manifestTs.includes(".tmp"), "Should write to .tmp file first");
  });
});
