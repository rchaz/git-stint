import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface StintConfig {
  shared_dirs: string[];
  main_branch_policy: "prompt" | "allow" | "block";
  force_cleanup: "prompt" | "force" | "fail";
  adopt_changes: "always" | "never" | "prompt";
}

const DEFAULTS: StintConfig = {
  shared_dirs: [],
  main_branch_policy: "block",
  force_cleanup: "prompt",
  adopt_changes: "always",
};

const VALID_POLICIES = new Set(["prompt", "allow", "block"]);
const VALID_CLEANUP = new Set(["prompt", "force", "fail"]);
const VALID_ADOPT = new Set(["always", "never", "prompt"]);

/**
 * Load .stint.json from repo root. Returns defaults if file missing or invalid.
 */
export function loadConfig(repoRoot: string): StintConfig {
  const configPath = join(repoRoot, ".stint.json");
  if (!existsSync(configPath)) return { ...DEFAULTS };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { ...DEFAULTS };
  }

  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const obj = raw as Record<string, unknown>;

  const config: StintConfig = { ...DEFAULTS };

  if (Array.isArray(obj.shared_dirs)) {
    config.shared_dirs = obj.shared_dirs.filter(
      (d): d is string => typeof d === "string" && d.length > 0,
    );
  }

  if (typeof obj.main_branch_policy === "string" && VALID_POLICIES.has(obj.main_branch_policy)) {
    config.main_branch_policy = obj.main_branch_policy as StintConfig["main_branch_policy"];
  }

  if (typeof obj.force_cleanup === "string" && VALID_CLEANUP.has(obj.force_cleanup)) {
    config.force_cleanup = obj.force_cleanup as StintConfig["force_cleanup"];
  }

  if (typeof obj.adopt_changes === "string" && VALID_ADOPT.has(obj.adopt_changes)) {
    config.adopt_changes = obj.adopt_changes as StintConfig["adopt_changes"];
  }

  return config;
}
