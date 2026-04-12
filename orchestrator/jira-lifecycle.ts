// orchestrator/jira-lifecycle.ts
// Called after every pipeline stage completes.
// Updates all Jira stories for this feature with:
//   - Transition to the correct status
//   - Progress comment with agent detail + links
//
// This is what makes Jira tickets reflect the full agent timeline.
// Every story goes from "To Do" → "In Progress" → "In Review" → "Done"
// with a comment at each boundary showing exactly what the agent did.

import {
  updateStoriesForStage,
  addProgressComment,
  STAGE_TRANSITIONS,
  transitionIssue,
} from "../integrations/jira";
import type { PipelineState, StageId } from "../types/state";

export async function updateJiraForStage(
  state:   PipelineState,
  stage:   StageId,
  detail?: string
): Promise<void> {
  const storyKeys = state.jira?.story_keys ?? [];
  const epicKey   = state.jira?.epic_key;

  const stageConfig = STAGE_TRANSITIONS[stage];
  if (!stageConfig || storyKeys.length === 0) return;

  // Build context-aware detail message
  const stageDetail = detail ?? buildStageDetail(state, stage);

  // Build relevant links for this stage
  const links = buildStageLinks(state, stage);

  // Update all stories
  await updateStoriesForStage(
    storyKeys,
    stage,
    stageConfig.transition,
    stageDetail,
    links
  );

  // Also update the Epic with a summary comment
  if (epicKey) {
    await addProgressComment(
      epicKey,
      stage,
      "complete",
      `${stageConfig.label}\n${stageDetail}`,
      links
    ).catch(() => {}); // soft fail — epic update is non-critical
  }
}

export async function updateJiraForKickback(
  state:   PipelineState,
  fromStage: StageId,
  toStage:   StageId
): Promise<void> {
  const storyKeys = state.jira?.story_keys ?? [];
  if (storyKeys.length === 0) return;

  const lastKickback = state.kickbacks.findLast(k => k.stage === fromStage);
  if (!lastKickback) return;

  await Promise.allSettled(
    storyKeys.map(key =>
      addProgressComment(
        key,
        fromStage,
        "kicked_back",
        `Kickback #${lastKickback.retry_count} from ${fromStage} → ${toStage}\n${lastKickback.actionable}`,
      )
    )
  );
}

export async function updateJiraForEscalation(state: PipelineState): Promise<void> {
  const storyKeys = state.jira?.story_keys ?? [];
  const epicKey   = state.jira?.epic_key;

  const msg = `Pipeline escalated after max retries.\n${state.escalation_reason ?? "Unknown reason"}`;

  await Promise.allSettled([
    ...storyKeys.map(key => {
      transitionIssue(key, "Blocked");
      return addProgressComment(key, "escalation", "blocked", msg);
    }),
    ...(epicKey ? [addProgressComment(epicKey, "escalation", "blocked", msg)] : []),
  ]);
}

// ── Context builders ──────────────────────────────────────────────────────────

function buildStageDetail(state: PipelineState, stage: StageId): string {
  const d = state.deliverables?.[stage]?.content as any;
  if (!d) return STAGE_TRANSITIONS[stage]?.label ?? stage;

  switch (stage) {
    case "pm_brainstorm":
      return `PM consensus: ${d.consensus?.build_decision?.toUpperCase()} (confidence ${Math.round((d.consensus?.confidence ?? 0) * 100)}%)\n${d.consensus?.agreed_scope ?? ""}`;

    case "po":
      return `Epic ${state.jira.epic_key} created with ${d.user_stories?.length ?? 0} stories.`;

    case "design":
      return `Figma file: ${d.figma_share_url ?? "N/A"}\nScreens: ${d.screens?.length ?? 0} | Components: ${d.components?.length ?? 0}`;

    case "architect":
      return `Branch: ${state.github.feature_branch}\nFE tasks: ${d.frontend_tasks?.length ?? 0} | BE tasks: ${d.backend_tasks?.length ?? 0}`;

    case "dev_swarm":
      return `PR #${state.github.pr_number} opened.\nFiles written: ${d.files_written?.length ?? 0} | +${d.write_report?.totalAdded ?? 0}/-${d.write_report?.totalRemoved ?? 0} lines`;

    case "nfr":
      return `NFR status: ${d.overall_status?.toUpperCase()}\n${d.critical_issues?.length > 0 ? `Issues: ${d.critical_issues.join(", ")}` : "No critical issues."}`;

    case "review":
      return `Decision: ${d.decision?.toUpperCase()}\nCoverage: ${d.coverage_pct ?? "?"}% | Blocking comments: ${d.comments?.filter((c: any) => c.severity === "blocking").length ?? 0}`;

    case "cicd":
      return `Deploy status: ${state.deployment?.deploy_status?.toUpperCase()}\nStaging: ${state.deployment?.staging_url ?? "N/A"}`;

    case "qa":
      return `Tests: ${d.passed ?? 0} passed / ${d.failed ?? 0} failed (${Math.round((d.pass_rate ?? 0) * 100)}%)\nVideos: ${d.videos_dir ?? "N/A"}`;

    default:
      return STAGE_TRANSITIONS[stage]?.label ?? stage;
  }
}

function buildStageLinks(
  state: PipelineState,
  stage: StageId
): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];

  if (state.github.pr_url) {
    links.push({ label: "View PR", url: state.github.pr_url });
  }

  const d = state.deliverables?.[stage]?.content as any;

  if (stage === "design" && d?.figma_share_url) {
    links.push({ label: "Open Figma", url: d.figma_share_url });
  }

  if (stage === "cicd" && state.deployment?.staging_url) {
    links.push({ label: "View Staging", url: state.deployment.staging_url });
  }

  if (stage === "cicd" && state.deployment?.build_log_url) {
    links.push({ label: "Build Log", url: state.deployment.build_log_url });
  }

  if (stage === "qa" && d?.jira_test_run_url) {
    links.push({ label: "Test Run", url: d.jira_test_run_url });
  }

  return links;
}
