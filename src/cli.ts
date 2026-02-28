import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as session from "./session.js";
import { checkConflicts } from "./conflicts.js";
import { test, testCombine } from "./test-session.js";

const args = process.argv.slice(2);
const command = args[0];

// Known flags that take a value (used by arg parser to skip correctly)
const VALUE_FLAGS = new Set(["-m", "--session", "--title", "--combine", "--client-id"]);

function getFlag(flag: string): string | undefined {
  // Check for --flag=value syntax
  const eqPrefix = flag + "=";
  for (const arg of args) {
    if (arg.startsWith(eqPrefix)) {
      return arg.slice(eqPrefix.length);
    }
  }
  // Check for --flag value syntax
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined) {
    throw new Error(`Flag '${flag}' requires a value.`);
  }
  return value;
}

/** Check if an arg is a value flag, handling both --flag and --flag=value forms. */
function isValueFlag(arg: string): boolean {
  if (VALUE_FLAGS.has(arg)) return true;
  // --flag=value: the flag consumed its value inline, don't skip next arg
  for (const f of VALUE_FLAGS) {
    if (arg.startsWith(f + "=")) return false; // value is inline, no skip
  }
  return false;
}

function getPositional(index: number): string | undefined {
  let pos = 0;
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("-")) {
      // Only skip next arg if this flag takes a separate value (not --flag=value)
      if (isValueFlag(args[i])) i++;
      continue;
    }
    if (pos === index) return args[i];
    pos++;
  }
  return undefined;
}

function getAllPositional(): string[] {
  const result: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("-")) {
      if (isValueFlag(args[i])) i++;
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

try {
  switch (command) {
    case "start": {
      const name = getPositional(0);
      const clientId = getFlag("--client-id");
      session.start(name, clientId);
      break;
    }

    case "track": {
      const files = getAllPositional();
      if (files.length === 0) {
        console.error("Usage: git stint track <file...>");
        process.exit(1);
      }
      const sessionFlag = getFlag("--session");
      session.track(files, sessionFlag);
      break;
    }

    case "status": {
      session.status(getFlag("--session"));
      break;
    }

    case "diff": {
      session.diff(getFlag("--session"));
      break;
    }

    case "commit": {
      const message = getFlag("-m");
      if (!message) {
        console.error("Usage: git stint commit -m \"message\"");
        process.exit(1);
      }
      session.sessionCommit(message, getFlag("--session"));
      break;
    }

    case "log": {
      session.log(getFlag("--session"));
      break;
    }

    case "squash": {
      const message = getFlag("-m");
      if (!message) {
        console.error("Usage: git stint squash -m \"message\"");
        process.exit(1);
      }
      session.squash(message, getFlag("--session"));
      break;
    }

    case "merge": {
      session.merge(getFlag("--session"));
      break;
    }

    case "pr": {
      const title = getFlag("--title");
      session.pr(title, getFlag("--session"));
      break;
    }

    case "end": {
      session.end(getFlag("--session"));
      break;
    }

    case "abort": {
      session.abort(getFlag("--session"));
      break;
    }

    case "undo": {
      session.undo(getFlag("--session"));
      break;
    }

    case "conflicts": {
      checkConflicts(getFlag("--session"));
      break;
    }

    case "test": {
      const combineNames = getFlag("--combine");
      if (combineNames) {
        // Collect all names after --combine
        const idx = args.indexOf("--combine");
        const names: string[] = [];
        for (let i = idx + 1; i < args.length; i++) {
          if (args[i].startsWith("-")) break;
          names.push(args[i]);
        }
        if (names.length < 2) {
          console.error("Usage: git stint test --combine <session1> <session2> [...]");
          process.exit(1);
        }
        const dashIdx = args.indexOf("--");
        const testCmd = dashIdx >= 0 ? args.slice(dashIdx + 1).join(" ") : undefined;
        testCombine(names, testCmd);
      } else {
        const dashIdx = args.indexOf("--");
        const testCmd = dashIdx >= 0 ? args.slice(dashIdx + 1).join(" ") : undefined;
        test(getFlag("--session"), testCmd);
      }
      break;
    }

    case "list": {
      if (args.includes("--json")) {
        session.listJson();
      } else {
        session.list();
      }
      break;
    }

    case "prune": {
      session.prune();
      break;
    }

    case "allow-main": {
      session.allowMain();
      break;
    }

    case "install-hooks": {
      const { install } = await import("./install-hooks.js");
      const scope = args.includes("--user") ? "user" : "project";
      install(scope);
      break;
    }

    case "uninstall-hooks": {
      const { uninstall } = await import("./install-hooks.js");
      const scope = args.includes("--user") ? "user" : "project";
      uninstall(scope);
      break;
    }

    case "version":
    case "--version":
    case "-v": {
      printVersion();
      break;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined: {
      printHelp();
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error("Run `git stint help` for usage.");
      process.exit(1);
    }
  }
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
}

function getVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(thisDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function printVersion(): void {
  console.log(`git-stint ${getVersion()}`);
}

function printHelp(): void {
  console.log(`git-stint ${getVersion()} — Session-scoped change tracking for AI coding agents

Usage: git stint <command> [options]

Commands:
  start [name]              Create a new session (branch + worktree)
  list                      List all active sessions
  status                    Show current session state
  track <file...>           Add files to the pending list
  diff                      Show uncommitted changes
  commit -m "msg"           Commit changes, advance baseline
  log                       Show session commit history
  squash -m "msg"           Collapse all commits into one
  merge                     Merge session into main (no PR)
  pr [--title "..."]        Push branch and create GitHub PR
  end                       Finalize session, clean up everything
  abort                     Discard session — delete all changes
  undo                      Revert last commit, changes become pending
  conflicts                 Check file overlap with other sessions
  test [-- <cmd>]           Run tests in the session worktree
  test --combine A B        Test multiple sessions merged together
  prune                     Clean up orphaned worktrees/branches
  allow-main                Allow writes to main branch (until next session start)
  install-hooks [--user]    Install Claude Code hooks
  uninstall-hooks [--user]  Remove Claude Code hooks

Options:
  --session <name>          Specify session (auto-detected from CWD)
  --client-id <id>          Tag session with a client identifier (used by hooks)
  -m "message"              Commit/squash message
  --title "title"           PR title
  --version                 Show version number

Examples:
  git stint start auth-fix
  cd .stint/auth-fix/
  # make changes...
  git stint commit -m "Fix auth token refresh"
  git stint pr --title "Fix auth bug"
  git stint end`);
}
