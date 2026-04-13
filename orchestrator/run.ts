#!/usr/bin/env node
// .agentsdlc/orchestrator/run.ts
// Run from INSIDE .agentsdlc/:  npx ts-node orchestrator/run.ts --feature "..."
// Or via npm script:             npm run pipeline:feature "..."
// Resume after crash:            npm run pipeline:feature --resume <feature_id>

import * as dotenv from "dotenv";
import * as path   from "path";
import * as fs     from "fs";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { randomUUID }      from "crypto";
import { providerSummary, getHostProjectPath } from "../config/llm-client";
import { ensureProjectOverview }               from "../scripts/init-project";

const args  = process.argv.slice(2);
const get   = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
const has   = (flag: string) => args.includes(flag);
const mode  = args[0];

// Host project path — agents scan this to understand existing code
const hostPath = get("--repo") ?? getHostProjectPath();

// ── Checkpoint helpers ────────────────────────────────────────────────────────

const CHECKPOINT_DIR = path.resolve(__dirname, "../memory/checkpoints");

function saveCheckpoint(featureId: string, featureTitle: string): void {
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const file = path.join(CHECKPOINT_DIR, `${featureId}.json`);
  fs.writeFileSync(file, JSON.stringify({ featureId, featureTitle, startedAt: new Date().toISOString() }, null, 2));
}

function loadLatestCheckpoint(): { featureId: string; featureTitle: string } | null {
  if (!fs.existsSync(CHECKPOINT_DIR)) return null;
  const files = fs.readdirSync(CHECKPOINT_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => ({ f, mtime: fs.statSync(path.join(CHECKPOINT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, files[0].f), "utf8"));
  } catch { return null; }
}

// ── Feature pipeline ──────────────────────────────────────────────────────────

async function runFeaturePipeline() {
  const feature  = get("--feature") ?? "New feature";
  const maxRetry = parseInt(get("--max-retries") ?? "3", 10);
  const resume   = has("--resume");

  // Resolve feature_id: resume from checkpoint or start fresh
  let featureId = randomUUID();
  let resuming  = false;

  if (resume) {
    const checkpoint = loadLatestCheckpoint();
    if (checkpoint) {
      featureId = checkpoint.featureId as `${string}-${string}-${string}-${string}-${string}`;
      resuming  = true;
      console.log(`\n ↩ Resuming feature_id: ${featureId}`);
      console.log(`   Title: ${checkpoint.featureTitle}\n`);
    } else {
      console.log("\n  No checkpoint found — starting fresh.\n");
    }
  }

  console.log("\n AgentSDLC v2  |  Self-contained in .agentsdlc/\n");
  console.log(providerSummary());
  console.log(`\n Feature:      ${feature}`);
  console.log(` Host project: ${hostPath}`);
  console.log(` Max retries:  ${maxRetry}`);
  if (resuming) console.log(` Resuming:     ${featureId}`);
  console.log();

  // Auto-generate memory/project-overview.md if missing or stale (>7 days).
  // Agents read this file to understand the real product — prevents hallucination.
  try {
    await ensureProjectOverview(hostPath);
  } catch (err) {
    console.warn(`  [project:init] Skipped (${(err as Error).message}) — agents will scan codebase directly`);
  }

  // Save checkpoint so --resume can find this run's thread_id later
  saveCheckpoint(featureId, feature);

  // Lazy import so dotenv loads first
  const { buildGraph } = await import("../graph/pipeline");
  const graph = buildGraph();

  const initial = {
    feature_id: featureId, feature_title: feature, feature_description: feature,
    repo_path: hostPath, requested_by: "cli", created_at: new Date().toISOString(),
    current_stage: "pm_brainstorm" as const, stage_history: [], kickbacks: [],
    retry_counts: {}, max_retries: maxRetry, deliverables: {}, human_approvals: {},
    jira: {}, github: {}, figma: {}, slack: {}, deployment: {}, stage_log: [], escalated: false,
  };

  // thread_id ties this run to the MemorySaver checkpoint.
  // On --resume, the same thread_id lets LangGraph restore the last saved state.
  // recursionLimit: 25 is LangGraph default — too low for a 12-stage pipeline with gates.
  // Full happy path: ~16 nodes. With kickbacks/retries allow up to 100.
  const streamConfig = { streamMode: "values", configurable: { thread_id: featureId }, recursionLimit: 100 };
  const stream = await (graph as any).stream(resuming ? null : initial, streamConfig);

  let lastPrintedLogCount = 0;

  for await (const state of stream) {
    const s = state as any;

    // Only print NEW log entries added since last tick (stage_log accumulates)
    const allLogs: any[] = s.stage_log ?? [];
    const newLogs = allLogs.slice(lastPrintedLogCount);
    lastPrintedLogCount = allLogs.length;

    for (const log of newLogs) {
      const icon = log.event === "completed"   ? "✓"
                 : log.event === "kicked_back"  ? "↩"
                 : log.event === "human_gate"   ? "⏸"
                 : "→";
      console.log(`  ${icon} [${log.stage ?? s.current_stage}] ${log.detail}`);
    }

    // Kickback detail (only for the latest kickback, once)
    const allKBs: any[] = s.kickbacks ?? [];
    const lastKB  = allKBs[allKBs.length - 1];
    const lastLog = newLogs[newLogs.length - 1];
    if (lastKB && lastLog?.event === "kicked_back") {
      console.log(`       ↩ Kickback #${lastKB.retry_count}: ${lastKB.detail}`);
      console.log(`         Fix: ${lastKB.actionable}`);
    }

    // Human gate — print PR link
    if (s.github?.pr_url && lastLog?.event === "human_gate") {
      console.log(`\n  ⏸  HUMAN GATE — merge PR to continue: ${s.github.pr_url}\n`);
    }

    // Terminal states
    if (s.current_stage === "done") {
      console.log(`\n  ✓ Pipeline complete!`);
      console.log(`    Epic:    ${s.jira?.epic_key ?? "N/A"}`);
      console.log(`    PR:      ${s.github?.pr_url ?? "N/A"}`);
      console.log(`    Staging: ${s.deployment?.staging_url ?? "N/A"}\n`);
    }
    if (s.current_stage === "escalated" || s.escalated) {
      console.log(`\n  ✗ Pipeline escalated (max retries or unrecoverable error)`);
      console.log(`    Reason: ${s.escalation_reason ?? "see memory/runtime/pipeline.log.md"}`);
      console.log(`    Resume: npm run pipeline:feature --resume\n`);
    }
  }
}

// ── Bug pipeline ──────────────────────────────────────────────────────────────

async function runBugCLI() {
  const summary     = get("--summary") ?? get("--bug") ?? "Bug report";
  const description = get("--description") ?? summary;
  const severity    = (get("--severity") ?? "medium") as any;
  const jiraKey     = get("--jira");

  console.log("\n AgentSDLC v2  |  Bug Pipeline\n");
  console.log(providerSummary());
  console.log(`\n Bug:      ${summary}`);
  console.log(` Severity: ${severity}\n`);

  const { runBugPipeline } = await import("../agents/bug-pipeline/pipeline");
  const result = await runBugPipeline({ bugSummary: summary, bugDescription: description, severity, jiraBugKey: jiraKey, repoPath: hostPath });

  console.log(`\n  Bug pipeline complete.`);
  console.log(`  Bug key: ${result.bug_key ?? "N/A"}`);
  console.log(`  Fix PR:  ${result.fix_pr_url ?? "N/A"}`);
  console.log(`  Fixed:   ${result.verification?.repro_test_passed ? "YES" : "NO"}\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  if (mode === "bug") await runBugCLI();
  else                await runFeaturePipeline();
}

main().catch(err => { console.error(err.message); process.exit(1); });
