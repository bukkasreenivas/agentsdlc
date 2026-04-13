#!/usr/bin/env node
// .agentsdlc/orchestrator/run.ts
// Run from INSIDE .agentsdlc/:  npx ts-node orchestrator/run.ts --feature "..."
// Or via npm script:             npm run pipeline:feature "..."

import * as dotenv from "dotenv";
import * as path   from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { randomUUID }      from "crypto";
import { providerSummary, getHostProjectPath } from "../config/llm-client";

const args  = process.argv.slice(2);
const get   = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
const mode  = args[0];

// Host project path — agents scan this to understand existing code
const hostPath = get("--repo") ?? getHostProjectPath();

async function runFeaturePipeline() {
  const feature  = get("--feature") ?? "New feature";
  const maxRetry = parseInt(get("--max-retries") ?? "3", 10);

  console.log("\n AgentSDLC v2  |  Self-contained in .agentsdlc/\n");
  console.log(providerSummary());
  console.log(`\n Feature:      ${feature}`);
  console.log(` Host project: ${hostPath}`);
  console.log(` Max retries:  ${maxRetry}\n`);

  // Lazy import so dotenv loads first
  const { buildGraph } = await import("../graph/pipeline");
  const graph = buildGraph();

  const initial = {
    feature_id: randomUUID(), feature_title: feature, feature_description: feature,
    repo_path: hostPath, requested_by: "cli", created_at: new Date().toISOString(),
    current_stage: "pm_brainstorm" as const, stage_history: [], kickbacks: [],
    retry_counts: {}, max_retries: maxRetry, deliverables: {}, human_approvals: {},
    jira: {}, github: {}, figma: {}, slack: {}, deployment: {}, stage_log: [], escalated: false,
  };

  const stream = await (graph as any).stream(initial, { streamMode: "values" });
  for await (const state of stream) {
    const s = state as any;
    const lastLog = s.stage_log?.[s.stage_log.length - 1];
    if (lastLog) {
      const icon = lastLog.event === "completed" ? "✓" : lastLog.event === "kicked_back" ? "↩" : lastLog.event === "human_gate" ? "⏸" : "→";
      console.log(`  ${icon} [${s.current_stage}] ${lastLog.detail}`);
    }
    const lastKB = s.kickbacks?.[s.kickbacks.length - 1];
    if (lastKB && lastKB.stage === s.current_stage) {
      console.log(`    ↩ Kickback #${lastKB.retry_count}: ${lastKB.detail}`);
      console.log(`       Fix: ${lastKB.actionable}`);
    }
    if (s.github?.pr_url && lastLog?.event === "human_gate") {
      console.log(`\n  ⏸  HUMAN GATE — merge PR to continue: ${s.github.pr_url}\n`);
    }
    if (s.current_stage === "done") {
      console.log(`\n  ✓ Pipeline complete!`);
      console.log(`    Epic:    ${s.jira?.epic_key ?? "N/A"}`);
      console.log(`    PR:      ${s.github?.pr_url ?? "N/A"}`);
      console.log(`    Staging: ${s.deployment?.staging_url ?? "N/A"}\n`);
    }
  }
}

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

async function main() {
  if (mode === "bug") await runBugCLI();
  else                await runFeaturePipeline();
}

main().catch(err => { console.error(err.message); process.exit(1); });
