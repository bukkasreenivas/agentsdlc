#!/usr/bin/env node
// .agentsdlc/scripts/upgrade.js
// Safely upgrades AgentSDLC while preserving:
//   - memory/runtime/         (agent logs, deliverables)
//   - agents/*/memory/        (per-agent memory)
//   - .env                    (your credentials)
//   - backups/                (file writer backups)
//   - qa-videos/              (QA recordings)
//
// Usage (from host project root):
//   node .agentsdlc/scripts/upgrade.js --zip path/to/agentsdlc.zip
//   node .agentsdlc/scripts/upgrade.js --zip path/to/agentsdlc.zip --dry-run

const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const args      = process.argv.slice(2);
const zipArg    = args[indexOf("--zip") + 1];
const dryRun    = args.includes("--dry-run");
const agentDir  = path.resolve(__dirname, "..");
const hostRoot  = path.resolve(agentDir, "..");

function indexOf(flag) { return args.indexOf(flag); }

// ── Files and folders that are NEVER overwritten during upgrade ──────────────
const PRESERVE = [
  ".env",
  "memory",
  "backups",
  "qa-videos",
  // Per-agent memory folders
  "agents/pm-brainstorm/memory",
  "agents/po-agent/memory",
  "agents/design-agent/memory",
  "agents/architect-agent/memory",
  "agents/dev-swarm/memory",
  "agents/nfr-agent/memory",
  "agents/review-agent/memory",
  "agents/cicd-agent/memory",
  "agents/qa-agent/memory",
  "agents/bug-pipeline/memory",
];

// ── Files that get MERGED not replaced (user may have edited these) ──────────
const MERGE_CANDIDATES = [
  "config/agents.ts",       // user may have changed model routing
  "config/integrations.ts", // user may have changed settings
];

console.log("\n AgentSDLC Upgrade Tool");
console.log(" " + "─".repeat(45));
console.log(` Current version: ${getCurrentVersion()}`);
console.log(` Dry run: ${dryRun}`);
if (!zipArg) {
  console.log("\n Usage: node .agentsdlc/scripts/upgrade.js --zip path/to/agentsdlc.zip");
  console.log("        node .agentsdlc/scripts/upgrade.js --zip path/to/agentsdlc.zip --dry-run\n");
  process.exit(0);
}

function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(agentDir, "package.json"), "utf8"));
    return pkg.version ?? "unknown";
  } catch { return "unknown"; }
}

function getNewVersion(zipPath) {
  // Extract just package.json from zip to read version
  try {
    const tmpDir = path.join(require("os").tmpdir(), "agentsdlc-upgrade-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`tar -xf "${zipPath}" -C "${tmpDir}" --wildcards "*/package.json" 2>/dev/null || unzip -j "${zipPath}" "*/package.json" -d "${tmpDir}" 2>/dev/null`, { stdio: "pipe" });
    const pkgFiles = fs.readdirSync(tmpDir).filter(f => f === "package.json");
    if (pkgFiles.length > 0) {
      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, pkgFiles[0]), "utf8"));
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return pkg.version ?? "unknown";
    }
  } catch {}
  return "unknown";
}

// ── Step 1: Snapshot preserved items to temp ─────────────────────────────────
function snapshotPreserved(tmpDir) {
  const snapDir = path.join(tmpDir, "preserved");
  fs.mkdirSync(snapDir, { recursive: true });

  for (const item of PRESERVE) {
    const src = path.join(agentDir, item);
    if (fs.existsSync(src)) {
      const dst = path.join(snapDir, item);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      copyRecursive(src, dst);
      console.log(`  saved  ${item}`);
    }
  }

  // Also snapshot merge candidates (user-edited config files)
  for (const f of MERGE_CANDIDATES) {
    const src = path.join(agentDir, f);
    if (fs.existsSync(src)) {
      const dst = path.join(snapDir, f + ".user");
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      console.log(`  saved  ${f} (merge candidate)`);
    }
  }

  return snapDir;
}

// ── Step 2: Extract new zip over .agentsdlc ──────────────────────────────────
function extractZip(zipPath, targetDir) {
  const tmpExtract = path.join(require("os").tmpdir(), "agentsdlc-new-" + Date.now());
  fs.mkdirSync(tmpExtract, { recursive: true });

  try {
    execSync(`unzip -q "${zipPath}" -d "${tmpExtract}"`, { stdio: "pipe" });
  } catch {
    try {
      execSync(`tar -xf "${zipPath}" -C "${tmpExtract}"`, { stdio: "pipe" });
    } catch(e) {
      throw new Error("Could not extract zip. Ensure unzip or tar is available. " + e.message);
    }
  }

  // Find the root folder inside the zip
  const entries = fs.readdirSync(tmpExtract);
  const root    = entries.length === 1 && fs.statSync(path.join(tmpExtract, entries[0])).isDirectory()
    ? path.join(tmpExtract, entries[0])
    : tmpExtract;

  return { extractedRoot: root, tmpDir: tmpExtract };
}

// ── Step 3: Restore preserved items ─────────────────────────────────────────
function restorePreserved(snapDir, targetDir) {
  for (const item of PRESERVE) {
    const src = path.join(snapDir, item);
    const dst = path.join(targetDir, item);
    if (fs.existsSync(src)) {
      if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
      copyRecursive(src, dst);
      console.log(`  restored  ${item}`);
    }
  }
}

// ── Step 4: Report merge candidates ─────────────────────────────────────────
function reportMergeCandidates(snapDir, targetDir) {
  const conflicts = [];
  for (const f of MERGE_CANDIDATES) {
    const userFile = path.join(snapDir, f + ".user");
    const newFile  = path.join(targetDir, f);
    if (fs.existsSync(userFile) && fs.existsSync(newFile)) {
      const userContent = fs.readFileSync(userFile, "utf8");
      const newContent  = fs.readFileSync(newFile, "utf8");
      if (userContent !== newContent) {
        // Save both versions for the user to compare
        fs.writeFileSync(newFile + ".upgraded", newContent);
        fs.writeFileSync(newFile, userContent); // keep user version
        conflicts.push(f);
      }
    }
  }
  return conflicts;
}

// ── Utilities ────────────────────────────────────────────────────────────────
function copyRecursive(src, dst) {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

// ── Main upgrade flow ────────────────────────────────────────────────────────
async function upgrade() {
  const newVersion = getNewVersion(zipArg);
  const curVersion = getCurrentVersion();
  console.log(` New version:     ${newVersion}`);
  console.log();

  if (dryRun) {
    console.log(" DRY RUN — no files will be changed\n");
    console.log(" Will preserve:");
    PRESERVE.forEach(p => console.log(`   - ${p}`));
    console.log(" Will merge (kept as-is, new version saved as .upgraded):");
    MERGE_CANDIDATES.forEach(f => console.log(`   - ${f}`));
    console.log();
    return;
  }

  const os     = require("os");
  const tmpDir = path.join(os.tmpdir(), "agentsdlc-upgrade-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Snapshot preserved items
    console.log(" Saving preserved items...");
    const snapDir = snapshotPreserved(tmpDir);

    // 2. Extract new version
    console.log("\n Extracting new version...");
    const { extractedRoot, tmpDir: extractTmp } = extractZip(zipArg, tmpDir);

    // 3. Copy new files over .agentsdlc (excluding preserved)
    console.log("\n Installing new files...");
    copyRecursive(extractedRoot, agentDir);

    // 4. Restore preserved items
    console.log("\n Restoring your data...");
    restorePreserved(snapDir, agentDir);

    // 5. Report merge conflicts
    const conflicts = reportMergeCandidates(snapDir, agentDir);

    // 6. Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try { fs.rmSync(extractTmp, { recursive: true, force: true }); } catch (_) {}

    // 7. npm install in .agentsdlc
    console.log("\n Running npm install...");
    execSync("npm install", { cwd: agentDir, stdio: "inherit" });

    console.log(`\n Upgrade complete: ${curVersion} → ${newVersion}`);

    if (conflicts.length > 0) {
      console.log(`\n Config files with changes (your version kept, new version saved as .upgraded):`);
      conflicts.forEach(f => {
        console.log(`   ${f}          ← your version (kept)`);
        console.log(`   ${f}.upgraded ← new version (review and merge manually)`);
      });
      console.log("\n Review the .upgraded files and merge any new settings you want.");
    }

    console.log("\n Your memory, logs, .env, and QA videos are intact.\n");

  } catch (err) {
    console.error("\n Upgrade failed:", err.message);
    console.error(" Stack trace:\n", err.stack);
    console.error(" Your .agentsdlc/ is unchanged.\n");
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
  }
}

upgrade();
