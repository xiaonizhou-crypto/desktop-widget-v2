#!/usr/bin/env node
// Clawd Desktop Pet — Hook Installer
// Safely merges hook commands into ~/.claude/settings.json
// Does NOT overwrite existing hooks — appends to arrays

const fs = require("fs");
const path = require("path");
const os = require("os");

const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const hookScript = path.resolve(__dirname, "clawd-hook.js").replace(/\\/g, "/");

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
  "PermissionRequest",
  "Elicitation",
  "WorktreeCreate",
];

const MARKER = "clawd-hook.js";

// Read existing settings
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
} catch (err) {
  if (err.code !== "ENOENT") {
    console.error("Failed to read settings.json:", err.message);
    process.exit(1);
  }
}

if (!settings.hooks) settings.hooks = {};

let added = 0;
let skipped = 0;

for (const event of HOOK_EVENTS) {
  if (!Array.isArray(settings.hooks[event])) {
    // Preserve existing non-array config by wrapping it
    const existing = settings.hooks[event];
    settings.hooks[event] = existing && typeof existing === "object" ? [existing] : [];
  }

  // Check if our hook is already registered (search nested hooks arrays too)
  const alreadyExists = settings.hooks[event].some((entry) => {
    // Flat format: { type, command }
    if (typeof entry.command === "string" && entry.command.includes(MARKER)) return true;
    // Nested format: { matcher, hooks: [{ type, command }] }
    if (Array.isArray(entry.hooks)) {
      return entry.hooks.some((h) => typeof h.command === "string" && h.command.includes(MARKER));
    }
    return false;
  });

  if (alreadyExists) {
    skipped++;
    continue;
  }

  // Use nested format to match Claude Code's expected structure
  settings.hooks[event].push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `node "${hookScript}" ${event}`,
      },
    ],
  });
  added++;
}

// Ensure ~/.claude directory exists, then write
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

console.log(`Clawd hooks installed to ${settingsPath}`);
console.log(`  Added: ${added} hooks`);
if (skipped > 0) console.log(`  Skipped: ${skipped} (already registered)`);
console.log(`\nHook events: ${HOOK_EVENTS.join(", ")}`);
