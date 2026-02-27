import { execFileSync } from "node:child_process";

export function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const stderr = e.stderr?.trim() || e.message || "unknown error";
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
}

export function gitInDir(dir: string, ...args: string[]): string {
  return git("-C", dir, ...args);
}

export function getHead(dir?: string): string {
  return dir ? gitInDir(dir, "rev-parse", "HEAD") : git("rev-parse", "HEAD");
}

export function getGitDir(): string {
  return git("rev-parse", "--git-dir");
}

/** Returns the main .git dir (shared across worktrees). */
export function getGitCommonDir(): string {
  return git("rev-parse", "--git-common-dir");
}

export function getTopLevel(): string {
  return git("rev-parse", "--show-toplevel");
}

export function currentBranch(dir?: string): string {
  const args = ["rev-parse", "--abbrev-ref", "HEAD"];
  return dir ? gitInDir(dir, ...args) : git(...args);
}

/**
 * Detect the default branch (main/master/etc) by checking the remote HEAD ref.
 * Falls back to "main" if detection fails.
 */
export function getDefaultBranch(): string {
  try {
    const ref = git("symbolic-ref", "refs/remotes/origin/HEAD");
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // No remote HEAD — check if 'main' or 'master' exists locally
    if (branchExists("main")) return "main";
    if (branchExists("master")) return "master";
    return "main";
  }
}

export function branchExists(name: string): boolean {
  try {
    git("show-ref", "--verify", "--quiet", `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
}

export function createBranch(name: string, from: string): void {
  git("branch", name, from);
}

export function deleteBranch(name: string): void {
  git("branch", "-D", name);
}

/**
 * Check if a remote-tracking ref exists locally (no network call).
 * Uses `git branch -r --list` which reads the local ref cache.
 */
export function remoteBranchExists(name: string): boolean {
  try {
    const output = git("branch", "-r", "--list", `origin/${name}`);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export function deleteRemoteBranch(name: string): void {
  git("push", "origin", "--delete", name);
}

export function addWorktree(path: string, branch: string): void {
  git("worktree", "add", path, branch);
}

/** Create a worktree in detached HEAD mode at a given ref. */
export function addWorktreeDetached(path: string, ref: string): void {
  git("worktree", "add", "--detach", path, ref);
}

export function removeWorktree(path: string, force = false): void {
  const args = force
    ? ["worktree", "remove", "--force", path]
    : ["worktree", "remove", path];
  git(...args);
}

export function diffNameOnly(base: string, head: string, dir?: string): string[] {
  const args = ["diff", "--name-only", `${base}..${head}`];
  const output = dir ? gitInDir(dir, ...args) : git(...args);
  return output ? output.split("\n") : [];
}

export function diffStat(base: string, head: string): string {
  return git("diff", "--stat", `${base}..${head}`);
}

export function logOneline(base: string, head: string): string {
  return git("log", "--oneline", `${base}..${head}`);
}

export function statusShort(dir: string): string {
  return gitInDir(dir, "status", "--short");
}

export function hasUncommittedChanges(dir: string): boolean {
  const status = statusShort(dir);
  return status.length > 0;
}

export function addAll(dir: string): void {
  gitInDir(dir, "add", "-A");
}

export function commit(dir: string, message: string): string {
  gitInDir(dir, "commit", "-m", message);
  return gitInDir(dir, "rev-parse", "HEAD");
}

export function resetSoft(dir: string, to: string): void {
  gitInDir(dir, "reset", "--soft", to);
}

/** Reset HEAD to a specific target, keeping changes as unstaged. */
export function resetMixed(dir: string, to: string): void {
  gitInDir(dir, "reset", to);
}

export function mergeInto(targetDir: string, ...branches: string[]): void {
  gitInDir(targetDir, "merge", ...branches);
}

export function push(branch: string): void {
  git("push", "-u", "origin", branch);
}

export function isInsideGitRepo(): boolean {
  try {
    git("rev-parse", "--is-inside-work-tree");
    return true;
  } catch {
    return false;
  }
}

export function hasCommits(): boolean {
  try {
    git("rev-parse", "HEAD");
    return true;
  } catch {
    return false;
  }
}

