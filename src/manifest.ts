import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getGitCommonDir, gitInDir } from "./git.js";

export interface Changeset {
  id: number;
  sha: string;
  message: string;
  files: string[];
  /** ISO 8601 timestamp */
  timestamp: string;
}

export interface SessionManifest {
  /** Schema version for forward compatibility. Current: 1. */
  version: number;
  name: string;
  /** HEAD sha when session was created (never changes). */
  startedAt: string;
  /** Advances on each commit. Used to compute diffs for the next changeset. */
  baseline: string;
  /** Git branch name, e.g. "stint/my-feature" */
  branch: string;
  /** Worktree path relative to repo root, e.g. ".stint/my-feature" */
  worktree: string;
  changesets: Changeset[];
  /** Files tracked since last commit. */
  pending: string[];
  /**
   * Opaque identifier for the client that owns this session.
   * Used by hooks to route writes to the correct worktree when multiple
   * sessions are active (e.g., two Claude Code instances). Typically the
   * PPID of the hook process, which equals the Claude Code Node.js PID.
   * Optional for backward compatibility with existing manifests.
   */
  clientId?: string;
}

const MANIFEST_VERSION = 1;

// --- Path constants ---

const BRANCH_PREFIX = "stint/";
const WORKTREE_DIR = ".stint";
const SESSIONS_DIR = "sessions";

export { BRANCH_PREFIX, WORKTREE_DIR, MANIFEST_VERSION };

export function getSessionsDir(): string {
  const gitDir = resolve(getGitCommonDir());
  const dir = join(gitDir, SESSIONS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Validate that parsed JSON has the required manifest fields.
 * Returns null if invalid, the validated manifest otherwise.
 */
function validateManifest(data: unknown): SessionManifest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.name !== "string" || !d.name) return null;
  if (typeof d.startedAt !== "string") return null;
  if (typeof d.baseline !== "string") return null;
  if (typeof d.branch !== "string") return null;
  if (typeof d.worktree !== "string") return null;
  if (!Array.isArray(d.changesets)) return null;
  if (!Array.isArray(d.pending)) return null;
  // Back-compat: manifests created before version field was added
  if (!d.version) d.version = 1;
  return d as unknown as SessionManifest;
}

export function loadManifest(name: string): SessionManifest | null {
  const file = join(getSessionsDir(), `${name}.json`);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return validateManifest(data);
  } catch {
    return null; // corrupted manifest — treat as missing
  }
}

/**
 * Atomic write: write to temp file, then rename.
 * Prevents corruption if the process is killed mid-write.
 */
export function saveManifest(manifest: SessionManifest): void {
  const dir = getSessionsDir();
  const target = join(dir, `${manifest.name}.json`);
  const tmp = join(dir, `${manifest.name}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, target);
}

export function listManifests(): SessionManifest[] {
  const dir = getSessionsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  const manifests: SessionManifest[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      const m = validateManifest(data);
      if (m) manifests.push(m);
    } catch {
      // skip corrupted manifests
    }
  }
  return manifests;
}

export function deleteManifest(name: string): void {
  const file = join(getSessionsDir(), `${name}.json`);
  if (existsSync(file)) unlinkSync(file);
  // Also clean up tmp file if it exists
  const tmp = file + ".tmp";
  if (existsSync(tmp)) unlinkSync(tmp);
}

/**
 * Resolve which session is active.
 * Priority:
 * 1. Explicit name passed via --session flag
 * 2. CWD is inside a .stint/<name>/ worktree
 * 3. Only one session exists → use it
 * 4. Error
 */
export function resolveSession(explicit?: string): SessionManifest {
  if (explicit) {
    const m = loadManifest(explicit);
    if (!m) throw new Error(`Session '${explicit}' not found.`);
    return m;
  }

  // Check if CWD is inside a stint worktree by matching against known worktree paths.
  // This avoids false positives from directories that happen to contain "/.stint/".
  const cwd = process.cwd();
  try {
    const repoRoot = getRepoRoot();
    const stintRoot = resolve(repoRoot, WORKTREE_DIR);
    if (cwd.startsWith(stintRoot + "/")) {
      const relative = cwd.slice(stintRoot.length + 1); // e.g. "my-session/src/lib"
      const name = relative.split("/")[0];
      if (name) {
        const m = loadManifest(name);
        if (m) return m;
      }
    }
  } catch { /* not in a git repo — fall through */ }

  const manifests = listManifests();

  if (manifests.length === 1) return manifests[0];
  if (manifests.length === 0) throw new Error("No active sessions. Run `git stint start <name>` to create one.");

  const names = manifests.map((m) => m.name).join(", ");
  throw new Error(
    `Multiple active sessions: ${names}.\n` +
    `Use --session <name> to specify, or cd into a worktree.\n` +
    `Run 'git stint list' to see all sessions.`,
  );
}

/**
 * Get the repo root (main worktree root, not a stint worktree).
 * Uses git's --show-toplevel from the main worktree context.
 */
export function getRepoRoot(): string {
  const commonDir = resolve(getGitCommonDir());
  // Use git to resolve the toplevel from the common dir's parent.
  // This handles submodules, bare repos, and $GIT_DIR overrides correctly.
  try {
    return gitInDir(resolve(commonDir, ".."), "rev-parse", "--show-toplevel");
  } catch {
    // Fallback: parent of .git dir (works for standard layouts)
    return resolve(commonDir, "..");
  }
}

/**
 * Get the absolute worktree path for a session.
 */
export function getWorktreePath(manifest: SessionManifest): string {
  const root = getRepoRoot();
  return resolve(root, manifest.worktree);
}

/**
 * Check if any sessions exist. Cheaper than loading all manifests.
 */
export function hasAnySessions(): boolean {
  const dir = getSessionsDir();
  return readdirSync(dir).some((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
}
