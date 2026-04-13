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
import type { PipelineState, StageId, KickbackRecord, StageLogEntry, Deliverable } from "../types/state";
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
  // "modify" and "proceed" both advance to PO.
  // Looping pm_brainstorm without human input adds no value — the PO agent
  // and human gates handle scope refinement from here.
  return "po";
}

function routeAfterPO(state: PipelineState): string {
  const retries = state.retry_counts?.po ?? 0;
  if (retries >= state.max_retries) return "escalate";
  const approval = state.human_approvals?.po;
  if (!approval) return "po_gate";          // Human has not reviewed yet
  if (!approval.approved) return "po";      // Kick back to PO agent with reviewer comment
  return "design";
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
  return "cicd";
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
// When false, gates auto-approve so the pipeline can run end-to-end in dev mode.
function isGithubConfigured(): boolean {
  return !!(integrations.github?.token && integrations.github?.owner && integrations.github?.repo);
}

async function poGateNode(state: any): Promise<Partial<PipelineState>> {
  if (!isGithubConfigured()) {
    console.log("  [po_gate] GitHub not configured — auto-approving (dev mode)");
    logStage(state, "po", "human_gate", "Auto-approved (GitHub not configured — dev mode)");
    return {
      human_approvals: {
        ...state.human_approvals,
        po: { approved: true, comment: "Auto-approved: GitHub integration not configured" },
      },
    };
  }
  const gateInfo = await openHumanGatePR({
    stage: "po",
    title: `[GATE] PO Review — ${state.feature_title}`,
    body:  `Review Epic + User Stories in Jira.\nEpic: ${state.jira?.epic_key ?? "N/A"}\nMerge this PR to approve.`,
    deliverable: state.deliverables?.po,
    featureId:   state.feature_id,
  });
  logStage(state, "po", "human_gate", `Gate PR opened: ${gateInfo.pr_url}`);
  return { github: { ...state.github, pr_url: gateInfo.pr_url } };
}

async function designGateNode(state: any): Promise<Partial<PipelineState>> {
  if (!isGithubConfigured()) {
    console.log("  [design_gate] GitHub not configured — auto-approving (dev mode)");
    logStage(state, "design", "human_gate", "Auto-approved (GitHub not configured — dev mode)");
    return {
      human_approvals: {
        ...state.human_approvals,
        design: { approved: true, comment: "Auto-approved: GitHub integration not configured" },
      },
    };
  }
  const gateInfo = await openHumanGatePR({
    stage: "design",
    title: `[GATE] Design Review — ${state.feature_title}`,
    body:  `Review Figma wireframes.\nFigma: ${state.figma?.file_key ?? "N/A"}\nMerge this PR to approve.`,
    deliverable: state.deliverables?.design,
    featureId:   state.feature_id,
  });
  logStage(state, "design", "human_gate", `Gate PR opened: ${gateInfo.pr_url}`);
  return { github: { ...state.github, pr_url: gateInfo.pr_url } };
}

async function qaGateNode(state: any): Promise<Partial<PipelineState>> {
  if (!isGithubConfigured()) {
    console.log("  [qa_gate] GitHub not configured — auto-approving (dev mode)");
    logStage(state, "qa", "human_gate", "Auto-approved (GitHub not configured — dev mode)");
    return {
      human_approvals: {
        ...state.human_approvals,
        qa: { approved: true, comment: "Auto-approved: GitHub integration not configured" },
      },
    };
  }
  const gateInfo = await openHumanGatePR({
    stage: "qa",
    title: `[GATE] QA Video Review — ${state.feature_title}`,
    body:  `QA complete. Watch videos and approve.\nVideos: ${state.deliverables?.qa?.memory_path ?? "N/A"}\nMerge to approve.`,
    deliverable: state.deliverables?.qa,
    featureId:   state.feature_id,
  });
  logStage(state, "qa", "human_gate", `Gate PR opened: ${gateInfo.pr_url}`);
  return { github: { ...state.github, pr_url: gateInfo.pr_url } };
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
  graph.addNode("po",            wrapNode("po",            runPOAgent,            { sod_role: "maker" }));
  graph.addNode("po_gate",       poGateNode);
  graph.addNode("design",        wrapNode("design",        runDesignAgent,        { sod_role: "maker" }));
  graph.addNode("design_gate",   designGateNode);
  graph.addNode("architect",     wrapNode("architect",     runArchitectAgent,     { sod_role: "maker" }));
  graph.addNode("dev_swarm",     wrapNode("dev_swarm",     runDevSwarm,           { sod_role: "maker" }));
  graph.addNode("nfr",           wrapNode("nfr",           runNFRAgent,           { sod_role: "checker" }));
  graph.addNode("review",        wrapNode("review",        runReviewAgent,        { sod_role: "checker" }));
  graph.addNode("cicd",          wrapNode("cicd",          runCICDAgent,          { sod_role: "executor" }));
  graph.addNode("qa",            wrapNode("qa",            runQAAgent,            { sod_role: "executor" }));
  graph.addNode("qa_gate",       qaGateNode);
  graph.addNode("escalate",      escalateNode);
  graph.addNode("done",          doneNode);

  // Start
  graph.addEdge(START, "pm_brainstorm");

  // PM brainstorm: may loop (modify) or proceed (proceed) or escalate (reject/max retries)
  graph.addConditionalEdges("pm_brainstorm", routeAfterPMBrainstorm, {
    pm_brainstorm: "pm_brainstorm",
    po:            "po",
    escalate:      "escalate",
  });

  // PO → human gate → design (if approved) or END (waiting for human to merge PR)
  // The gate node itself sets human_approvals.po when auto-approving.
  // If rejected by human (approval.approved=false), routeAfterPO sends back to po for revision.
  graph.addConditionalEdges("po", routeAfterPO, {
    po:       "po",
    po_gate:  "po_gate",
    design:   "design",
    escalate: "escalate",
  });
  // Gate routes FORWARD to design (not back to po) — prevents re-running the PO agent
  graph.addConditionalEdges("po_gate", (s: any) =>
    s.human_approvals?.po?.approved ? "design" : "__end__",
    { design: "design", __end__: END }
  );

  // Design → human gate → architect (if approved) or END (waiting for human)
  graph.addConditionalEdges("design", routeAfterDesign, {
    design:      "design",
    design_gate: "design_gate",
    architect:   "architect",
    escalate:    "escalate",
  });
  graph.addConditionalEdges("design_gate", (s: any) =>
    s.human_approvals?.design?.approved ? "architect" : "__end__",
    { architect: "architect", __end__: END }
  );

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

  // Review: approve → CI/CD, changes_requested → dev_swarm kickback
  graph.addConditionalEdges("review", routeAfterReview, {
    dev_swarm: "dev_swarm",
    cicd:      "cicd",
    escalate:  "escalate",
  });

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
  graph.addConditionalEdges("qa_gate", (s: any) =>
    s.human_approvals?.qa?.approved ? "done" : "__end__",
    { done: "done", __end__: END }
  );

  // Terminals
  graph.addEdge("escalate", END);
  graph.addEdge("done",     END);

  // MemorySaver persists state between nodes within the same process.
  // Pass thread_id in stream config to resume a run after a crash.
  return graph.compile({ checkpointer: new MemorySaver() });
}
