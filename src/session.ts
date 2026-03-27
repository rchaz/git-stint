import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as git from "./git.js";
import { loadConfig } from "./config.js";
import {
  type SessionManifest,
  type Changeset,
  BRANCH_PREFIX,
  WORKTREE_DIR,
  MANIFEST_VERSION,
  loadManifest,
  saveManifest,
  deleteManifest,
  listManifests,
  resolveSession,
  getWorktreePath,
  getRepoRoot,
} from "./manifest.js";

// --- Constants ---

const WIP_MESSAGE = "WIP: session checkpoint";

// --- Name generation ---

const ADJECTIVES = [
  "swift", "keen", "bold", "calm", "warm", "cool", "bright", "quick",
  "sharp", "fair", "kind", "deep", "soft", "pure", "fine", "clear",
  "fresh", "glad", "neat", "safe", "wise", "lean", "fast", "true",
  "rare", "prime", "tidy", "pale", "dense", "vivid", "plush", "brisk",
  "deft", "crisp", "snug", "lush", "mild", "stark", "vast", "terse",
  "grand", "dusk", "dawn", "sage", "sleek", "polar", "lunar", "coral",
  "azure", "ivory",
];
const NOUNS = [
  "fox", "oak", "elm", "bay", "sky", "sun", "dew", "pine",
  "ivy", "ash", "gem", "owl", "bee", "fin", "ray", "fern",
  "lark", "wren", "hare", "cove", "vale", "reef", "glen", "peak",
  "dale", "mist", "reed", "lynx", "dove", "hawk", "moss", "tide",
  "crest", "leaf", "birch", "cliff", "brook", "ridge", "grove", "shore",
  "stone", "flint", "cedar", "maple", "drift", "spark", "blaze", "frost",
  "crane", "otter",
];

function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

/**
 * Validate session name: must be alphanumeric with hyphens/underscores only.
 * Prevents path traversal, git branch issues, and shell injection.
 */
function validateName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error("Session name cannot be empty.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(
      `Invalid session name '${name}'. Use only letters, numbers, hyphens, underscores, or dots. Must start with alphanumeric.`,
    );
  }
  if (name.includes("..")) {
    throw new Error("Session name cannot contain '..'.");
  }
}

function ensureUniqueName(name: string): string {
  const existing = new Set(listManifests().map((m) => m.name));
  if (!existing.has(name) && !git.branchExists(`${BRANCH_PREFIX}${name}`)) return name;
  for (let i = 2; i < 100; i++) {
    const candidate = `${name}-${i}`;
    if (!existing.has(candidate) && !git.branchExists(`${BRANCH_PREFIX}${candidate}`)) return candidate;
  }
  throw new Error(`Cannot generate unique name from '${name}'. Run 'git stint prune' to clean up stale sessions.`);
}

// --- Ensure .stint/ is excluded locally (not committed) ---

function ensureExcluded(): void {
  // Use git's common dir — correct for both main repo and worktrees.
  // In a worktree, .git is a file, not a directory, so join(topLevel, ".git", ...) would fail.
  const commonDir = resolve(git.getGitCommonDir());
  const excludePath = join(commonDir, "info", "exclude");

  if (existsSync(excludePath)) {
    const content = readFileSync(excludePath, "utf-8");
    const lines = content.split("\n");
    if (lines.some((l) => l.trim() === `${WORKTREE_DIR}/` || l.trim() === WORKTREE_DIR)) return;
  }

  // Append to local exclude (never committed, never affects other team members)
  const entry = `\n# git-stint worktrees\n${WORKTREE_DIR}/\n`;
  mkdirSync(dirname(excludePath), { recursive: true });
  if (existsSync(excludePath)) {
    const content = readFileSync(excludePath, "utf-8");
    writeFileSync(excludePath, content.endsWith("\n") ? content + entry.slice(1) : content + entry);
  } else {
    writeFileSync(excludePath, entry);
  }
}

/** Warn if CWD is inside the worktree being removed. */
function warnIfInsideWorktree(worktree: string): void {
  if (process.cwd().startsWith(worktree)) {
    const topLevel = getRepoRoot();
    console.warn(`\nWarning: Your shell is inside the worktree being removed.`);
    console.warn(`Run: cd ${topLevel}`);
  }
}

// --- Commands ---

export function start(name?: string, clientId?: string, adoptOverride?: boolean): void {
  if (!git.isInsideGitRepo()) {
    throw new Error("Not inside a git repository.");
  }
  if (!git.hasCommits()) {
    throw new Error("Repository has no commits. Make an initial commit first.");
  }

  if (name) validateName(name);
  const sessionName = name ? ensureUniqueName(name) : ensureUniqueName(generateName());
  const branchName = `${BRANCH_PREFIX}${sessionName}`;

  if (git.branchExists(branchName)) {
    throw new Error(
      `Branch '${branchName}' already exists. Run 'git stint prune' to clean orphaned branches, or choose a different name.`,
    );
  }

  const head = git.getHead();
  const topLevel = getRepoRoot();
  const worktreeRel = `${WORKTREE_DIR}/${sessionName}`;
  const worktreeAbs = resolve(topLevel, worktreeRel);

  // Create branch first
  git.createBranch(branchName, head);

  // Create worktree — rollback branch on failure
  try {
    ensureExcluded();
    git.addWorktree(worktreeAbs, branchName);
  } catch (err) {
    // Rollback: delete the branch we just created
    try { git.deleteBranch(branchName); } catch { /* best effort */ }
    throw err;
  }

  // Adopt uncommitted changes from main repo (before symlinking, to avoid conflicts)
  const config = loadConfig(topLevel);
  const shouldAdopt = adoptOverride !== undefined
    ? adoptOverride
    : config.adopt_changes === "always";
  let adoptedFiles = 0;
  if (git.hasUncommittedChanges(topLevel)) {
    const statusOutput = git.statusShort(topLevel);
    const fileCount = statusOutput.split("\n").filter(Boolean).length;

    if (adoptOverride === undefined && config.adopt_changes === "prompt") {
      console.warn(`Warning: ${fileCount} uncommitted file(s) on main. Use --adopt to carry them over, or --no-adopt to leave them.`);
    } else if (shouldAdopt) {
      adoptedFiles = fileCount;
      try {
        git.stash(topLevel);
        try {
          git.stashPop(worktreeAbs);
        } catch {
          // Stash pop failed — restore stash to main repo
          console.warn("Warning: Could not apply uncommitted changes to worktree. Stash preserved in main repo.");
          try { git.stashPop(topLevel); } catch { /* leave stash intact */ }
        }
      } catch {
        // Nothing to stash (git stash can fail if changes are only untracked and gitignored)
        adoptedFiles = 0;
      }
    }
  }

  // Symlink shared directories from config (after adopt, so stash pop doesn't conflict with symlinks)
  const linkedDirs: string[] = [];
  for (const dir of config.shared_dirs) {
    const source = resolve(topLevel, dir);
    const target = resolve(worktreeAbs, dir);
    if (!existsSync(source)) {
      console.warn(`Warning: shared_dirs entry '${dir}' not found in repo, skipping.`);
      continue;
    }
    if (existsSync(target)) continue; // already exists (e.g., tracked in git or adopted from stash)
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
    linkedDirs.push(dir);
  }

  // Prevent shared_dirs symlinks from being staged by `git add -A`.
  // .gitignore rules with trailing slash (e.g., "backend/data/") only match directories,
  // NOT symlinks. Symlinks are files with mode 120000 in git. We must add entries WITHOUT
  // trailing slash so git ignores both the directory (in main) and the symlink (in worktree).
  if (linkedDirs.length > 0) {
    const gitignorePath = join(worktreeAbs, ".gitignore");
    const markerStart = "# git-stint shared_dirs (auto-generated, do not commit)";
    const markerEnd = "# end git-stint shared_dirs";
    let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    const entries = linkedDirs.map((d) => `${d}`).join("\n");
    const block = `${markerStart}\n${entries}\n${markerEnd}`;

    if (content.includes(markerStart)) {
      // Replace existing block with current shared_dirs (handles additions/removals)
      const regex = new RegExp(
        `${markerStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?` +
        `(?:${markerEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|$)`,
      );
      content = content.replace(regex, block);
    } else {
      content = content.endsWith("\n") ? content + "\n" + block + "\n" : content + "\n\n" + block + "\n";
    }
    writeFileSync(gitignorePath, content);

    // Immediately unstage the symlinks if they were already tracked
    for (const d of linkedDirs) {
      try {
        git.gitInDir(worktreeAbs, "rm", "--cached", "--ignore-unmatch", "-r", d);
      } catch {
        // best effort — may not be tracked
      }
    }
  }

  // Revoke main-branch write pass when entering session mode
  removeAllowMainFlag();

  // Create manifest
  const manifest: SessionManifest = {
    version: MANIFEST_VERSION,
    name: sessionName,
    startedAt: head,
    baseline: head,
    branch: branchName,
    worktree: worktreeRel,
    changesets: [],
    pending: [],
    ...(clientId ? { clientId } : {}),
  };
  saveManifest(manifest);

  console.log(`Session '${sessionName}' started.`);
  console.log(`  Branch:   ${branchName}`);
  console.log(`  Worktree: ${worktreeAbs}`);

  if (linkedDirs.length > 0) {
    console.log(`\nShared directories (symlinked — changes affect main repo):`);
    for (const dir of linkedDirs) {
      console.log(`  ${dir} → ${resolve(topLevel, dir)}`);
    }
  }

  if (adoptedFiles > 0) {
    console.log(`\nCarried over ${adoptedFiles} uncommitted file(s) into session.`);
  }

  console.log(`\ncd "${worktreeAbs}"`);
}

export function track(files: string[], sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);
  const topLevel = getRepoRoot();

  for (const file of files) {
    const absFile = resolve(file);
    let relFile: string;

    if (absFile.startsWith(worktree + "/")) {
      // Absolute path inside the worktree — make relative to worktree root
      relFile = absFile.slice(worktree.length + 1);
    } else if (absFile.startsWith(topLevel + "/")) {
      // Absolute path inside the main repo — convert to repo-relative
      relFile = absFile.slice(topLevel.length + 1);
    } else {
      // Relative path or outside both — store as-is (already repo-relative)
      relFile = file;
    }

    if (relFile && !manifest.pending.includes(relFile)) {
      manifest.pending.push(relFile);
    }
  }
  saveManifest(manifest);
}

export function status(sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);

  console.log(`Session: ${manifest.name}`);
  console.log(`Branch:  ${manifest.branch}`);
  console.log(`Base:    ${manifest.startedAt.slice(0, 8)}`);
  console.log(`Commits: ${manifest.changesets.length}`);
  console.log();

  if (manifest.pending.length > 0) {
    console.log("Pending files:");
    for (const f of manifest.pending) {
      console.log(`  ${f}`);
    }
    console.log();
  }

  if (manifest.changesets.length > 0) {
    console.log("Changesets:");
    for (const cs of manifest.changesets) {
      console.log(`  #${cs.id} ${cs.sha.slice(0, 8)} ${cs.message}`);
    }
    console.log();
  }

  // Show git status in worktree
  try {
    const st = git.statusShort(worktree);
    if (st) {
      console.log("Working directory:");
      console.log(st);
    } else {
      console.log("Working directory clean.");
    }
  } catch {
    console.log("(worktree not accessible)");
  }
}

/** Show both staged and unstaged changes. */
export function diff(sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);

  const unstaged = git.gitInDir(worktree, "diff");
  const staged = git.gitInDir(worktree, "diff", "--cached");

  if (unstaged) {
    console.log(unstaged);
  }
  if (staged) {
    if (unstaged) console.log();
    console.log("Staged changes:");
    console.log(staged);
  }
  if (!unstaged && !staged) {
    console.log("No changes.");
  }
}

export function sessionCommit(message: string, sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);

  if (!existsSync(worktree)) {
    throw new Error(`Worktree missing at ${worktree}. Run 'git stint prune' to clean up.`);
  }

  // Check for changes
  if (!git.hasUncommittedChanges(worktree)) {
    console.log("Nothing to commit.");
    return;
  }

  const oldBaseline = manifest.baseline;

  // Stage and commit
  git.addAll(worktree);
  const newSha = git.commit(worktree, message);

  // Determine files changed
  const files = git.diffNameOnly(oldBaseline, newSha, worktree);

  // Record changeset
  const changeset: Changeset = {
    id: manifest.changesets.length + 1,
    sha: newSha,
    message,
    files,
    timestamp: new Date().toISOString(),
  };
  manifest.changesets.push(changeset);
  manifest.baseline = newSha;
  manifest.pending = [];
  saveManifest(manifest);

  console.log(`Committed: ${newSha.slice(0, 8)} ${message}`);
  console.log(`  ${files.length} file(s) changed`);
}

export function log(sessionName?: string): void {
  const manifest = resolveSession(sessionName);

  if (manifest.changesets.length === 0) {
    console.log("No commits in this session.");
    return;
  }

  console.log(`Session '${manifest.name}' — ${manifest.changesets.length} commit(s):\n`);
  for (const cs of manifest.changesets) {
    console.log(`  ${cs.sha.slice(0, 8)} ${cs.message}`);
    console.log(`    ${cs.timestamp} — ${cs.files.length} file(s)`);
    for (const f of cs.files) {
      console.log(`      ${f}`);
    }
  }
}

export function squash(message: string, sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);

  if (manifest.changesets.length === 0) {
    console.log("Nothing to squash.");
    return;
  }

  // Refuse to squash with uncommitted changes — they'd be silently included
  if (git.hasUncommittedChanges(worktree)) {
    throw new Error("Uncommitted changes in worktree. Commit or stash them before squashing.");
  }

  // Capture count before overwriting
  const originalCount = manifest.changesets.length;
  const allFiles = [...new Set(manifest.changesets.flatMap((cs) => cs.files))];

  // Soft reset to the starting point, keeping all changes staged
  git.resetSoft(worktree, manifest.startedAt);
  const newSha = git.commit(worktree, message);

  manifest.changesets = [
    {
      id: 1,
      sha: newSha,
      message,
      files: allFiles,
      timestamp: new Date().toISOString(),
    },
  ];
  manifest.baseline = newSha;
  saveManifest(manifest);

  console.log(`Squashed ${originalCount} commit(s) → ${newSha.slice(0, 8)} ${message}`);
}

export function merge(sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);
  const topLevel = getRepoRoot();
  const mainBranch = git.currentBranch(topLevel);

  // Safety check: don't merge into the session branch itself
  if (mainBranch === manifest.branch) {
    throw new Error("Cannot merge: the main repo is checked out to the session branch. Switch to your main branch first.");
  }

  // Auto-commit pending changes before merging
  if (existsSync(worktree) && git.hasUncommittedChanges(worktree)) {
    console.log("Committing pending changes...");
    try {
      sessionCommit(WIP_MESSAGE, manifest.name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Auto-commit before merge failed: ${msg}`);
    }
  }

  // Merge the session branch into the current branch in the main repo
  try {
    git.gitInDir(topLevel, "merge", manifest.branch);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("conflict")) {
      throw new Error(
        `Merge conflict. Resolve conflicts in ${topLevel} then run:\n` +
        `  cd "${topLevel}"\n` +
        `  git commit\n` +
        `  git stint end --session ${manifest.name}`,
      );
    }
    throw new Error(`Merge failed: ${msg}`);
  }

  console.log(`Merged '${manifest.branch}' into '${mainBranch}'.`);

  // Clean up — may fail if CWD is inside the worktree
  try {
    cleanup(manifest);
    console.log("Session cleaned up.");
  } catch {
    console.log(`Run: cd "${topLevel}" && git stint end --session ${manifest.name}`);
  }
}

/** Push branch and create PR via GitHub CLI. Uses execFileSync to prevent command injection. */
export function pr(title?: string, sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const prTitle = title || `stint: ${manifest.name}`;
  const baseBranch = git.getDefaultBranch();

  // Build PR body from session history
  const body = buildPrBody(manifest);

  // Push branch
  console.log(`Pushing ${manifest.branch}...`);
  git.push(manifest.branch);

  // Create PR via gh CLI — execFileSync prevents shell injection
  try {
    const result = execFileSync("gh", [
      "pr", "create",
      "--base", baseBranch,
      "--head", manifest.branch,
      "--title", prTitle,
      "--body", body,
    ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    console.log(result);
  } catch (err: unknown) {
    const e = err as { stderr?: string };
    const stderr = e.stderr?.trim() || "";
    if (stderr.includes("already exists")) {
      console.log("PR already exists for this branch.");
      try {
        const url = execFileSync("gh", [
          "pr", "view", manifest.branch, "--json", "url", "-q", ".url",
        ], { encoding: "utf-8" }).trim();
        console.log(url);
      } catch { /* ignore */ }
    } else {
      throw new Error(`Failed to create PR: ${stderr}`);
    }
  }
}

function buildPrBody(manifest: SessionManifest): string {
  const lines: string[] = [];

  if (manifest.changesets.length > 0) {
    lines.push("## Changes\n");
    for (const cs of manifest.changesets) {
      lines.push(`- **${cs.message}** (${cs.files.length} file${cs.files.length === 1 ? "" : "s"})`);
    }

    const allFiles = [...new Set(manifest.changesets.flatMap((cs) => cs.files))];
    lines.push(`\n## Files changed (${allFiles.length})\n`);
    for (const f of allFiles.sort()) {
      lines.push(`- \`${f}\``);
    }
  }

  lines.push("\n---\n*Created with [git-stint](https://github.com/rchaz/git-stint)*");
  return lines.join("\n");
}

export function end(sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);

  // Auto-commit pending changes
  if (existsSync(worktree) && git.hasUncommittedChanges(worktree)) {
    console.log("Committing pending changes...");
    try {
      sessionCommit(WIP_MESSAGE, manifest.name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Auto-commit before end failed: ${msg}`);
    }
  }

  warnIfInsideWorktree(worktree);

  console.log(`Ending session '${manifest.name}'...`);
  cleanup(manifest);
  console.log("Session ended.");
}

export function abort(sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);

  warnIfInsideWorktree(worktree);

  console.log(`Aborting session '${manifest.name}'...`);
  cleanup(manifest, true);
  console.log("Session discarded. All changes removed.");
}

/** Revert last commit, keeping changes as unstaged files. */
export function undo(sessionName?: string): void {
  const manifest = resolveSession(sessionName);
  const worktree = getWorktreePath(manifest);

  if (manifest.changesets.length === 0) {
    console.log("Nothing to undo.");
    return;
  }

  const last = manifest.changesets[manifest.changesets.length - 1];

  // Reset to the known previous baseline (not hardcoded HEAD~1)
  const resetTarget = manifest.changesets.length > 1
    ? manifest.changesets[manifest.changesets.length - 2].sha
    : manifest.startedAt;
  git.resetMixed(worktree, resetTarget);

  // Update manifest
  manifest.changesets.pop();
  manifest.baseline = resetTarget;
  manifest.pending = last.files;
  saveManifest(manifest);

  console.log(`Undid commit: ${last.sha.slice(0, 8)} ${last.message}`);
  console.log(`${last.files.length} file(s) back to pending.`);
}

export function which(sessionName?: string, showWorktree?: boolean): void {
  const manifest = resolveSession(sessionName);
  if (showWorktree) {
    console.log(getWorktreePath(manifest));
  } else {
    console.log(manifest.name);
  }
}

export function list(): void {
  const manifests = listManifests();
  if (manifests.length === 0) {
    console.log("No active sessions.");
    return;
  }

  console.log("Active sessions:\n");
  const maxName = Math.max(...manifests.map((m) => m.name.length), 4);

  console.log(
    `  ${"NAME".padEnd(maxName)}  COMMITS  PENDING  BASE`,
  );
  console.log(`  ${"─".repeat(maxName)}  ${"─".repeat(7)}  ${"─".repeat(7)}  ${"─".repeat(8)}`);

  for (const m of manifests) {
    const base = m.startedAt.slice(0, 8);
    console.log(
      `  ${m.name.padEnd(maxName)}  ${String(m.changesets.length).padStart(7)}  ${String(m.pending.length).padStart(7)}  ${base}`,
    );
  }
}

export function listJson(): void {
  const manifests = listManifests();
  const result = manifests.map((m) => ({
    name: m.name,
    branch: m.branch,
    worktree: m.worktree,
    commits: m.changesets.length,
    pending: m.pending.length,
    startedAt: m.startedAt,
  }));
  console.log(JSON.stringify(result));
}

/** Clean up orphaned worktrees, manifests, and branches. */
export function prune(): void {
  const topLevel = getRepoRoot();
  const stintDir = resolve(topLevel, WORKTREE_DIR);
  const manifests = listManifests();
  const manifestNames = new Set(manifests.map((m) => m.name));
  let cleaned = 0;

  // Check for worktrees without manifests (including leftover stint-combine-* from crashed testCombine)
  if (existsSync(stintDir)) {
    const entries = readdirSync(stintDir).filter((entry) => {
      try { return statSync(resolve(stintDir, entry)).isDirectory(); } catch { return false; }
    });
    for (const entry of entries) {
      const isCombineLeftover = entry.startsWith("stint-combine-");
      if (!isCombineLeftover && manifestNames.has(entry)) continue;
      // Orphaned worktree (no manifest) or leftover combine worktree
      const label = isCombineLeftover ? "leftover combine worktree" : "orphaned worktree";
      console.log(`Removing ${label}: ${WORKTREE_DIR}/${entry}`);
      try {
        git.removeWorktree(resolve(stintDir, entry), true);
        cleaned++;
      } catch (err: unknown) {
        const e = err as Error;
        console.error(`  Failed: ${e.message}`);
      }
      // Clean up combine branch if it exists
      if (isCombineLeftover) {
        try { git.deleteBranch(entry); } catch { /* may not exist */ }
      }
    }
  }

  // Check for manifests without worktrees
  for (const m of manifests) {
    const wt = getWorktreePath(m);
    if (!existsSync(wt)) {
      console.log(`Removing orphaned manifest: ${m.name} (worktree missing)`);
      deleteManifest(m.name);
      try {
        git.deleteBranch(m.branch);
        console.log(`  Deleted branch: ${m.branch}`);
      } catch { /* branch may not exist */ }
      cleaned++;
    }
  }

  // Check for stint/* branches without manifests
  try {
    const output = git.git("branch", "--list", `${BRANCH_PREFIX}*`);
    const branches = output
      .split("\n")
      .map((b) => b.replace("*", "").trim()) // strip current-branch marker
      .filter(Boolean);
    for (const branch of branches) {
      const name = branch.replace(BRANCH_PREFIX, "");
      if (!manifestNames.has(name)) {
        console.log(`Removing orphaned branch: ${branch}`);
        try {
          git.deleteBranch(branch);
          cleaned++;
        } catch (err: unknown) {
          const e = err as Error;
          console.error(`  Failed: ${e.message}`);
        }
      }
    }
  } catch { /* no stint branches */ }

  // Clean up stale allow-main flags from dead processes
  pruneAllowMainFlags();

  if (cleaned === 0) {
    console.log("Nothing to clean up.");
  } else {
    console.log(`\nCleaned up ${cleaned} orphan(s).`);
  }
}

// --- Helpers ---

function cleanup(manifest: SessionManifest, force = false): void {
  const worktree = getWorktreePath(manifest);
  const topLevel = getRepoRoot();
  const config = loadConfig(topLevel);

  // Remove shared dir symlinks before removing worktree to protect linked data
  if (existsSync(worktree)) {
    for (const dir of config.shared_dirs) {
      const target = resolve(worktree, dir);
      if (!existsSync(target)) continue;
      try {
        if (lstatSync(target).isSymbolicLink()) {
          unlinkSync(target);
        } else {
          console.warn(`Warning: '${dir}' in worktree is a real directory (not a symlink). Data will be lost on cleanup.`);
        }
      } catch { /* best effort */ }
    }
  }

  // Remove worktree
  if (existsSync(worktree)) {
    try {
      git.removeWorktree(worktree, force);
    } catch (err) {
      if (!force) {
        // Apply force_cleanup policy
        if (config.force_cleanup === "fail") {
          throw err;
        }
        if (config.force_cleanup === "force") {
          git.removeWorktree(worktree, true);
        } else {
          // "prompt" (default) — retry with force, matching previous behavior
          git.removeWorktree(worktree, true);
        }
      } else {
        throw err;
      }
    }
  }

  // Check if remote branch should be cleaned up (before deleting local branch,
  // since we need it for the merge check).
  //
  // IMPORTANT: We check against REMOTE tracking refs (origin/main), not local
  // branches. A local `git stint merge` merges into local main, but the user
  // may not have pushed yet. Deleting the remote session branch before the
  // remote main has the changes would destroy the only remote copy of the work.
  // By checking origin/main, we only delete when the remote already has the
  // changes — matching how GitHub/GitLab auto-delete works.
  let shouldDeleteRemote = false;
  if (git.remoteBranchExists(manifest.branch)) {
    // Build list of remote tracking refs to check against.
    const targets = new Set<string>();
    const defaultBranch = git.getDefaultBranch();
    targets.add(`origin/${defaultBranch}`);
    try {
      const current = git.currentBranch(topLevel);
      if (current !== manifest.branch && git.remoteBranchExists(current)) {
        targets.add(`origin/${current}`);
      }
    } catch { /* detached HEAD — skip */ }

    for (const target of targets) {
      if (git.isBranchMergedInto(manifest.branch, target)) {
        shouldDeleteRemote = true;
        break;
      }
    }

    if (!shouldDeleteRemote) {
      console.log(
        `Remote branch 'origin/${manifest.branch}' was NOT deleted (has unmerged changes).\n` +
        `  To delete manually: git push origin --delete ${manifest.branch}`,
      );
    }
  }

  // Delete local branch
  try {
    git.deleteBranch(manifest.branch);
  } catch { /* branch may already be deleted */ }

  // Delete remote branch if all changes are merged
  if (shouldDeleteRemote) {
    try {
      git.deleteRemoteBranch(manifest.branch);
      console.log(`Deleted remote branch 'origin/${manifest.branch}'.`);
    } catch {
      // Branch may already be deleted on the remote (e.g., GitHub auto-delete
      // after PR merge) or the network may be down. Either way, not critical.
      console.log(
        `Could not delete remote branch 'origin/${manifest.branch}'.\n` +
        `  It may have already been deleted (e.g., by GitHub after PR merge).\n` +
        `  To delete manually: git push origin --delete ${manifest.branch}`,
      );
    }
  }

  // Delete manifest last — if anything above fails, manifest persists for prune
  deleteManifest(manifest.name);
}

// --- Allow-main flag ---

const ALLOW_MAIN_PREFIX = "stint-main-allowed-";

function getAllowMainPath(pid: number): string {
  const commonDir = resolve(git.getGitCommonDir());
  return join(commonDir, `${ALLOW_MAIN_PREFIX}${pid}`);
}

function removeAllowMainFlag(): void {
  // Remove flag for current process tree only (called from `start`)
  const flagPath = getAllowMainPath(process.ppid);
  if (existsSync(flagPath)) unlinkSync(flagPath);
}

/** Clean up allow-main flags for PIDs that are no longer running. */
export function pruneAllowMainFlags(): void {
  const commonDir = resolve(git.getGitCommonDir());
  const entries = readdirSync(commonDir).filter((e) => e.startsWith(ALLOW_MAIN_PREFIX));
  let cleaned = 0;
  for (const entry of entries) {
    const pid = parseInt(entry.slice(ALLOW_MAIN_PREFIX.length), 10);
    if (isNaN(pid)) { unlinkSync(join(commonDir, entry)); cleaned++; continue; }
    try {
      process.kill(pid, 0); // signal 0 = existence check, no actual signal
    } catch {
      // Process doesn't exist — stale flag
      unlinkSync(join(commonDir, entry));
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`Cleaned ${cleaned} stale allow-main flag(s).`);
}

/**
 * Resume an existing session by rebinding it to the current client.
 * Updates the clientId so hooks route writes to this session's worktree.
 *
 * @param name - Session name to resume
 * @param clientId - Explicit client ID. If not provided, falls back to process.ppid.
 */
export function resume(name: string, clientId?: string): void {
  if (!git.isInsideGitRepo()) {
    throw new Error("Not inside a git repository.");
  }

  if (!name || name.trim().length === 0) {
    throw new Error("Session name is required. Usage: git stint resume <name>");
  }

  const manifest = loadManifest(name);
  if (!manifest) {
    throw new Error(
      `Session '${name}' not found.\n` +
      `Run 'git stint list' to see active sessions.`,
    );
  }

  // Verify the worktree still exists
  const worktree = getWorktreePath(manifest);
  if (!existsSync(worktree)) {
    throw new Error(
      `Worktree missing for session '${name}' at ${worktree}.\n` +
      `Run 'git stint prune' to clean up, then start a new session.`,
    );
  }

  const newClientId = clientId || String(process.ppid);

  // Check if already bound to this client
  if (manifest.clientId === newClientId) {
    console.log(`Session '${name}' is already bound to client ${newClientId}.`);
    console.log(`\ncd "${worktree}"`);
    return;
  }

  const oldClientId = manifest.clientId;
  manifest.clientId = newClientId;
  saveManifest(manifest);

  console.log(`Session '${name}' resumed.`);
  if (oldClientId) {
    console.log(`  Client: ${oldClientId} \u2192 ${newClientId}`);
  } else {
    console.log(`  Client: ${newClientId}`);
  }
  console.log(`  Branch:   ${manifest.branch}`);
  console.log(`  Worktree: ${worktree}`);
  console.log(`  Commits:  ${manifest.changesets.length}`);
  console.log(`\ncd "${worktree}"`);
}

/**
 * Create per-process flag file allowing writes to main branch.
 * Scoped to a client ID (typically Claude Code's PID), so other
 * instances remain blocked.
 *
 * @param clientId - Explicit client ID. If not provided, falls back to process.ppid.
 */
export function allowMain(clientId?: string): void {
  if (!git.isInsideGitRepo()) {
    throw new Error("Not inside a git repository.");
  }
  const id = clientId || String(process.ppid);
  const flagPath = getAllowMainPath(Number(id));
  writeFileSync(flagPath, new Date().toISOString() + "\n");
  console.log(`Main branch writes allowed for this session (client ${id}).`);
}
