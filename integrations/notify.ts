// integrations/notify.ts
// Single import for all agent notifications.
// Every function fires Slack AND Teams simultaneously (Promise.allSettled).
// If one fails, the other still goes through.
// To disable Teams: set TEAMS_ENABLED=false in .env
// To disable Slack: leave SLACK_BOT_TOKEN empty in .env

import { integrations } from "../config/integrations";

// ── Slack ──────────────────────────────────────────────────────────────────────
import {
  notifyPMBrainstormComplete  as slackPM,
  notifyPOForStoryReview      as slackPO,
  notifyDesignReview          as slackDesign,
  notifyArchStarted           as slackArch,
  notifyNFRResult             as slackNFR,
  notifyReviewResult          as slackReview,
  notifyDeployment            as slackDeploy,
  notifyQAResults             as slackQA,
  notifyKickback              as slackKickback,
  notifyEscalation            as slackEscalate,
} from "./slack";

// ── Teams ──────────────────────────────────────────────────────────────────────
import {
  teamsNotifyPMBrainstormComplete  as teamsPM,
  teamsNotifyPOForStoryReview      as teamsPO,
  teamsNotifyDesignReview          as teamsDesign,
  teamsNotifyArchStarted           as teamsArch,
  teamsNotifyNFRResult             as teamsNFR,
  teamsNotifyReviewResult          as teamsReview,
  teamsNotifyDeployment            as teamsDeploy,
  teamsNotifyQAResults             as teamsQA,
  teamsNotifyKickback              as teamsKickback,
  teamsNotifyEscalation            as teamsEscalate,
  teamsNotifyBugCreated,
  teamsNotifyBugFixed,
} from "./teams";

// ── Helper: fire both, swallow individual failures ────────────────────────────

async function both<T>(
  slackFn:  () => Promise<T>,
  teamsFn:  () => Promise<void>
): Promise<T | void> {
  const results = await Promise.allSettled([
    slackFn(),
    integrations.teams.enabled ? teamsFn() : Promise.resolve(),
  ]);

  // Log failures without crashing the pipeline
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const channel = i === 0 ? "Slack" : "Teams";
      console.warn(`[${channel}] Notification failed: ${r.reason?.message ?? r.reason}`);
    }
  });

  return results[0].status === "fulfilled" ? results[0].value : undefined;
}

// ── Unified notification API ──────────────────────────────────────────────────
// Use these everywhere in the pipeline instead of importing Slack/Teams directly.

export async function notifyPMBrainstormComplete(params: {
  featureTitle: string;
  decision:     "proceed" | "modify" | "reject";
  confidence:   number;
  fitScore:     number;
  epicKey?:     string;
}) {
  return both(
    () => slackPM(params),
    () => teamsPM(params)
  );
}

export async function notifyPOForStoryReview(
  epicKey: string,
  jiraUrl: string,
  prUrl?:  string
) {
  return both(
    () => slackPO(epicKey, jiraUrl, prUrl),
    () => teamsPO(epicKey, jiraUrl, prUrl)
  );
}

export async function notifyDesignReview(
  figmaUrl:   string,
  prUrl?:     string,
  frameCount = 0
) {
  return both(
    () => slackDesign(figmaUrl, prUrl, frameCount),
    () => teamsDesign(figmaUrl, prUrl, frameCount)
  );
}

export async function notifyArchStarted(params: {
  featureTitle: string;
  branch:       string;
  feTasks:      number;
  beTasks:      number;
}) {
  return both(
    () => slackArch(params),
    () => teamsArch(params)
  );
}

export async function notifyNFRResult(params: {
  status:         "pass" | "warn" | "fail";
  criticalIssues: string[];
  prUrl?:         string;
}) {
  return both(
    () => slackNFR(params),
    () => teamsNFR(params)
  );
}

export async function notifyReviewResult(params: {
  decision:      "approved" | "changes_requested";
  blockingCount: number;
  prUrl?:        string;
}) {
  return both(
    () => slackReview(params),
    () => teamsReview(params)
  );
}

export async function notifyDeployment(
  env:         string,
  status:      "success" | "failed",
  stagingUrl?: string,
  buildLogUrl?: string
) {
  return both(
    () => slackDeploy(env, status, stagingUrl, buildLogUrl),
    () => teamsDeploy(env, status, stagingUrl, buildLogUrl)
  );
}

export async function notifyQAResults(params: {
  passed:    number;
  failed:    number;
  videosUrl: string;
  prUrl?:    string;
}) {
  return both(
    () => slackQA(params),
    () => teamsQA(params)
  );
}

export async function notifyKickback(params: {
  fromStage:  string;
  toStage:    string;
  retryCount: number;
  actionable: string;
}) {
  return both(
    () => slackKickback(params),
    () => teamsKickback(params)
  );
}

export async function notifyEscalation(params: {
  stage:   string;
  reason:  string;
  retries: number;
}) {
  return both(
    () => slackEscalate(params),
    () => teamsEscalate(params)
  );
}

// Bug pipeline notifications
export async function notifyBugCreated(params: {
  bugKey:   string;
  summary:  string;
  severity: string;
  jiraUrl:  string;
}) {
  // Slack does not have a specific bug created function — use generic deploy channel
  return both(
    () => Promise.resolve(),  // Slack: Jira comment covers this
    () => teamsNotifyBugCreated(params)
  );
}

export async function notifyBugFixed(params: {
  bugKey:    string;
  summary:   string;
  prUrl:     string;
  videoUrl?: string;
}) {
  return both(
    () => Promise.resolve(),  // Slack: Jira closure comment covers this
    () => teamsNotifyBugFixed(params)
  );
}
