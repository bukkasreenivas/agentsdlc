// orchestrator/gate-factory.ts
// Unified polling engine for human approval gates.
// Checks Web UI, GitHub (PR merge/approve), and Terminal simultaneously.

import { readApproval, deletePending, writePending, PendingGate, StoreType } from "./feature-store";
import { getPRStatus, getPRReviewStatus } from "../integrations/github";
import { askTerminalApproval } from "../tools/terminal-input";

export interface ApprovalResult {
  approved: boolean;
  comment:  string;
}

/**
 * Polls for approval across multiple channels.
 * First channel to respond wins.
 */
export async function pollForApproval(params: {
  featureId: string,
  stage:     string,
  summary:   string,
  detail:    any,
  mode?:     "idea" | "feature",
  prNumber?: number,
  timeoutMs?: number,
}): Promise<ApprovalResult> {
  const { featureId, stage, summary, detail, mode = "feature", prNumber, timeoutMs = 30 * 60 * 1000 } = params;
  const deadline = Date.now() + timeoutMs;
  const storeType = mode === "idea" ? "ideas" : "features";

  console.log(`  [gate] Polling for ${stage} (Store: ${storeType}, GitHub: ${prNumber || 'N/A'})...`);
  
  // Notify Web UI
  writePending(featureId, stage, {
    featureId,
    featureTitle: summary, // Use summary as title if none
    stage,
    stageLabel: stage,
    summary,
    detail,
    createdAt: new Date().toISOString(),
    timeoutAt: new Date(deadline).toISOString(),
  }, storeType);

  while (Date.now() < deadline) {
    // 1. Check Web UI Approval
    const uiRec = readApproval(featureId, stage, storeType);
    if (uiRec) {
      deletePending(featureId, stage);
      return { approved: uiRec.approved, comment: uiRec.comment };
    }

    // 2. Check GitHub PR (if applicable)
    if (prNumber) {
      try {
        const ghStatus = await getPRStatus(prNumber);
        if (ghStatus.merged) {
            console.log(`  [gate] GitHub PR #${prNumber} merged — approving.`);
            deletePending(featureId, stage, storeType);
            return { approved: true, comment: "Approved via GitHub PR merge." };
        }
        
        const ghReview = await getPRReviewStatus(prNumber);
        if (ghReview.state === "APPROVED") {
            console.log(`  [gate] GitHub PR #${prNumber} approved via review.`);
            deletePending(featureId, stage, storeType);
            return { approved: true, comment: ghReview.comment || "Approved via GitHub Review." };
        }
        if (ghReview.state === "CHANGES_REQUESTED") {
            console.log(`  [gate] GitHub PR #${prNumber} changes requested.`);
            deletePending(featureId, stage, storeType);
            return { approved: false, comment: ghReview.comment || "Rejected via GitHub Review." };
        }
      } catch (err: any) {
        // Silently retry on API errors
      }
    }

    // Wait 5 seconds before next poll
    await new Promise(r => setTimeout(r, 5000));
    
    // Check if terminal fallback should be offered (e.g. after every minute)
    // For now, we keep it simple and just poll.
  }

  // Timeout fallback to Terminal
  console.log(`\n  [gate] 30-min timeout reached — shifting to terminal prompt.`);
  deletePending(featureId, stage, storeType);
  const term = await askTerminalApproval(
    `  ▶  [Review Required: ${stage}] Approve? [Y/n, or type feedback]: `
  );
  return term;
}
