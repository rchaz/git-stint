/**
 * Installs git-stint hooks into Claude Code's settings.
 *
 * Usage: node install.js [--project | --user]
 *
 * Hooks installed:
 *   PreToolUse (Write/Edit): Track files written in session worktrees
 *   Stop: Commit pending changes as WIP checkpoint
 */
declare function install(scope: "project" | "user"): void;
export { install };
