// Self-healing entry point for the timetec-bugs MCP server.
//
// Why this file exists: Claude Code launches the MCP via the `command` +
// `args` in .claude.json. If a fresh clone hasn't run `npm install` yet,
// server.js crashes at its first `import` line and Claude Code surfaces
// "MCP failed to start", forcing the user to know about the installer.
//
// This wrapper only uses `node:` built-ins (no dependencies), so it
// always loads. If node_modules is missing it runs `npm install` once,
// then hands off to server.js via dynamic import.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const nodeModules = join(here, "node_modules");

if (!existsSync(nodeModules)) {
  process.stderr.write("[timetec-bugs-mcp] node_modules missing — running `npm install` (one-time, ~30s)...\n");
  try {
    execSync("npm install --silent --no-audit --no-fund", {
      cwd: here,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (e) {
    process.stderr.write(`[timetec-bugs-mcp] npm install failed: ${e.message}\n`);
    process.stderr.write("[timetec-bugs-mcp] Ensure Node.js (with npm) is on PATH, then restart Claude Code.\n");
    process.exit(1);
  }
  process.stderr.write("[timetec-bugs-mcp] dependencies installed.\n");
}

await import("./server.js");
