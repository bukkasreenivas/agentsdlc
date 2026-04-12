#!/usr/bin/env node
// .agentsdlc/scripts/remove.js
// Cleanly removes AgentSDLC from any host project.
// Run: node .agentsdlc/scripts/remove.js  (from host project root)

const fs   = require("fs");
const path = require("path");

const agentsdlcDir = path.resolve(__dirname, "..");
const hostRoot     = path.resolve(agentsdlcDir, "..");

console.log("\n AgentSDLC Removal Tool");
console.log(" Host project: " + hostRoot);
console.log();

// Remove AgentSDLC tasks from host .vscode/tasks.json if present
const vscodeTasksPath = path.join(hostRoot, ".vscode", "tasks.json");
if (fs.existsSync(vscodeTasksPath)) {
  try {
    const tasks = JSON.parse(fs.readFileSync(vscodeTasksPath, "utf8"));
    const before = tasks.tasks ? tasks.tasks.length : 0;
    if (tasks.tasks) tasks.tasks = tasks.tasks.filter(t => !String(t.label).startsWith("AgentSDLC"));
    if ((tasks.tasks ? tasks.tasks.length : 0) < before) {
      fs.writeFileSync(vscodeTasksPath, JSON.stringify(tasks, null, 2));
      console.log(" ok Removed AgentSDLC tasks from .vscode/tasks.json");
    }
  } catch(e) {}
}

// Clean .agentsdlc lines from host .gitignore
const gitignorePath = path.join(hostRoot, ".gitignore");
if (fs.existsSync(gitignorePath)) {
  const lines   = fs.readFileSync(gitignorePath, "utf8").split("\n");
  const cleaned = lines.filter(l => !l.includes(".agentsdlc/node_modules") && !l.includes(".agentsdlc/qa-videos") && !l.includes(".agentsdlc/backups") && !l.includes("# AgentSDLC")).join("\n");
  if (cleaned !== lines.join("\n")) {
    fs.writeFileSync(gitignorePath, cleaned);
    console.log(" ok Cleaned .gitignore");
  }
}

// Delete .agentsdlc/
console.log(" Deleting " + agentsdlcDir + " ...");
fs.rmSync(agentsdlcDir, { recursive: true, force: true });
console.log(" ok .agentsdlc/ removed completely");
console.log(" AgentSDLC uninstalled. Host project untouched.\n");
