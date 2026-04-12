// integrations/teams.ts
// Microsoft Teams notifications via Incoming Webhook + Adaptive Cards.
// Runs alongside Slack — both fire for every event.
// Teams uses webhook URLs per channel (no bot token needed).
//
// Setup:
//   1. In Teams: channel → ... → Connectors → Incoming Webhook → copy URL
//   2. Add the URL to .env (one per channel)
//   3. Done — no app registration, no OAuth needed

import { integrations } from "../config/integrations";

const { teams: cfg } = integrations;

// ── Core sender ───────────────────────────────────────────────────────────────

async function postCard(webhookUrl: string, card: AdaptiveCard): Promise<void> {
  if (!webhookUrl) {
    console.log(`[Teams stub] Would send card: ${card.body?.[0]?.text ?? "(no title)"}`);
    return;
  }

  const res = await fetch(webhookUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      type:        "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content:     card,
      }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[Teams] Webhook failed ${res.status}: ${text}`);
  }
}

// ── Adaptive Card types (minimal) ─────────────────────────────────────────────

interface AdaptiveCard {
  type:    "AdaptiveCard";
  version: "1.4";
  body:    AdaptiveElement[];
  actions?: AdaptiveAction[];
  msteams?: { width: "Full" };
}

type AdaptiveElement =
  | { type: "TextBlock";  text: string; weight?: "Bolder" | "Default"; size?: "Medium" | "Large" | "Small"; color?: "Good" | "Warning" | "Attention" | "Accent" | "Default"; wrap?: boolean; separator?: boolean }
  | { type: "FactSet";    facts: { title: string; value: string }[] }
  | { type: "ColumnSet";  columns: { type: "Column"; width: string; items: AdaptiveElement[] }[] }
  | { type: "Container";  items: AdaptiveElement[]; style?: "emphasis" | "good" | "warning" | "attention" }

interface AdaptiveAction {
  type:  "Action.OpenUrl";
  title: string;
  url:   string;
}

// ── Card builder ──────────────────────────────────────────────────────────────

function buildCard(params: {
  title:   string;
  emoji:   string;
  color:   "Good" | "Warning" | "Attention" | "Accent" | "Default";
  facts?:  { title: string; value: string }[];
  body?:   string;
  actions?: { title: string; url: string }[];
}): AdaptiveCard {
  const elements: AdaptiveElement[] = [
    {
      type:   "TextBlock",
      text:   `${params.emoji} ${params.title}`,
      weight: "Bolder",
      size:   "Medium",
      color:  params.color,
      wrap:   true,
    },
  ];

  if (params.body) {
    elements.push({ type: "TextBlock", text: params.body, wrap: true });
  }

  if (params.facts?.length) {
    elements.push({ type: "FactSet", facts: params.facts });
  }

  return {
    type:    "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body:    elements,
    actions: params.actions?.map(a => ({
      type:  "Action.OpenUrl",
      title: a.title,
      url:   a.url,
    })),
  };
}

// ── PM Brainstorm complete ────────────────────────────────────────────────────

export async function teamsNotifyPMBrainstormComplete(params: {
  featureTitle: string;
  decision:     "proceed" | "modify" | "reject";
  confidence:   number;
  fitScore:     number;
}) {
  const { emoji, color } = {
    proceed: { emoji: "✅", color: "Good"      as const },
    modify:  { emoji: "⚠️", color: "Warning"   as const },
    reject:  { emoji: "❌", color: "Attention" as const },
  }[params.decision];

  return postCard(cfg.channels.po, buildCard({
    title:  `PM Brainstorm Complete — ${params.featureTitle}`,
    emoji,
    color,
    facts: [
      { title: "Decision",    value: params.decision.toUpperCase() },
      { title: "Confidence",  value: `${Math.round(params.confidence * 100)}%` },
      { title: "Avg Fit",     value: `${params.fitScore}/10` },
    ],
  }));
}

// ── PO human gate ─────────────────────────────────────────────────────────────

export async function teamsNotifyPOForStoryReview(
  epicKey: string,
  jiraUrl: string,
  prUrl?:  string
) {
  return postCard(cfg.channels.po, buildCard({
    title:  `PO Review Required — Epic ${epicKey}`,
    emoji:  "📋",
    color:  "Accent",
    body:   "User Stories are ready for your review. Please approve the Epic and Stories in Jira, then merge the gate PR to continue the pipeline.",
    facts: [
      { title: "Epic",   value: epicKey },
      { title: "Gate",   value: prUrl ? "GitHub PR" : "Jira only" },
    ],
    actions: [
      { title: "Review in Jira",  url: jiraUrl },
      ...(prUrl ? [{ title: "Merge Gate PR", url: prUrl }] : []),
    ],
  }));
}

// ── Design human gate ─────────────────────────────────────────────────────────

export async function teamsNotifyDesignReview(
  figmaUrl:   string,
  prUrl?:     string,
  frameCount = 0
) {
  return postCard(cfg.channels.design, buildCard({
    title:  "Design Review Required",
    emoji:  "🎨",
    color:  "Accent",
    body:   `${frameCount} wireframes are ready in Figma. Review and merge the gate PR to continue to architecture.`,
    actions: [
      { title: "Open Figma",     url: figmaUrl },
      ...(prUrl ? [{ title: "Merge Gate PR", url: prUrl }] : []),
    ],
  }));
}

// ── Architect started ─────────────────────────────────────────────────────────

export async function teamsNotifyArchStarted(params: {
  featureTitle: string;
  branch:       string;
  feTasks:      number;
  beTasks:      number;
}) {
  return postCard(cfg.channels.arch, buildCard({
    title: `Architect Agent Started — ${params.featureTitle}`,
    emoji: "🏗️",
    color: "Accent",
    facts: [
      { title: "Branch",   value: params.branch },
      { title: "FE Tasks", value: String(params.feTasks) },
      { title: "BE Tasks", value: String(params.beTasks) },
    ],
  }));
}

// ── NFR result ────────────────────────────────────────────────────────────────

export async function teamsNotifyNFRResult(params: {
  status:         "pass" | "warn" | "fail";
  criticalIssues: string[];
}) {
  const { emoji, color } = {
    pass: { emoji: "🛡️", color: "Good"      as const },
    warn: { emoji: "⚠️", color: "Warning"   as const },
    fail: { emoji: "🚨", color: "Attention" as const },
  }[params.status];

  return postCard(cfg.channels.arch, buildCard({
    title: `NFR Review — ${params.status.toUpperCase()}`,
    emoji,
    color,
    body: params.criticalIssues.length
      ? `Critical issues:\n${params.criticalIssues.map(i => `• ${i}`).join("\n")}`
      : "No critical NFR issues found.",
  }));
}

// ── Review result ─────────────────────────────────────────────────────────────

export async function teamsNotifyReviewResult(params: {
  decision:      "approved" | "changes_requested";
  blockingCount: number;
  prUrl?:        string;
}) {
  const approved = params.decision === "approved";
  return postCard(cfg.channels.arch, buildCard({
    title:  `Peer Review — ${params.decision.replace("_", " ").toUpperCase()}`,
    emoji:  approved ? "✅" : "📝",
    color:  approved ? "Good" : "Warning",
    body:   approved
      ? "PR approved. Proceeding to CI/CD."
      : `${params.blockingCount} blocking comment(s). Pipeline kicked back to dev swarm.`,
    actions: params.prUrl ? [{ title: "View PR", url: params.prUrl }] : undefined,
  }));
}

// ── CI/CD deployment ──────────────────────────────────────────────────────────

export async function teamsNotifyDeployment(
  env:         string,
  status:      "success" | "failed",
  stagingUrl?: string,
  buildLogUrl?: string
) {
  const success = status === "success";
  return postCard(cfg.channels.cicd, buildCard({
    title:  `Deploy to ${env} — ${status.toUpperCase()}`,
    emoji:  success ? "🚀" : "🔥",
    color:  success ? "Good" : "Attention",
    facts: [
      { title: "Environment", value: env },
      { title: "Status",      value: status.toUpperCase() },
      ...(stagingUrl ? [{ title: "Staging URL", value: stagingUrl }] : []),
    ],
    actions: [
      ...(stagingUrl  ? [{ title: "Open Staging", url: stagingUrl }]  : []),
      ...(buildLogUrl ? [{ title: "Build Log",    url: buildLogUrl }] : []),
    ],
  }));
}

// ── QA results + human gate ───────────────────────────────────────────────────

export async function teamsNotifyQAResults(params: {
  passed:    number;
  failed:    number;
  videosUrl: string;
  prUrl?:    string;
}) {
  const total    = params.passed + params.failed;
  const passRate = total > 0 ? Math.round((params.passed / total) * 100) : 0;
  const color    = params.failed === 0 ? "Good" as const : passRate >= 80 ? "Warning" as const : "Attention" as const;

  return postCard(cfg.channels.qa, buildCard({
    title:  `QA Run Complete — Human Review Required`,
    emoji:  params.failed === 0 ? "✅" : passRate >= 80 ? "⚠️" : "❌",
    color,
    body:   "Each test has a recorded video. Please review before approving.",
    facts: [
      { title: "Passed",    value: String(params.passed) },
      { title: "Failed",    value: String(params.failed) },
      { title: "Pass Rate", value: `${passRate}%` },
      { title: "Threshold", value: "80%" },
    ],
    actions: [
      { title: "Watch Videos",   url: params.videosUrl },
      ...(params.prUrl ? [{ title: "Merge Gate PR (approve)", url: params.prUrl }] : []),
    ],
  }));
}

// ── Kickback notification ─────────────────────────────────────────────────────

export async function teamsNotifyKickback(params: {
  fromStage:  string;
  toStage:    string;
  retryCount: number;
  actionable: string;
}) {
  return postCard(cfg.channels.arch, buildCard({
    title:  `Kickback — ${params.fromStage} → ${params.toStage} (retry ${params.retryCount})`,
    emoji:  "↩️",
    color:  "Warning",
    body:   params.actionable,
    facts: [
      { title: "From",  value: params.fromStage },
      { title: "To",    value: params.toStage },
      { title: "Retry", value: String(params.retryCount) },
    ],
  }));
}

// ── Escalation ────────────────────────────────────────────────────────────────

export async function teamsNotifyEscalation(params: {
  stage:   string;
  reason:  string;
  retries: number;
}) {
  return postCard(cfg.channels.cicd, buildCard({
    title:  "🚨 Pipeline Escalated — Manual Intervention Required",
    emoji:  "🆘",
    color:  "Attention",
    facts: [
      { title: "Stage",   value: params.stage },
      { title: "Retries", value: String(params.retries) },
      { title: "Reason",  value: params.reason },
    ],
  }));
}

// ── Bug pipeline notifications ────────────────────────────────────────────────

export async function teamsNotifyBugCreated(params: {
  bugKey:    string;
  summary:   string;
  severity:  string;
  jiraUrl:   string;
}) {
  const severityColor = {
    critical: "Attention" as const,
    high:     "Attention" as const,
    medium:   "Warning"   as const,
    low:      "Default"   as const,
  }[params.severity] ?? "Default" as const;

  return postCard(cfg.channels.qa, buildCard({
    title:  `Bug Created — ${params.bugKey}`,
    emoji:  "🐛",
    color:  severityColor,
    body:   params.summary,
    facts: [
      { title: "Severity", value: params.severity.toUpperCase() },
      { title: "Jira Key", value: params.bugKey },
    ],
    actions: [{ title: "View in Jira", url: params.jiraUrl }],
  }));
}

export async function teamsNotifyBugFixed(params: {
  bugKey:   string;
  summary:  string;
  prUrl:    string;
  videoUrl?: string;
}) {
  return postCard(cfg.channels.qa, buildCard({
    title:  `Bug Fixed — ${params.bugKey}`,
    emoji:  "✅",
    color:  "Good",
    body:   params.summary,
    actions: [
      { title: "View PR",    url: params.prUrl },
      ...(params.videoUrl ? [{ title: "Verification Video", url: params.videoUrl }] : []),
    ],
  }));
}
