// integrations/slack.ts
// Slack Block Kit messages for every agent notification and human gate.
// Returns { ts } (message timestamp) so threads can be continued.

import { integrations } from "../config/integrations";

const { slack: cfg } = integrations;

interface SlackResponse { ok: boolean; ts?: string; error?: string; }

async function postMessage(channel: string, blocks: unknown[], text: string): Promise<SlackResponse> {
  if (!cfg.botToken) {
    console.log(`[Slack stub] ${channel}: ${text}`);
    return { ok: true, ts: Date.now().toString() };
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${cfg.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, blocks, text }),
  });

  const data = await res.json() as SlackResponse;
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data;
}

async function replyToThread(channel: string, threadTs: string, blocks: unknown[], text: string) {
  if (!cfg.botToken) {
    console.log(`[Slack stub thread] ${channel}: ${text}`);
    return { ok: true, ts: threadTs };
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${cfg.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, blocks, text }),
  });

  return res.json() as Promise<SlackResponse>;
}

// ── PM Brainstorm complete ────────────────────────────────────────────────────

export async function notifyPMBrainstormComplete(params: {
  featureTitle: string;
  decision:     "proceed" | "modify" | "reject";
  confidence:   number;
  fitScore:     number;
  epicKey?:     string;
}) {
  const emoji = params.decision === "proceed" ? ":white_check_mark:"
              : params.decision === "modify"  ? ":warning:"
              : ":x:";

  return postMessage(cfg.channels.po, [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} PM Brainstorm Complete` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Feature:*\n${params.featureTitle}` },
        { type: "mrkdwn", text: `*Decision:*\n${params.decision.toUpperCase()}` },
        { type: "mrkdwn", text: `*Confidence:*\n${Math.round(params.confidence * 100)}%` },
        { type: "mrkdwn", text: `*Avg Fit Score:*\n${params.fitScore}/10` },
      ],
    },
    { type: "divider" },
  ], `PM Brainstorm: ${params.decision} — ${params.featureTitle}`);
}

// ── PO human gate ─────────────────────────────────────────────────────────────

export async function notifyPOForStoryReview(epicKey: string, jiraUrl: string, prUrl?: string) {
  return postMessage(cfg.channels.po, [
    {
      type: "header",
      text: { type: "plain_text", text: ":memo: PO Review Required" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Epic ${epicKey}* and User Stories are ready for your review.\nPlease review the Jira Epic and approve the GitHub PR to continue the pipeline.`,
      },
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Review in Jira" },        url: jiraUrl,        style: "primary" },
        ...(prUrl ? [{ type: "button", text: { type: "plain_text", text: "Approve PR (gate)" }, url: prUrl }] : []),
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: ":information_source: Merge the gate PR to approve and continue the pipeline." }],
    },
  ], `PO Review needed: Epic ${epicKey}`);
}

// ── Design human gate ─────────────────────────────────────────────────────────

export async function notifyDesignReview(figmaUrl: string, prUrl?: string, frameCount = 0) {
  return postMessage(cfg.channels.design, [
    {
      type: "header",
      text: { type: "plain_text", text: ":art: Design Review Required" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${frameCount} wireframes are ready in Figma.\nReview and merge the gate PR to continue to architecture.`,
      },
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Open Figma" },          url: figmaUrl, style: "primary" },
        ...(prUrl ? [{ type: "button", text: { type: "plain_text", text: "Approve PR (gate)" }, url: prUrl }] : []),
      ],
    },
  ], "Design review needed");
}

// ── Architect started ─────────────────────────────────────────────────────────

export async function notifyArchStarted(params: {
  featureTitle: string;
  branch:       string;
  feTasks:      number;
  beTasks:      number;
}) {
  return postMessage(cfg.channels.arch, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:building_construction: *Architect Agent* started for *${params.featureTitle}*\nBranch: \`${params.branch}\`\nFE tasks: ${params.feTasks} | BE tasks: ${params.beTasks}`,
      },
    },
  ], `Architect started: ${params.featureTitle}`);
}

// ── NFR result ────────────────────────────────────────────────────────────────

export async function notifyNFRResult(params: {
  status:         "pass" | "warn" | "fail";
  criticalIssues: string[];
  prUrl?:         string;
}) {
  const emoji = params.status === "pass" ? ":shield:" : params.status === "warn" ? ":warning:" : ":rotating_light:";
  return postMessage(cfg.channels.arch, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *NFR Review:* ${params.status.toUpperCase()}\n${
          params.criticalIssues.length
            ? `Critical issues:\n${params.criticalIssues.map(i => `• ${i}`).join("\n")}`
            : "No critical issues found."
        }`,
      },
    },
  ], `NFR Review: ${params.status}`);
}

// ── Review result ─────────────────────────────────────────────────────────────

export async function notifyReviewResult(params: {
  decision:        "approved" | "changes_requested";
  blockingCount:   number;
  prUrl?:          string;
}) {
  const emoji = params.decision === "approved" ? ":white_check_mark:" : ":pencil:";
  return postMessage(cfg.channels.arch, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *Peer Review:* ${params.decision.replace("_", " ").toUpperCase()}\n${
          params.blockingCount > 0 ? `${params.blockingCount} blocking comments — pipeline kicked back to dev swarm.` : "No blocking issues."
        }`,
      },
    },
    ...(params.prUrl ? [{
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "View PR" }, url: params.prUrl }],
    }] : []),
  ], `Peer Review: ${params.decision}`);
}

// ── CI/CD deployment ──────────────────────────────────────────────────────────

export async function notifyDeployment(env: string, status: "success" | "failed", url?: string, buildLogUrl?: string) {
  const emoji = status === "success" ? ":rocket:" : ":fire:";
  return postMessage(cfg.channels.cicd, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *Deploy to ${env}:* ${status.toUpperCase()}${url ? `\nStaging: ${url}` : ""}`,
      },
    },
    ...(buildLogUrl ? [{
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "View Build Log" }, url: buildLogUrl }],
    }] : []),
  ], `Deploy to ${env}: ${status}`);
}

// ── QA result + human gate ────────────────────────────────────────────────────

export async function notifyQAResults(params: {
  passed:    number;
  failed:    number;
  videosUrl: string;
  prUrl?:    string;
}) {
  const total    = params.passed + params.failed;
  const passRate = total > 0 ? Math.round((params.passed / total) * 100) : 0;
  const emoji    = params.failed === 0 ? ":white_check_mark:" : passRate >= 80 ? ":warning:" : ":x:";

  return postMessage(cfg.channels.qa, [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} QA Run Complete — Human Review Required` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Passed:*\n${params.passed}` },
        { type: "mrkdwn", text: `*Failed:*\n${params.failed}` },
        { type: "mrkdwn", text: `*Pass Rate:*\n${passRate}%` },
        { type: "mrkdwn", text: `*Threshold:*\n80%` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `:video_camera: Each test has a recorded video. Please review before approving.` },
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Watch Videos" },       url: params.videosUrl, style: "primary" },
        ...(params.prUrl ? [{ type: "button", text: { type: "plain_text", text: "Approve PR (gate)" }, url: params.prUrl }] : []),
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: ":information_source: Merge the gate PR after video review to close the pipeline." }],
    },
  ], `QA: ${params.passed} passed, ${params.failed} failed — ${passRate}% pass rate`);
}

// ── Escalation alert ──────────────────────────────────────────────────────────

export async function notifyEscalation(params: {
  stage:   string;
  reason:  string;
  retries: number;
}) {
  return postMessage(cfg.channels.cicd, [
    {
      type: "header",
      text: { type: "plain_text", text: ":sos: Pipeline Escalated — Manual Intervention Required" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Stage:* ${params.stage}\n*Retries exhausted:* ${params.retries}\n*Reason:* ${params.reason}`,
      },
    },
  ], `Pipeline escalated at ${params.stage} after ${params.retries} retries`);
}

// ── Kickback notification ─────────────────────────────────────────────────────

export async function notifyKickback(params: {
  fromStage:  string;
  toStage:    string;
  retryCount: number;
  actionable: string;
}) {
  return postMessage(cfg.channels.arch, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:arrows_counterclockwise: *Kickback* from \`${params.fromStage}\` → \`${params.toStage}\` (retry ${params.retryCount})\n*Fix required:* ${params.actionable}`,
      },
    },
  ], `Kickback: ${params.fromStage} → ${params.toStage}`);
}
