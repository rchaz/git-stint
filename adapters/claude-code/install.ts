/**
 * Standalone installer script for git-stint hooks.
 * Re-exports from src/install-hooks.ts for backward compatibility.
 *
 * Usage: node install.js [--project | --user]
 */

export { install } from "../../src/install-hooks.js";

// Run directly when executed as a script
import { install } from "../../src/install-hooks.js";
const isDirectRun = process.argv[1]?.endsWith("install.js") || process.argv[1]?.endsWith("install.ts");
if (isDirectRun) {
  const scope = process.argv.includes("--user") ? "user" : "project";
  install(scope);
}
