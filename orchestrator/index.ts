// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator Utilities
// memory.ts — gitagent live memory pattern
// validator.ts — deliverable schema validation + kickback reason generation
// human-gate.ts — opens GitHub PR for human review
// sod.ts — segregation of duties enforcement
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import type { PipelineState, StageId, Deliverable, StageLogEntry, KickbackReason } from "../types/state";

// ── memory.ts ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();

export function makeDeliverable(
  stage: StageId,
  version: number,
  schema: string,
  content: unknown,
  memoryPath: string
): Deliverable {
  return {
    stage,
    version,
    schema,
    content,
    validated: false,          // validator sets this
    produced_at: new Date().toISOString(),
    memory_path: memoryPath,
  };
}

export async function writeMemory(
  stage: StageId,
  featureId: string,
  deliverable: Deliverable,
  status: "success" | "failed"
): Promise<void> {
  if (!deliverable.memory_path) return;   // no path set — feature-store handles persistence
  const filePath = path.join(PROJECT_ROOT, deliverable.memory_path);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    status,
    deliverable,
    written_at: new Date().toISOString(),
  }, null, 2));
}

export async function writeAgentMemory(
  agentId: string,
  featureId: string,
  entry: Record<string, unknown>
): Promise<void> {
  const logPath = path.join(PROJECT_ROOT, `agents/${agentId}/memory/runtime/dailylog.md`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const line = `\n## ${new Date().toISOString()} — ${featureId}\n\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\`\n`;
  fs.appendFileSync(logPath, line);
}

export function logStage(
  state: PipelineState,
  stage: StageId,
  event: StageLogEntry["event"],
  detail: string,
  deliverableVersion?: number
): StageLogEntry {
  // LangGraph accumulates stage_log via the value channel reducer.
  // IMPORTANT: callers must include the returned entry in their node's
  // return value as { stage_log: [entry] } — direct mutation of state
  // is invisible to LangGraph's immutable state tracking.
  const entry: StageLogEntry = {
    stage, event, detail, deliverable_version: deliverableVersion,
    timestamp: new Date().toISOString(),
  };
  // Mirror to disk for audit
  const logPath = path.join(PROJECT_ROOT, "memory/runtime/pipeline.log.md");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `\n[${entry.timestamp}] [${stage}] [${event}] ${detail}`);
  return entry;
}

// ── validator.ts ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  kickback_reason?: KickbackReason;
  detail: string;
  actionable: string;
}

const REQUIRED_FIELDS: Partial<Record<StageId, string[]>> = {
  pm_brainstorm: ["feature_id", "chat_history"],  // minimal — schema-aware check handles the rest
  po:            ["epic_key", "user_stories"],
  design:        ["figma_file_key", "frame_urls"],
  architect:     ["adr_content", "feature_branch", "frontend_tasks", "backend_tasks"],
  dev_swarm:     ["commits", "pr_number"],
  nfr:           ["overall_status", "items"],
  review:        ["decision", "pr_number"],
  cicd:          ["deploy_status"],
  qa:            ["test_cases", "passed", "failed", "pass_rate"],
};

const KICKBACK_REASONS: Partial<Record<StageId, KickbackReason>> = {
  pm_brainstorm: "pm_fit_rejected",
  po:            "po_stories_rejected",
  nfr:           "nfr_critical_fail",
  review:        "review_changes_req",
  cicd:          "ci_build_failed",
  qa:            "qa_tests_failed",
};

function getNestedValue(obj: any, dotPath: string): unknown {
  return dotPath.split(".").reduce((acc, key) => acc?.[key], obj);
}

export async function validateDeliverable(
  stage: StageId,
  deliverable: Deliverable
): Promise<ValidationResult> {
  const content = deliverable.content as any;
  const required = REQUIRED_FIELDS[stage] ?? [];

  for (const field of required) {
    const value = getNestedValue(content, field);
    if (value === undefined || value === null) {
      return {
        valid: false,
        kickback_reason: KICKBACK_REASONS[stage],
        detail: `Missing required field: ${field}`,
        actionable: `Ensure the ${stage} agent produces a '${field}' in its output.`,
      };
    }
  }

  // ── pm_brainstorm: schema-aware validation ───────────────────────────────────
  if (stage === "pm_brainstorm") {
    if (deliverable.schema === "PMModularBrainstormDeliverable") {
      // Chat-mode turns are always valid as long as feature_id exists
      if (!content.feature_id) {
        return { valid: false, kickback_reason: "pm_fit_rejected", detail: "Missing feature_id in PMModularBrainstormDeliverable", actionable: "Ensure chat-agent sets feature_id." };
      }
      // After thesis: must have both consensus and pm_memo
      if (content.brainstorm_rounds?.length > 0 && (!content.consensus || !content.pm_memo)) {
        return { valid: false, kickback_reason: "pm_fit_rejected", detail: "Thesis ran but consensus/pm_memo missing", actionable: "Synthesizer must produce consensus and pm_memo." };
      }
      return { valid: true, detail: "PMModularBrainstormDeliverable valid", actionable: "" };
    }
    // Legacy PMBrainstormDeliverable — fall through to standard field checks above
  }

  // Stage-specific validation
  if (stage === "nfr") {
    if (content.overall_status === "fail") {
      return {
        valid: false,
        kickback_reason: "nfr_critical_fail",
        detail: `NFR critical failures: ${content.critical_issues?.join("; ")}`,
        actionable: `Dev swarm must address these NFR issues before review: ${content.critical_issues?.join(", ")}. Check remediation field on each failing NFR item.`,
      };
    }
  }

  if (stage === "review") {
    if (content.decision === "changes_requested") {
      const blocking = content.comments?.filter((c: any) => c.severity === "blocking") ?? [];
      return {
        valid: false,
        kickback_reason: "review_changes_req",
        detail: `Review agent requested ${blocking.length} blocking changes.`,
        actionable: `Dev swarm must fix: ${blocking.map((c: any) => `${c.file}: ${c.body}`).join("; ")}`,
      };
    }
  }

  if (stage === "qa") {
    if (content.pass_rate < 0.8) {
      return {
        valid: false,
        kickback_reason: "qa_tests_failed",
        detail: `QA pass rate ${(content.pass_rate * 100).toFixed(0)}% is below 80% threshold. Failed: ${content.failed} tests.`,
        actionable: `Dev swarm must fix failing tests. See videos in ${deliverable.memory_path}. Failed tests: ${
          content.test_cases?.filter((t: any) => t.status === "fail")
            .map((t: any) => `${t.id}: ${t.error_message}`).join("; ")
        }`,
      };
    }
  }

  if (stage === "cicd") {
    if (content.deploy_status === "failed") {
      return {
        valid: false,
        kickback_reason: "ci_build_failed",
        detail: `CI/CD build failed. See: ${content.build_log_url}`,
        actionable: `Dev swarm must fix build failures. Build log: ${content.build_log_url}`,
      };
    }
  }

  return { valid: true, detail: "All validations passed", actionable: "" };
}

// ── human-gate.ts ─────────────────────────────────────────────────────────────

import { createBranch, createPullRequest } from "../integrations/github";

interface GateOptions {
  stage: StageId;
  title: string;
  body: string;
  deliverable?: Deliverable;
  featureId: string;
}

export async function openHumanGatePR(opts: GateOptions): Promise<{ pr_url: string; branch: string }> {
  const branchName = `gate/${opts.stage}/${opts.featureId.slice(0, 8)}`;

  try {
    await createBranch(branchName);
    const pr = await createPullRequest({
      title: opts.title,
      body: `${opts.body}\n\n---\n**Stage:** ${opts.stage}\n**Deliverable:** ${opts.deliverable?.memory_path ?? "N/A"}\n**Merge this PR to approve.**`,
      head: branchName,
      base: "main",
    });
    return { pr_url: pr.html_url ?? `gate-pr/${opts.stage}`, branch: branchName };
  } catch (err) {
    // In development without GitHub — return a local path
    const localPath = path.join(PROJECT_ROOT, `memory/runtime/gate-${opts.stage}.md`);
    fs.writeFileSync(localPath, `# ${opts.title}\n\n${opts.body}\n\nApprove by editing this file: add line "APPROVED: your-name"`);
    return { pr_url: `file://${localPath}`, branch: branchName };
  }
}

// ── sod.ts ────────────────────────────────────────────────────────────────────

const SOD_ROLES: Record<StageId, "maker" | "checker" | "executor" | null> = {
  pm_brainstorm: "maker",
  pm_promote:    null,
  po:            "maker",
  design:        "maker",
  architect:     "maker",
  dev_swarm:     "maker",
  nfr:           "checker",
  review:        "checker",
  code_pr:       null,
  cicd:          "executor",
  qa:            "executor",
  done:          null,
  escalated:     null,
};

const SOD_CONFLICTS: Array<["maker" | "checker" | "executor", "maker" | "checker" | "executor"]> = [
  ["maker", "checker"],
  ["checker", "executor"],
];

export function sodCheck(
  stage: StageId,
  claimedRole: "maker" | "checker" | "executor",
  state: PipelineState
): { ok: boolean; reason?: string } {
  const expectedRole = SOD_ROLES[stage];
  if (expectedRole && expectedRole !== claimedRole) {
    return { ok: false, reason: `Stage ${stage} requires role '${expectedRole}' but '${claimedRole}' was claimed.` };
  }

  // Check if the same logical "agent" is playing conflicting roles
  // In this framework, different stage IDs = different agents, so this is enforced by stage routing
  return { ok: true };
}
