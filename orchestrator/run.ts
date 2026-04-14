#!/usr/bin/env node
// .agentsdlc/orchestrator/run.ts
// Run from INSIDE .agentsdlc/:  npx ts-node orchestrator/run.ts --feature "..."
// Or via npm script:             npm run pipeline:feature "..."
// Resume after PO/Design/QA:    npm run pipeline:feature --resume

import * as dotenv from "dotenv";
import * as path   from "path";
import * as fs     from "fs";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { randomUUID }      from "crypto";
import { providerSummary } from "../config/llm-client";
import { ensureProjectOverview }               from "../scripts/init-project";
import {
  syncFromPipelineState,
  writeManifest,
  commitToGit,
}                                              from "./feature-store";
import { syncWorkspace } from "./workspace";

const args = process.argv.slice(2);
const get  = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
const has  = (flag: string) => args.includes(flag);
const modeArg = get("--mode") ?? "feature";
const mode = args[0];

const hostPath = get("--repo") ?? syncWorkspace();

// ── Persistent state helpers ──────────────────────────────────────────────────
// State is saved to disk after every node so --resume works across process
// restarts. MemorySaver is in-memory only and dies when the process exits.

const CHECKPOINT_DIR = path.resolve(__dirname, "../memory/checkpoints");

interface CheckpointMeta {
  featureId:   string;
  featureTitle: string;
  startedAt:   string;
  stage?:      string;   // last completed stage
}

function stateFile(featureId: string)    { return path.join(CHECKPOINT_DIR, `${featureId}.state.json`); }
function metaFile(featureId: string)     { return path.join(CHECKPOINT_DIR, `${featureId}.meta.json`); }

function saveState(featureId: string, state: any): void {
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  fs.writeFileSync(stateFile(featureId), JSON.stringify(state, null, 2));
}

function loadState(featureId: string): any | null {
  const f = stateFile(featureId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function saveMeta(meta: CheckpointMeta): void {
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  fs.writeFileSync(metaFile(meta.featureId), JSON.stringify(meta, null, 2));
}

function loadLatestMeta(): CheckpointMeta | null {
  if (!fs.existsSync(CHECKPOINT_DIR)) return null;
  const files = fs.readdirSync(CHECKPOINT_DIR)
    .filter(f => f.endsWith(".meta.json"))
    .map(f => ({ f, mtime: fs.statSync(path.join(CHECKPOINT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  try { return JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, files[0].f), "utf8")); }
  catch { return null; }
}

function listCheckpoints(): CheckpointMeta[] {
  if (!fs.existsSync(CHECKPOINT_DIR)) return [];
  return fs.readdirSync(CHECKPOINT_DIR)
    .filter(f => f.endsWith(".meta.json"))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

// ── Feature pipeline ──────────────────────────────────────────────────────────

async function runFeaturePipeline() {
  let feature     = get("--feature") || "";
  let description = get("--desc") || "";
  const maxRetry  = parseInt(get("--max-retries") ?? "3", 10);
  const resume    = has("--resume");

  let featureId  = randomUUID();
  let savedState: any = null;

  if (resume) {
    const { readManifest } = await import("./feature-store");
    const specificId = get("--id");
    const meta = specificId ? { featureId: specificId } : loadLatestMeta();
    
    if (meta) {
      featureId = meta.featureId as `${string}-${string}-${string}-${string}-${string}`;
      const manifest = readManifest(featureId, modeArg === "idea" ? "ideas" : "features");
      if (manifest) {
          feature = manifest.featureTitle;
          // Note: description isn't in manifest conventionally, but savedState has it
      }
      savedState = loadState(featureId);
      if (savedState) description = savedState.feature_description || description;

      const completedStages = savedState
        ? Object.keys(savedState.deliverables ?? {})
            .filter((k: string) => savedState.deliverables[k]?.validated)
        : [];

      console.log(`\n ↩  Resuming pipeline`);
      console.log(`    Feature:   ${feature}`);
      console.log(`    ID:        ${featureId}`);
      console.log(`    Completed: ${completedStages.join(", ") || "none"}`);
      console.log();
    } else {
      console.log("\n  No checkpoint found — starting fresh.\n");
    }
  }

  console.log("\n AgentSDLC v2  |  Self-contained in .agentsdlc/\n");
  console.log(providerSummary());
  console.log(`\n Feature:      ${feature}`);
  console.log(` Host project: ${hostPath}`);
  console.log(` Max retries:  ${maxRetry}`);
  console.log();

  try {
    await ensureProjectOverview(hostPath);
  } catch (err) {
    console.warn(`  [project:init] Skipped (${(err as Error).message}) — agents will scan codebase directly`);
  }

  // Save meta so --resume can find this run
  saveMeta({ featureId, featureTitle: feature, startedAt: new Date().toISOString() });

  // Initialise feature store manifest (git source of truth)
  writeManifest(featureId, {
    featureId,
    featureTitle: feature,
    startedAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    repoPath:    hostPath,
    requestedBy: "cli",
    stages:      [],
    currentStage: "pm_brainstorm",
    status:      "running",
    storeType:   modeArg === "idea" ? "ideas" : "features",
  }, modeArg === "idea" ? "ideas" : "features");

  const { buildGraph } = await import("../graph/pipeline");
  const graph = buildGraph();

  // If resuming with saved state: pass it as initial so wrapNode can skip
  // already-completed stages via the deliverable guard in pipeline.ts.
  const initial = savedState ?? {
    feature_id: featureId, feature_title: feature, feature_description: feature,
    repo_path: hostPath, requested_by: "cli", created_at: new Date().toISOString(),
    pipeline_mode: modeArg as "idea" | "feature",
    current_stage: "pm_brainstorm" as const, stage_history: [], kickbacks: [],
    retry_counts: {}, max_retries: maxRetry, deliverables: {}, human_approvals: {},
    jira: {}, github: {}, figma: {}, slack: {}, deployment: {}, stage_log: [], escalated: false,
  };

  const streamConfig = {
    streamMode:    "values",
    configurable:  { thread_id: featureId },
    recursionLimit: 100,
  };

  const stream = await (graph as any).stream(initial, streamConfig);
  let lastPrintedLogCount = 0;

  for await (const state of stream) {
    const s = state as any;

    // Save full state to disk after every node — enables --resume across restarts
    if (s.current_stage) {
      saveState(featureId, s);
      saveMeta({ featureId, featureTitle: feature, startedAt: initial.created_at, stage: s.current_stage });
      
      // Determine store type (sync to 'ideas' if in idea mode, otherwise 'features')
      const syncType = (s.pipeline_mode === "idea") ? "ideas" : "features";
      syncFromPipelineState(featureId, s, syncType);
      
      // If we just promoted to feature, also update the idea manifest to 'done' or similar 
      // or just ensure the feature store has everything. 
      // For now, syncFromPipelineState handles the target store.
    }

    // Print only NEW log entries (stage_log accumulates across nodes)
    const allLogs: any[] = s.stage_log ?? [];
    const newLogs = allLogs.slice(lastPrintedLogCount);
    lastPrintedLogCount = allLogs.length;

    for (const log of newLogs) {
      const icon = log.event === "completed"  ? "✓"
                 : log.event === "kicked_back" ? "↩"
                 : log.event === "human_gate"  ? "⏸"
                 : "→";
      console.log(`  ${icon} [${log.stage ?? s.current_stage}] ${log.detail}`);
    }

    const allKBs: any[] = s.kickbacks ?? [];
    const lastKB  = allKBs[allKBs.length - 1];
    const lastLog = newLogs[newLogs.length - 1];
    if (lastKB && lastLog?.event === "kicked_back") {
      console.log(`       ↩ Kickback #${lastKB.retry_count}: ${lastKB.detail}`);
      console.log(`         Fix: ${lastKB.actionable}`);
    }

    if (s.github?.pr_url && lastLog?.event === "human_gate") {
      console.log(`\n  ⏸  HUMAN GATE — merge PR to continue: ${s.github.pr_url}\n`);
    }

    if (s.current_stage === "done") {
      console.log(`\n  ✓ Pipeline complete!`);
      console.log(`    Epic:    ${s.jira?.epic_key ?? "N/A"}`);
      console.log(`    PR:      ${s.github?.pr_url ?? "N/A"}`);
      console.log(`    Staging: ${s.deployment?.staging_url ?? "N/A"}`);
      console.log(`    Memory:  memory/features/${featureId}/\n`);
      // Final git commit — all deliverables + approvals
      commitToGit(featureId, `pipeline complete — all stages done`);
    }

    if (s.current_stage === "escalated" || s.escalated) {
      console.log(`\n  ✗ Pipeline escalated`);
      console.log(`    Reason: ${s.escalation_reason ?? "see memory/runtime/pipeline.log.md"}`);
      console.log(`    Memory: memory/features/${featureId}/`);
      console.log(`    Resume: npm run pipeline:feature --resume\n`);
      commitToGit(featureId, `pipeline escalated — ${s.escalation_reason?.slice(0, 60) ?? "manual intervention needed"}`);
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
