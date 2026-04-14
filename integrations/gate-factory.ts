// integrations/gate-factory.ts
// Configurable approval polling for human gates.
// Reads GATE_STRATEGY from .agentsdlc/.env and races the selected strategy
// against the always-on Web UI — whichever resolves first wins.
//
// Supported strategies:
//   web_ui          — local browser UI at http://localhost:7842 (default)
//   github_review   — polls GitHub PR review status every 30s
//   jira_transition — polls Jira issue status every 60s (stub — future use)

import { integrations }        from "../config/integrations";
import { getPRReviewStatus }   from "./github";
import { getIssueStatus }      from "./jira";
import type { StageId }        from "../types/state";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApprovalResult {
  approved: boolean;
  comment:  string;
}

/**
 * Matches the signature of webUIGate() in graph/pipeline.ts.
 * Injected to avoid a circular import (pipeline imports gate-factory,
 * gate-factory does NOT import pipeline).
 */
export type WebUIGateFn = (
  stage:      StageId,
  stageLabel: string,
  state:      any,
  summary:    string,
  detail:     unknown
) => Promise<ApprovalResult>;

// Sentinel returned by polling functions when they time out, so the caller
// can continue waiting on the already-running web UI promise.
const TIMEOUT_SENTINEL = "__timeout__";

// ── Strategy: github_review ───────────────────────────────────────────────────

async function pollGitHubReview(prNumber: number): Promise<ApprovalResult> {
  const INTERVAL_MS = 30_000;         // poll every 30 s
  const TIMEOUT_MS  = 30 * 60_000;   // give up after 30 min
  const deadline    = Date.now() + TIMEOUT_MS;

  console.log(`  [gate-factory] Polling GitHub PR #${prNumber} for review (every 30s)…`);

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, INTERVAL_MS));
    const { state, comment } = await getPRReviewStatus(prNumber);
    if (state === "APPROVED")          return { approved: true,  comment: comment || "Approved via GitHub review" };
    if (state === "CHANGES_REQUESTED") return { approved: false, comment: comment || "Changes requested via GitHub review" };
    // PENDING — keep polling
  }

  return { approved: false, comment: TIMEOUT_SENTINEL };
}

// ── Strategy: jira_transition (stub) ─────────────────────────────────────────

async function pollJiraStatus(jiraKey: string): Promise<ApprovalResult> {
  // Not yet fully implemented — architecture in place for future use.
  console.log(`  [gate-factory] jira_transition strategy is not yet implemented — falling back to web_ui`);
  console.log(`  [gate-factory] (Would poll ${jiraKey} for status: "${integrations.gate.jiraApprovedStatus}")`);

  // Resolve immediately with the timeout sentinel so Promise.race()
  // falls through to the web UI result.
  return { approved: false, comment: TIMEOUT_SENTINEL };
}

// ── Main factory function ─────────────────────────────────────────────────────

/**
 * Polls for human approval using the configured GATE_STRATEGY.
 * The Web UI is always started in parallel and acts as a fallback —
 * whichever of (external strategy, web UI) resolves first wins.
 *
 * @param params.prNumber  Required when strategy === "github_review"
 * @param params.jiraKey   Required when strategy === "jira_transition"
 * @param params.webUIGate The webUIGate function from graph/pipeline.ts (injected to avoid circular deps)
 */
export async function pollForApproval(params: {
  stage:      StageId;
  stageLabel: string;
  state:      any;
  summary:    string;
  detail:     unknown;
  prNumber?:  number;
  jiraKey?:   string;
  webUIGate:  WebUIGateFn;
}): Promise<ApprovalResult> {
  const { stage, stageLabel, state, summary, detail, prNumber, jiraKey, webUIGate } = params;
  const strategy = integrations.gate.strategy;

  // Web UI always runs — it's the fallback for every strategy.
  const webUiPromise = webUIGate(stage, stageLabel, state, summary, detail);

  if (strategy === "github_review") {
    if (prNumber == null) {
      console.warn("  [gate-factory] github_review strategy requested but no prNumber — using web_ui only");
      return webUiPromise;
    }
    const result = await Promise.race([pollGitHubReview(prNumber), webUiPromise]);
    if (result.comment === TIMEOUT_SENTINEL) {
      // GitHub polling timed out; web UI terminal fallback is already running
      return webUiPromise;
    }
    return result;
  }

  if (strategy === "jira_transition") {
    if (!jiraKey) {
      console.warn("  [gate-factory] jira_transition strategy requested but no jiraKey — using web_ui only");
      return webUiPromise;
    }
    const result = await Promise.race([pollJiraStatus(jiraKey), webUiPromise]);
    if (result.comment === TIMEOUT_SENTINEL) {
      return webUiPromise;
    }
    return result;
  }

  // Default: web_ui only
  console.log(`  [gate-factory] Strategy: web_ui`);
  return webUiPromise;
}
