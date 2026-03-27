/**
 * Installs git-stint hooks into Claude Code's settings.
 *
 * Hooks installed:
 *   PreToolUse (Write/Edit): Track files written in session worktrees.
 *   Stop: Commit pending changes as WIP checkpoint.
 *
 * Also installs:
 *   .claude/rules/git-stint.md: Workflow instructions for Claude Code.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

  // Scaffold .stint.json and .claude/rules/git-stint.md if they don't exist
  if (scope === "project") {
    scaffoldConfig(process.cwd());
    scaffoldRules(process.cwd());
  }
}

const DEFAULT_CONFIG = {
  shared_dirs: [],
  main_branch_policy: "block",
  force_cleanup: "prompt",
  adopt_changes: "always",
};

const RULES_FILENAME = "git-stint.md";

const RULES_CONTENT = `# Git Stint Workflow

All file edits are intercepted by git-stint hooks and redirected to isolated
worktrees. One stint session = one branch = one PR.

## Session Naming

When creating a session, pick a short descriptive name that captures the task:
- Good: \`fix-auth-refresh\`, \`add-user-search\`, \`refactor-db-queries\`
- Bad: \`session-1\`, \`changes\`, \`test\`, \`update\`

The name becomes the branch (\`stint/<name>\`) and the PR title context.

## Session Lifecycle

- If the hook blocks a write, create a session: \`git stint start <descriptive-name>\`
- **Resuming**: If a session already exists from a previous conversation, resume it
  instead of creating a new one: \`git stint resume <session-name>\`
  Use \`git stint list\` to see active sessions. With \`block\` policy, the hook
  auto-resumes when exactly one session exists.
- Any uncommitted files on main are automatically carried into the new session.
  Do NOT redo work that was already written — it is adopted into the worktree.
- All edits redirect to \`.stint/<session>/\` worktree.
- \`git stint commit -m "msg"\` to commit logical units of work.
- \`git stint pr\` to push and create PR.
- \`git stint end\` ONLY after ALL related work is done.

## Rules

- **NEVER end or delete a stint session you didn't create.** Other sessions
  belong to other conversations or agents. Only operate on your own session
  (the one auto-created by the hook for your edits). Use \`git stint list\` to
  see all sessions — leave others alone.
- Do NOT call \`git stint end\` until all changes are committed (code, tests,
  config updates, follow-up tasks). Premature \`end\` kills the session; the
  next edit auto-creates a NEW session, fragmenting work across multiple PRs.
- Sub-agents share the same session (same PPID). No special handling needed.
- Files outside the repo bypass hooks — edit freely.
- Gitignored files bypass hooks — edit freely.
- Directories listed under \`shared_dirs\` in \`.stint.json\` are symlinked into
  worktrees pointing to the main repo's real directories. They must never be
  staged or committed. The hooks auto-add them to the worktree's \`.gitignore\`.

## Runtime

- Run tests and services from the worktree (your CWD), not the main repo. If
  you spot paths or dependencies resolving back to main, warn the user.
- Use a non-default port to avoid collisions with other sessions.
`;

function scaffoldConfig(repoRoot: string): void {
  const configPath = join(repoRoot, ".stint.json");
  if (existsSync(configPath)) {
    return;
  }
  const content = JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
  writeFileSync(configPath, content);
  console.log(`\nConfig created: ${configPath}`);
}

function scaffoldRules(repoRoot: string): void {
  const rulesDir = join(repoRoot, ".claude", "rules");
  const rulesPath = join(rulesDir, RULES_FILENAME);
  if (existsSync(rulesPath)) {
    return;
  }
  if (!existsSync(rulesDir)) {
    mkdirSync(rulesDir, { recursive: true });
  }
  writeFileSync(rulesPath, RULES_CONTENT);
  console.log(`\nRules created: ${rulesPath}`);
}

function removeRules(repoRoot: string): void {
  const rulesPath = join(repoRoot, ".claude", "rules", RULES_FILENAME);
  if (!existsSync(rulesPath)) {
    return;
  }
  unlinkSync(rulesPath);
  console.log(`Removed rules file: ${rulesPath}`);
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

  // Clean up rules file
  if (scope === "project") {
    removeRules(process.cwd());
  }
}
