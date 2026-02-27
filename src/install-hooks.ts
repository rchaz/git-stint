/**
 * Installs git-stint hooks into Claude Code's settings.
 *
 * Hooks installed:
 *   PreToolUse (Write/Edit): Track files written in session worktrees.
 *   Stop: Commit pending changes as WIP checkpoint.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HOOKS = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Write|Edit|NotebookEdit",
        command: "git-stint-hook-pre-tool",
      },
    ],
    Stop: [
      {
        command: "git-stint-hook-stop",
      },
    ],
  },
};

function getSettingsPath(scope: "project" | "user"): string {
  if (scope === "user") {
    const home = process.env.HOME || process.env.USERPROFILE || "~";
    return join(home, ".claude", "settings.json");
  }
  // Project scope
  return join(process.cwd(), ".claude", "settings.json");
}

export function install(scope: "project" | "user"): void {
  const settingsPath = getSettingsPath(scope);
  const dir = resolve(settingsPath, "..");

  // Read existing settings or start fresh
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  // Merge hooks (don't overwrite existing hooks)
  const hooks = (settings.hooks || {}) as Record<string, Array<Record<string, string>>>;
  for (const [event, hookList] of Object.entries(HOOKS.hooks)) {
    if (!hooks[event]) {
      hooks[event] = [];
    }
    for (const hook of hookList) {
      const exists = hooks[event].some((h) => h.command === hook.command);
      if (!exists) {
        hooks[event].push(hook);
      }
    }
  }
  settings.hooks = hooks;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Atomic write: temp file + rename to prevent corruption if interrupted
  const tmp = settingsPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, settingsPath);

  console.log(`Hooks installed to ${settingsPath}`);
  console.log("\nHooks added:");
  console.log("  PreToolUse (Write/Edit): track files in session worktrees");
  console.log("  Stop: commit pending changes as WIP checkpoint");
}

/** Known hook commands installed by git-stint. */
const STINT_COMMANDS = new Set(
  Object.values(HOOKS.hooks).flat().map((h) => h.command),
);

export function uninstall(scope: "project" | "user"): void {
  const settingsPath = getSettingsPath(scope);

  if (!existsSync(settingsPath)) {
    console.log("No settings file found. Nothing to uninstall.");
    return;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    console.error(`Failed to parse ${settingsPath}. Fix it manually.`);
    return;
  }

  const hooks = settings.hooks as Record<string, Array<Record<string, string>>> | undefined;
  if (!hooks) {
    console.log("No hooks configured. Nothing to uninstall.");
    return;
  }

  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const before = hooks[event].length;
    hooks[event] = hooks[event].filter((h) => !STINT_COMMANDS.has(h.command));
    removed += before - hooks[event].length;
    // Remove empty arrays to keep settings clean
    if (hooks[event].length === 0) {
      delete hooks[event];
    }
  }
  // Remove empty hooks object
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  if (removed === 0) {
    console.log("No git-stint hooks found. Nothing to uninstall.");
    return;
  }

  // Atomic write
  const tmp = settingsPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, settingsPath);

  console.log(`Removed ${removed} git-stint hook(s) from ${settingsPath}`);
}
