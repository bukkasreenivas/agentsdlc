// ─────────────────────────────────────────────────────────────────────────────
// AgentSDLC v2 — LangGraph Graph Definition
//
// This file is the single source of truth for the pipeline topology.
// Every edge, kickback route, and human gate is declared here.
//
// Key patterns from gitagent applied:
//   - Human-in-the-loop gates open GitHub PRs (branch-based, not CLI prompts)
//   - Live memory written to agents/<n>/memory/runtime/ after each node
//   - Segregation of duties enforced via node-level SOD checks
//   - Kickback edges are first-class graph edges, not exception handlers
// ─────────────────────────────────────────────────────────────────────────────

import { StateGraph, Annotation, MemorySaver, END, START } from "@langchain/langgraph";
import * as readline from "readline";
import type { PipelineState, StageId, KickbackRecord, StageLogEntry, Deliverable } from "../types/state";
import {
  startServer,
  getPort,
}                          from "../server/index";
import {
  writePending,
  deletePending,
  readApproval,
  writeStageData,
  readManifest,
  PendingGate,
}                          from "../orchestrator/feature-store";
import { runPMBrainstormSwarm }    from "../agents/pm-brainstorm/swarm";
import { runPOAgent }              from "../agents/po-agent/agent";
import { runDesignAgent }          from "../agents/design-agent/agent";
import { runArchitectAgent }       from "../agents/architect-agent/agent";
import { runDevSwarm }             from "../agents/dev-swarm/swarm";
import { runNFRAgent }             from "../agents/nfr-agent/agent";
import { runReviewAgent }          from "../agents/review-agent/agent";
import { runCICDAgent }            from "../agents/cicd-agent/agent";
import { runQAAgent }              from "../agents/qa-agent/agent";
import { writeMemory, logStage }   from "../orchestrator/memory";
import { validateDeliverable }     from "../orchestrator/validator";
import { openHumanGatePR }         from "../orchestrator/human-gate";
import { sodCheck }                from "../orchestrator/sod";
import { integrations }            from "../config/integrations";

// ── Node wrappers ─────────────────────────────────────────────────────────────

type NodeFn = (state: any) => Promise<Partial<PipelineState>>;

function wrapNode(
  stageId: StageId,
  runFn: (state: PipelineState) => Promise<Partial<PipelineState>>,
  options: { sod_role?: "maker" | "checker" | "executor" } = {}
): NodeFn {
  return async (state: any): Promise<Partial<PipelineState>> => {
    const logEntries: StageLogEntry[] = [];

    // ── Resume guard ─────────────────────────────────────────────────────────
    // If this stage already has a validated deliverable (loaded from disk on
    // --resume), skip the LLM call entirely and continue from where we left off.
    const existing = state.deliverables?.[stageId];
    if (existing?.validated) {
      logEntries.push(logStage(state, stageId, "completed",
        `Skipped — already completed (v${existing.version}, resuming from checkpoint)`));
      return { stage_log: logEntries };
    }

    // SOD check before execution
    if (options.sod_role) {
      const sodResult = sodCheck(stageId, options.sod_role, state);
      if (!sodResult.ok) {
        throw new Error(`SOD violation at ${stageId}: ${sodResult.reason}`);
      }
    }

    logEntries.push(logStage(state, stageId, "started", `${stageId} agent running`));

    const updates = await runFn(state);

    // Validate deliverable if produced
    const deliverable = updates.deliverables?.[stageId];
    if (deliverable) {
      const validation = await validateDeliverable(stageId, deliverable);
      deliverable.validated = validation.valid;
      if (!validation.valid) {
        // Write failed deliverable to memory for audit
        await writeMemory(stageId, state.feature_id, deliverable, "failed");
        logEntries.push(logStage(state, stageId, "kicked_back", validation.detail));
        return {
          ...updates,
          stage_log: logEntries,
          kickbacks: [
            {
              stage: stageId,
              reason: validation.kickback_reason!,
              detail: validation.detail,
              retry_count: (state.retry_counts?.[stageId] ?? 0) + 1,
              timestamp: new Date().toISOString(),
              actionable: validation.actionable,
            },
          ],
          retry_counts: {
            ...state.retry_counts,
            [stageId]: (state.retry_counts?.[stageId] ?? 0) + 1,
          },
        };
      }
      // Write validated deliverable to memory
      await writeMemory(stageId, state.feature_id, deliverable, "success");
      logEntries.push(logStage(state, stageId, "completed", `Deliverable v${deliverable.version} validated`));
    } else {
      logEntries.push(logStage(state, stageId, "completed", `${stageId} completed (no deliverable)`));
    }

    return { ...updates, stage_log: logEntries };
  };
}

// ── Conditional edge routing ──────────────────────────────────────────────────

function routeAfterPMBrainstorm(state: PipelineState): string {
  const d = state.deliverables?.pm_brainstorm?.content as any;
  if (!d) return "escalate";
  if (d.consensus?.build_decision === "reject") return "escalate";  // PM hard-rejects
  
  if (state.pipeline_mode === "idea") return "pm_promote_gate";
  return "po";
}

function routeAfterPO(state: PipelineState): string {
  const retries = state.retry_counts?.po ?? 0;
  if (retries >= state.max_retries) return "escalate";
  const approval = state.human_approvals?.po;
  // Always route through the gate — the gate shows the stories and prompts the human.
  // po_gate conditional edge handles: approved→design, rejected→po (revision), no decision→END.
  if (approval?.approved) return "design";  // already approved (safety path)
  return "po_gate";
}

function routeAfterDesign(state: PipelineState): string {
  const retries = state.retry_counts?.design ?? 0;
  if (retries >= state.max_retries) return "escalate";
  const approval = state.human_approvals?.design;
  if (!approval) return "design_gate";
  if (!approval.approved) return "design";
  return "architect";
}

function routeAfterDevSwarm(state: PipelineState): string {
  // NFR runs in parallel — check its result before proceeding to review
  const nfrDeliverable = state.deliverables?.nfr?.content as any;
  if (!nfrDeliverable) return "nfr";        // NFR not yet run
  if (nfrDeliverable.overall_status === "fail") {
    const retries = state.retry_counts?.dev_swarm ?? 0;
    if (retries >= state.max_retries) return "escalate";
    return "dev_swarm";                     // Kick back to dev swarm with NFR report
  }
  return "review";
}

function routeAfterReview(state: PipelineState): string {
  const retries = state.retry_counts?.review ?? 0;
  if (retries >= state.max_retries) return "escalate";
  const d = state.deliverables?.review?.content as any;
  if (!d) return "escalate";
  if (d.decision === "changes_requested") return "dev_swarm"; // Kick back to dev with comments
  return "code_pr_gate";
}

function routeAfterCICD(state: PipelineState): string {
  const retries = state.retry_counts?.cicd ?? 0;
  if (retries >= state.max_retries) return "escalate";
  const status = state.deployment?.deploy_status;
  if (status === "success") return "qa";
  if (status === "failed")  return "dev_swarm"; // Build red — kick back to dev
  // Any other value (undefined, "running", etc.) is treated as failure to avoid infinite loop
  return "escalate";
}

function routeAfterQA(state: PipelineState): string {
  const retries = state.retry_counts?.qa ?? 0;
  if (retries >= state.max_retries) return "escalate";
  const d = state.deliverables?.qa?.content as any;
  if (!d) return "escalate";
  const approval = state.human_approvals?.qa;
  if (!approval) return "qa_gate";             // QA team reviewing videos
  if (!approval.approved) {
    if (d.pass_rate < 0.8) return "dev_swarm"; // Major failures — back to dev
    return "qa";                               // Minor failures — re-run QA
  }
  return "done";
}

// ── Human gate nodes (open a GitHub PR branch, wait for approval) ─────────────

// Returns true when all three GitHub fields are set (token, owner, repo).
function isGithubConfigured(): boolean {
  return !!(integrations.github?.token && integrations.github?.owner && integrations.github?.repo);
}

// ── Terminal approval prompt ──────────────────────────────────────────────────
// Pauses the pipeline and asks a human to approve or provide revision feedback.
// Press Enter / Y → approved.  Type feedback → rejected with that as guidance.

function askTerminalApproval(prompt: string): Promise<{ approved: boolean; comment: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      const lower   = trimmed.toLowerCase();
      if (!trimmed || lower === "y" || lower === "yes") {
        resolve({ approved: true,  comment: "Approved" });
      } else if (lower === "n" || lower === "no") {
        resolve({ approved: false, comment: "Rejected — please provide feedback on what to change" });
      } else {
        // Any other text is treated as rejection feedback for the agent
        resolve({ approved: false, comment: trimmed });
      }
    });
  });
}

// ── Web UI gate ───────────────────────────────────────────────────────────────
// Writes a pending gate file, starts the HTTP server (idempotent), prints the
// URL and then polls every 2 s for a human approval written by the UI.
// Falls back to terminal if the server cannot start.

const GATE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

async function webUIGate(
  stage:      StageId,
  stageLabel: string,
  state:      any,
  summary:    string,
  detail:     unknown
): Promise<{ approved: boolean; comment: string }> {
  // Write stage data so UI can render it even if it was written before
  writeStageData(state.feature_id, stage, state.deliverables?.[stage] ?? detail);

  const pending: PendingGate = {
    featureId:    state.feature_id,
    featureTitle: state.feature_title ?? state.feature_id,
    stage,
    stageLabel,
    summary,
    detail,
    createdAt:  new Date().toISOString(),
    timeoutAt:  new Date(Date.now() + GATE_TIMEOUT_MS).toISOString(),
  };

  writePending(state.feature_id, stage, pending);

  let port: number;
  try {
    port = await startServer();
  } catch {
    // Server start failed — fall back to terminal
    deletePending(state.feature_id, stage);
    return askTerminalApproval(
      `  ▶  [${stageLabel}] Approve and continue?  [Enter/Y = approve  |  type feedback = revise]: `
    );
  }

  console.log(`\n  🌐 Open browser to review and approve:`);
  console.log(`     http://localhost:${port}\n`);
  console.log(`     Waiting for ${stageLabel} approval… (30-min timeout)\n`);

  // Poll every 2 s
  const deadline = Date.now() + GATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const rec = readApproval(state.feature_id, stage);
    if (rec) {
      deletePending(state.feature_id, stage);
      return { approved: rec.approved, comment: rec.comment };
    }
  }

// Timeout — fall back to terminal
  deletePending(state.feature_id, stage);
  console.log("  [gate] 30-min timeout — falling back to terminal prompt");
  return askTerminalApproval(
    `  ▶  [${stageLabel}] Approve and continue?  [Enter/Y = approve  |  type feedback = revise]: `
  );
}

async function pmPromoteGateNode(state: any): Promise<Partial<PipelineState>> {
  if (state.human_approvals?.pm_promote?.approved === true) {
    console.log("  [pm_promote_gate] Already approved — skipping gate (resuming from checkpoint)");
    return {};
  }
  const pmContent = state.deliverables?.pm_brainstorm?.content as any;
  const retries   = state.retry_counts?.pm_promote ?? 0;

  console.log("\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ⏸  PM PROMOTE GATE — Review PRD before Jira Handoff");
  console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const { approved, comment } = await webUIGate(
    "pm_promote", "PM Idea Promotion", state, "Review AI PRD & Synthesized Idea", pmContent ?? {}
  );
  logStage(state, "pm_promote", "human_gate", approved ? "Promoted to PO" : `Rejected: ${comment}`);

  if (approved) {
    console.log("\n  ✓ Approved — promoting to PO / Jira\n");
    return { 
      pipeline_mode: "feature", // Switch mode from idea to execution
      human_approvals: { ...state.human_approvals, pm_promote: { approved: true, comment } } 
    };
  }

  console.log(`\n  ↩ Sending back to PM agent with feedback: "${comment}"\n`);
  return {
    human_approvals: { ...state.human_approvals, pm_promote: { approved: false, comment } },
    kickbacks: [{
      stage:       "pm_brainstorm" as StageId,
      reason:      "pm_fit_rejected" as KickbackRecord["reason"],
      detail:      comment,
      retry_count: retries + 1,
      timestamp:   new Date().toISOString(),
      actionable:  comment,
    }],
    retry_counts: { ...state.retry_counts, pm_promote: retries + 1 },
  };
}

async function poGateNode(state: any): Promise<Partial<PipelineState>> {
  // Already approved (loaded from saved state on --resume) — skip prompt
  if (state.human_approvals?.po?.approved === true) {
    console.log("  [po_gate] Already approved — skipping gate (resuming from checkpoint)");
    return {};
  }

  const poContent = state.deliverables?.po?.content as any;
  const epicKey   = state.jira?.epic_key  as string | undefined;
  const storyKeys = (state.jira?.story_keys ?? []) as string[];
  const jiraBase  = integrations.jira?.baseUrl;
  const retries   = state.retry_counts?.po ?? 0;

  console.log("\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ⏸  PO GATE — Review stories before proceeding");
  console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (epicKey && jiraBase && !jiraBase.includes("your-domain")) {
    console.log(`  Epic:    ${epicKey}  →  ${jiraBase}/browse/${epicKey}`);
    if (storyKeys.length) console.log(`  Stories: ${storyKeys.join(", ")}`);
  } else if (poContent?.user_stories?.length) {
    console.log(`  Epic:    ${poContent.epic_summary ?? "N/A"}`);
    console.log(`  Stories (${poContent.user_stories.length}):`);
    (poContent.user_stories as any[]).slice(0, 6).forEach((s: any, i: number) =>
      console.log(`    ${i + 1}. ${s.summary}`)
    );
  }
  console.log();

  if (isGithubConfigured()) {
    const gateInfo = await openHumanGatePR({
      stage: "po", title: `[GATE] PO Review — ${state.feature_title}`,
      body: `Review Epic + Stories.\nEpic: ${epicKey ?? "N/A"}\nMerge to approve.`,
      deliverable: state.deliverables?.po, featureId: state.feature_id,
    });
    logStage(state, "po", "human_gate", `Gate PR opened: ${gateInfo.pr_url}`);
    console.log(`  PR opened: ${gateInfo.pr_url}`);
    console.log(`  Merge the PR to approve, then resume: npm run pipeline:feature --resume\n`);
    return { github: { ...state.github, pr_url: gateInfo.pr_url } };
  }

  const poSummary = poContent?.user_stories?.length
    ? `${poContent.user_stories.length} stories for Epic ${poContent.epic_key ?? epicKey ?? 'N/A'}`
    : `Epic ${epicKey ?? 'N/A'} — review in Jira`;

  const { approved, comment } = await webUIGate(
    "po", "PO Story Review", state, poSummary, poContent ?? {}
  );
  logStage(state, "po", "human_gate", approved ? "PO approved" : `PO rejected: ${comment}`);

  if (approved) {
    console.log("\n  ✓ Approved — proceeding to Design\n");
    return { human_approvals: { ...state.human_approvals, po: { approved: true, comment } } };
  }

  console.log(`\n  ↩ Sending back to PO agent with feedback: "${comment}"\n`);
  return {
    human_approvals: { ...state.human_approvals, po: { approved: false, comment } },
    kickbacks: [{
      stage:       "po" as StageId,
      reason:      "po_stories_rejected" as KickbackRecord["reason"],
      detail:      comment,
      retry_count: retries + 1,
      timestamp:   new Date().toISOString(),
      actionable:  comment,
    }],
    retry_counts: { ...state.retry_counts, po: retries + 1 },
  };
}

async function designGateNode(state: any): Promise<Partial<PipelineState>> {
  if (state.human_approvals?.design?.approved === true) {
    console.log("  [design_gate] Already approved — skipping gate (resuming from checkpoint)");
    return {};
  }

  const designContent = state.deliverables?.design?.content as any;
  const retries = state.retry_counts?.design ?? 0;

  console.log("\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ⏸  DESIGN GATE — Review designs before proceeding");
  console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (state.figma?.file_key) console.log(`  Figma: ${state.figma.file_key}`);
  if (designContent?.summary) console.log(`  Summary: ${designContent.summary}`);
  console.log();

  if (isGithubConfigured()) {
    const gateInfo = await openHumanGatePR({
      stage: "design", title: `[GATE] Design Review — ${state.feature_title}`,
      body: `Review Figma wireframes.\nFigma: ${state.figma?.file_key ?? "N/A"}\nMerge to approve.`,
      deliverable: state.deliverables?.design, featureId: state.feature_id,
    });
    logStage(state, "design", "human_gate", `Gate PR opened: ${gateInfo.pr_url}`);
    console.log(`  PR opened: ${gateInfo.pr_url}`);
    console.log(`  Merge to approve, then resume: npm run pipeline:feature --resume\n`);
    return { github: { ...state.github, pr_url: gateInfo.pr_url } };
  }

  const designSummary = state.figma?.file_key
    ? `Figma wireframes ready: ${state.figma.file_key}`
    : designContent?.summary ?? "Design output ready for review";

  const { approved, comment } = await webUIGate(
    "design", "Design Review", state, designSummary, designContent ?? {}
  );
  logStage(state, "design", "human_gate", approved ? "Design approved" : `Design rejected: ${comment}`);

  if (approved) {
    console.log("\n  ✓ Approved — proceeding to Architecture\n");
    return { human_approvals: { ...state.human_approvals, design: { approved: true, comment } } };
  }

  console.log(`\n  ↩ Sending back to Design agent with feedback: "${comment}"\n`);
  return {
    human_approvals: { ...state.human_approvals, design: { approved: false, comment } },
    kickbacks: [{
      stage: "design" as StageId, reason: "design_rejected" as KickbackRecord["reason"],
      detail: comment, retry_count: retries + 1,
      timestamp: new Date().toISOString(), actionable: comment,
    }],
    retry_counts: { ...state.retry_counts, design: retries + 1 },
  };
}

async function codePrGateNode(state: any): Promise<Partial<PipelineState>> {
  if (state.human_approvals?.code_pr?.approved === true) {
    console.log("  [code_pr_gate] Already approved — skipping gate");
    return {};
  }

  const reviewContent = state.deliverables?.review?.content as any;
  const retries = state.retry_counts?.code_pr ?? 0;

  console.log("\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ⏸  CODE PR GATE — Requires manual PR merge approval");
  console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const prUrl = state.github?.pr_url ?? "Review codebase before CI/CD";

  const { approved, comment } = await webUIGate(
    "code_pr", "Code PR Review", state, "Approve the Code PR before CI/CD deployment", { prUrl, comments: reviewContent?.comments }
  );

  logStage(state, "code_pr", "human_gate", approved ? "PR Approved" : `PR Rejected: ${comment}`);

  if (approved) {
    console.log("\n  ✓ PR Approved — proceeding to CI/CD Deployment\n");
    return { human_approvals: { ...state.human_approvals, code_pr: { approved: true, comment } } };
  }

  console.log(`\n  ↩ Returning to dev_swarm to address PR feedback: "${comment}"\n`);
  return {
    human_approvals: { ...state.human_approvals, code_pr: { approved: false, comment } },
    kickbacks: [{
      stage: "dev_swarm" as StageId, reason: "review_changes_req" as KickbackRecord["reason"],
      detail: comment, retry_count: retries + 1,
      timestamp: new Date().toISOString(), actionable: comment,
    }],
    retry_counts: { ...state.retry_counts, code_pr: retries + 1 },
  };
}

async function qaGateNode(state: any): Promise<Partial<PipelineState>> {
  if (state.human_approvals?.qa?.approved === true) {
    console.log("  [qa_gate] Already approved — skipping gate (resuming from checkpoint)");
    return {};
  }

  const qaContent = state.deliverables?.qa?.content as any;
  const retries   = state.retry_counts?.qa ?? 0;

  console.log("\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ⏸  QA GATE — Review test results before shipping");
  console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (qaContent) {
    const passRate = qaContent.pass_rate != null ? `${Math.round(qaContent.pass_rate * 100)}%` : "N/A";
    console.log(`  Pass rate: ${passRate}`);
    if (qaContent.failed_scenarios?.length) console.log(`  Failures:  ${qaContent.failed_scenarios.join(", ")}`);
    if (state.deliverables?.qa?.memory_path) console.log(`  Videos:    ${state.deliverables.qa.memory_path}`);
  }
  console.log();

  if (isGithubConfigured()) {
    const gateInfo = await openHumanGatePR({
      stage: "qa", title: `[GATE] QA Review — ${state.feature_title}`,
      body: `QA complete. Review results and merge to approve.\nVideos: ${state.deliverables?.qa?.memory_path ?? "N/A"}`,
      deliverable: state.deliverables?.qa, featureId: state.feature_id,
    });
    logStage(state, "qa", "human_gate", `Gate PR opened: ${gateInfo.pr_url}`);
    console.log(`  PR opened: ${gateInfo.pr_url}`);
    console.log(`  Merge to approve, then resume: npm run pipeline:feature --resume\n`);
    return { github: { ...state.github, pr_url: gateInfo.pr_url } };
  }

  const passRate  = qaContent?.pass_rate != null ? `${Math.round(qaContent.pass_rate * 100)}%` : "N/A";
  const qaSummary = `QA pass rate: ${passRate} | ${qaContent?.passed ?? 0} passed, ${qaContent?.failed ?? 0} failed`;

  const { approved, comment } = await webUIGate(
    "qa", "QA Review", state, qaSummary, qaContent ?? {}
  );
  logStage(state, "qa", "human_gate", approved ? "QA approved" : `QA rejected: ${comment}`);

  if (approved) {
    console.log("\n  ✓ Approved — pipeline complete\n");
    return { human_approvals: { ...state.human_approvals, qa: { approved: true, comment } } };
  }

  console.log(`\n  ↩ Sending back to QA/Dev with feedback: "${comment}"\n`);
  return {
    human_approvals: { ...state.human_approvals, qa: { approved: false, comment } },
    kickbacks: [{
      stage: "qa" as StageId, reason: "qa_tests_failed" as KickbackRecord["reason"],
      detail: comment, retry_count: retries + 1,
      timestamp: new Date().toISOString(), actionable: comment,
    }],
    retry_counts: { ...state.retry_counts, qa: retries + 1 },
  };
}

async function escalateNode(state: any): Promise<Partial<PipelineState>> {
  const lastKickback = (state.kickbacks ?? [])[state.kickbacks?.length - 1];
  const lastLog      = (state.stage_log  ?? [])[state.stage_log?.length  - 1];

  let reason = "Escalated — check memory/runtime/pipeline.log.md for details";
  if (lastKickback) {
    reason = `Max retries at ${lastKickback.stage}: ${lastKickback.detail} | Fix: ${lastKickback.actionable}`;
  } else if (lastLog) {
    const pmDecision = (state.deliverables?.pm_brainstorm?.content as any)?.consensus?.build_decision;
    if (pmDecision === "reject") {
      reason = `PM brainstorm rejected feature: ${(state.deliverables?.pm_brainstorm?.content as any)?.consensus?.agreed_scope ?? "see pm-brainstorm deliverable"}`;
    } else {
      reason = `Escalated from ${lastLog.stage} (${lastLog.event}): ${lastLog.detail}`;
    }
  }

  return {
    escalated: true,
    escalation_reason: reason,
    current_stage: "escalated",
  };
}

async function doneNode(state: any): Promise<Partial<PipelineState>> {
  logStage(state, "done", "completed", "Pipeline complete — all stages passed");
  return { current_stage: "done" };
}

// ── Graph assembly ────────────────────────────────────────────────────────────

// LangGraph v0.2+ — every Annotation field requires a `value` binary operator.
// Simple fields use last-write-wins: (_, b) => b
// Accumulator fields merge arrays.
const PipelineAnnotation = Annotation.Root({
  feature_id:          Annotation<string>({ value: (_, b) => b, default: () => "" }),
  feature_title:       Annotation<string>({ value: (_, b) => b, default: () => "" }),
  feature_description: Annotation<string>({ value: (_, b) => b, default: () => "" }),
  repo_path:           Annotation<string>({ value: (_, b) => b, default: () => "" }),
  requested_by:        Annotation<string>({ value: (_, b) => b, default: () => "" }),
  created_at:          Annotation<string>({ value: (_, b) => b, default: () => new Date().toISOString() }),
  pipeline_mode:       Annotation<"idea" | "feature">({ value: (_, b) => b, default: () => "feature" }),
  current_stage:       Annotation<StageId>({ value: (_, b) => b, default: () => "pm_brainstorm" as StageId }),
  next_stage:          Annotation<StageId | null>({ value: (_, b) => b, default: () => null }),
  stage_history:       Annotation<StageId[]>({
    value: (a: StageId[], b: StageId[]) => [...a, ...b],
    default: () => [],
  }),
  kickbacks:           Annotation<KickbackRecord[]>({
    value: (a: KickbackRecord[], b: KickbackRecord[]) => [...a, ...b],
    default: () => [],
  }),
  retry_counts:        Annotation<Partial<Record<StageId, number>>>({ value: (_, b) => b, default: () => ({}) }),
  max_retries:         Annotation<number>({ value: (_, b) => b, default: () => 3 }),
  deliverables:        Annotation<Partial<Record<StageId, Deliverable>>>({ value: (_, b) => b, default: () => ({}) }),
  human_approvals:     Annotation<PipelineState["human_approvals"]>({ value: (_, b) => b, default: () => ({}) }),
  jira:                Annotation<PipelineState["jira"]>({ value: (_, b) => b, default: () => ({}) }),
  github:              Annotation<PipelineState["github"]>({ value: (_, b) => b, default: () => ({}) }),
  figma:               Annotation<PipelineState["figma"]>({ value: (_, b) => b, default: () => ({}) }),
  slack:               Annotation<PipelineState["slack"]>({ value: (_, b) => b, default: () => ({}) }),
  deployment:          Annotation<PipelineState["deployment"]>({ value: (_, b) => b, default: () => ({}) }),
  stage_log:           Annotation<StageLogEntry[]>({
    value: (a: StageLogEntry[], b: StageLogEntry[]) => [...a, ...b],
    default: () => [],
  }),
  escalated:           Annotation<boolean>({ value: (_, b) => b, default: () => false }),
  escalation_reason:   Annotation<string | undefined>({ value: (_, b) => b, default: () => undefined }),
});

export function buildGraph() {
  // Cast to any: addNode() returns a new typed graph but we use a mutable ref,
  // so TypeScript loses track of registered node names. The logic is correct.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graph = new StateGraph(PipelineAnnotation) as any;

  // Add nodes
  graph.addNode("pm_brainstorm", wrapNode("pm_brainstorm", runPMBrainstormSwarm, { sod_role: "maker" }));
  graph.addNode("pm_promote_gate", pmPromoteGateNode);
  graph.addNode("po",            wrapNode("po",            runPOAgent,            { sod_role: "maker" }));
  graph.addNode("po_gate",       poGateNode);
  graph.addNode("design",        wrapNode("design",        runDesignAgent,        { sod_role: "maker" }));
  graph.addNode("design_gate",   designGateNode);
  graph.addNode("architect",     wrapNode("architect",     runArchitectAgent,     { sod_role: "maker" }));
  graph.addNode("dev_swarm",     wrapNode("dev_swarm",     runDevSwarm,           { sod_role: "maker" }));
  graph.addNode("nfr",           wrapNode("nfr",           runNFRAgent,           { sod_role: "checker" }));
  graph.addNode("review",        wrapNode("review",        runReviewAgent,        { sod_role: "checker" }));
  graph.addNode("code_pr_gate",  codePrGateNode);
  graph.addNode("cicd",          wrapNode("cicd",          runCICDAgent,          { sod_role: "executor" }));
  graph.addNode("qa",            wrapNode("qa",            runQAAgent,            { sod_role: "executor" }));
  graph.addNode("qa_gate",       qaGateNode);
  graph.addNode("escalate",      escalateNode);
  graph.addNode("done",          doneNode);

  // Start
  graph.addEdge(START, "pm_brainstorm");

  graph.addConditionalEdges("pm_brainstorm", routeAfterPMBrainstorm, {
    pm_brainstorm:   "pm_brainstorm",
    pm_promote_gate: "pm_promote_gate",
    po:              "po",
    escalate:        "escalate",
  });

  graph.addConditionalEdges("pm_promote_gate", (s: any) => {
    const a = s.human_approvals?.pm_promote;
    if (a?.approved === true)  return "po";
    if (a?.approved === false) return "pm_brainstorm";
    return "__end__";
  }, { po: "po", pm_brainstorm: "pm_brainstorm", __end__: END });

  // PO always routes to po_gate (which prompts the human).
  // Gate's conditional edge then routes: approved→design, rejected→po, no-decision→END
  graph.addConditionalEdges("po", routeAfterPO, {
    po_gate:  "po_gate",
    design:   "design",
    escalate: "escalate",
  });
  // Gate routes: approved → design, rejected → back to po for revision, no decision → END (GitHub mode)
  graph.addConditionalEdges("po_gate", (s: any) => {
    const a = s.human_approvals?.po;
    if (a?.approved === true)  return "design";
    if (a?.approved === false) return "po";     // Human rejected — revise with feedback
    return "__end__";                           // GitHub PR mode — waiting for merge
  }, { design: "design", po: "po", __end__: END });

  // Design → human gate → architect (if approved) or END (waiting for human)
  graph.addConditionalEdges("design", routeAfterDesign, {
    design:      "design",
    design_gate: "design_gate",
    architect:   "architect",
    escalate:    "escalate",
  });
  graph.addConditionalEdges("design_gate", (s: any) => {
    const a = s.human_approvals?.design;
    if (a?.approved === true)  return "architect";
    if (a?.approved === false) return "design";   // Rejected — revise
    return "__end__";
  }, { architect: "architect", design: "design", __end__: END });

  // Architect → dev swarm
  graph.addEdge("architect", "dev_swarm");

  // Dev swarm and NFR run together conceptually (NFR is triggered after dev_swarm)
  graph.addEdge("dev_swarm", "nfr");

  // NFR result gates whether we go to review or kick back to dev
  graph.addConditionalEdges("nfr", (s: any) => routeAfterDevSwarm(s as PipelineState), {
    nfr:       "nfr",
    dev_swarm: "dev_swarm",
    review:    "review",
    escalate:  "escalate",
  });

  // Review: approve → code_pr_gate, changes_requested → dev_swarm kickback
  graph.addConditionalEdges("review", routeAfterReview, {
    dev_swarm:    "dev_swarm",
    code_pr_gate: "code_pr_gate",
    escalate:     "escalate",
  });

  graph.addConditionalEdges("code_pr_gate", (s: any) => {
    const a = s.human_approvals?.code_pr;
    if (a?.approved === true)  return "cicd";
    if (a?.approved === false) return "dev_swarm";
    return "__end__";
  }, { cicd: "cicd", dev_swarm: "dev_swarm", __end__: END });

  // CI/CD: success → QA, failed → dev kickback
  graph.addConditionalEdges("cicd", routeAfterCICD, {
    cicd:      "cicd",
    dev_swarm: "dev_swarm",
    qa:        "qa",
    escalate:  "escalate",
  });

  // QA → video gate → done (if approved) or END (waiting for human)
  graph.addConditionalEdges("qa", routeAfterQA, {
    qa:        "qa",
    qa_gate:   "qa_gate",
    dev_swarm: "dev_swarm",
    done:      "done",
    escalate:  "escalate",
  });
  graph.addConditionalEdges("qa_gate", (s: any) => {
    const a = s.human_approvals?.qa;
    if (a?.approved === true)  return "done";
    if (a?.approved === false) return "dev_swarm"; // Rejected — fix and retest
    return "__end__";
  }, { done: "done", dev_swarm: "dev_swarm", __end__: END });

  // Terminals
  graph.addEdge("escalate", END);
  graph.addEdge("done",     END);

  // MemorySaver persists state between nodes within the same process.
  // Pass thread_id in stream config to resume a run after a crash.
  return graph.compile({ checkpointer: new MemorySaver() });
}
