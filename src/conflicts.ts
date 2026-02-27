import * as git from "./git.js";
import { listManifests, resolveSession, getWorktreePath } from "./manifest.js";

export function checkConflicts(sessionName?: string): void {
  const current = resolveSession(sessionName);
  const others = listManifests().filter((m) => m.name !== current.name);

  if (others.length === 0) {
    console.log("No other active sessions.");
    return;
  }

  // Get current session's changed files
  const currentFiles = new Set<string>();
  for (const cs of current.changesets) {
    cs.files.forEach((f) => currentFiles.add(f));
  }
  current.pending.forEach((f) => currentFiles.add(f));

  // Also check uncommitted changes in worktree
  const worktree = getWorktreePath(current);
  try {
    const uncommitted = git.gitInDir(worktree, "diff", "--name-only");
    if (uncommitted) {
      uncommitted.split("\n").forEach((f) => currentFiles.add(f));
    }
    const staged = git.gitInDir(worktree, "diff", "--cached", "--name-only");
    if (staged) {
      staged.split("\n").forEach((f) => currentFiles.add(f));
    }
  } catch { /* worktree may not be accessible */ }

  let hasConflicts = false;

  for (const other of others) {
    const otherFiles = new Set<string>();
    for (const cs of other.changesets) {
      cs.files.forEach((f) => otherFiles.add(f));
    }
    other.pending.forEach((f) => otherFiles.add(f));

    const overlap = [...currentFiles].filter((f) => otherFiles.has(f));
    if (overlap.length > 0) {
      hasConflicts = true;
      console.log(`Overlap with session '${other.name}':`);
      for (const f of overlap) {
        console.log(`  ${f}`);
      }
      console.log();
    }
  }

  if (!hasConflicts) {
    console.log("No file overlaps with other sessions.");
  }
}
