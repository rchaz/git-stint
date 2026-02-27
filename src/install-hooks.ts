/**
 * Installs git-stint hooks into Claude Code's settings.
 *
 * Hooks installed:
 *   PreToolUse (Write/Edit): Track files written in session worktrees.
 *   Stop: Commit pending changes as WIP checkpoint.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Hook command names owned by git-stint. */
const STINT_COMMANDS = new Set([
  "git-stint-hook-pre-tool",
  "git-stint-hook-stop",
]);

const HOOKS = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Write|Edit|NotebookEdit",
        hooks: [{ type: "command", command: "git-stint-hook-pre-tool" }],
      },
    ],
    Stop: [
      {
        hooks: [{ type: "command", command: "git-stint-hook-stop" }],
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks = (settings.hooks || {}) as Record<string, Array<Record<string, any>>>;
  for (const [event, hookList] of Object.entries(HOOKS.hooks)) {
    if (!hooks[event]) {
      hooks[event] = [];
    }
    for (const hook of hookList) {
      const cmd = hook.hooks[0].command;
      // Check both new format (hooks[].command) and old format (top-level command)
      const exists = hooks[event].some((h) =>
        h.hooks?.some((hh: Record<string, string>) => hh.command === cmd) ||
        h.command === cmd,
      );
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

/** Check if a hook entry (old or new format) contains a stint command. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isStintHook(h: Record<string, any>): boolean {
  // New format: { hooks: [{ type: "command", command: "..." }] }
  if (Array.isArray(h.hooks)) {
    return h.hooks.some((hh: Record<string, string>) => STINT_COMMANDS.has(hh.command));
  }
  // Old format: { command: "..." }
  return STINT_COMMANDS.has(h.command);
}

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks = settings.hooks as Record<string, Array<Record<string, any>>> | undefined;
  if (!hooks) {
    console.log("No hooks configured. Nothing to uninstall.");
    return;
  }

  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const before = hooks[event].length;
    hooks[event] = hooks[event].filter((h) => !isStintHook(h));
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
