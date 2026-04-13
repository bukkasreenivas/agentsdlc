// integrations/jira.ts  — v2 (full lifecycle + bug pipeline)
// Creates Epics, Stories, Bugs. Transitions issues at every pipeline stage.
// Adds progress comments so every Jira ticket shows the full agent timeline.

import { integrations } from "../config/integrations";
import type { UserStory } from "../types/state";

const { jira: cfg } = integrations;

/** True only when ALL required Jira fields are set to non-default values */
function isJiraConfigured(): boolean {
  return !!(
    cfg.apiToken &&
    cfg.email &&
    cfg.baseUrl !== "https://yourorg.atlassian.net" &&
    cfg.projectKey && cfg.projectKey !== "PROJ"
  );
}

function stubKey() { return `${cfg.projectKey ?? "PROJ"}-${Math.floor(Math.random() * 9000) + 1000}`; }

const authHeader = () =>
  "Basic " + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");

async function jiraFetch<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown
): Promise<T> {
  if (!isJiraConfigured()) {
    console.log(`[Jira stub] ${method} ${endpoint} (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY to enable)`);
    return { key: stubKey(), id: "1", self: "" } as unknown as T;
  }
  const url = `${cfg.baseUrl}/rest/api/3${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept:         "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Gracefully degrade on config errors (wrong project key, wrong URL, etc.)
    // rather than crashing the whole pipeline
    console.warn(`[Jira] ${method} ${endpoint} -> ${res.status}: ${text} — falling back to stub`);
    return { key: stubKey(), id: "1", self: "" } as unknown as T;
  }
  return res.json() as Promise<T>;
}

// ---- ADF helpers -------------------------------------------------------

function adfDoc(text: string) {
  return { type: "doc", version: 1, content: [
    { type: "paragraph", content: [{ type: "text", text }] }
  ]};
}

function adfBullets(items: string[]) {
  return { type: "doc", version: 1, content: [{
    type: "bulletList",
    content: items.map(item => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text: item }] }],
    })),
  }]};
}

function adfHeadingPara(heading: string, body: string) {
  return [
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: heading }] },
    { type: "paragraph", content: [{ type: "text", text: body }] },
  ];
}

// ---- Types -------------------------------------------------------------

export interface JiraIssueRef { key: string; id: string; self: string; }

export interface CreateStoryInput {
  key: string;
  summary: string;
  acceptance_criteria: string[];
  story_points: number;
  epicKey: string;
  job_story: string;
  wwa: string;
  test_scenarios: string[];
}

export interface BugReport {
  key:               string;
  summary:           string;
  severity:          "critical" | "high" | "medium" | "low";
  stepsToReproduce:  string[];
  expectedBehaviour: string;
  actualBehaviour:   string;
  environment:       string;
  affectedStoryKey?: string;
  stackTrace?:       string;
  videoUrl?:         string;
}

// ---- Epic --------------------------------------------------------------

export async function createEpic(
  summary: string,
  description: string
): Promise<{ key: string; userStories: UserStory[] }> {
  const result = await jiraFetch<JiraIssueRef>("/issue", "POST", {
    fields: {
      project:     { key: cfg.projectKey },
      summary,
      description: adfDoc(description),
      issuetype:   { name: "Epic" },
      customfield_10011: summary,   // Epic Name -- adjust ID for your instance
    },
  });
  return { key: result.key, userStories: [] };
}

// ---- Story -------------------------------------------------------------

export async function createUserStory(input: CreateStoryInput): Promise<UserStory> {
  const description = adfBullets([
    `Job Story: ${input.job_story}`,
    `WWA: ${input.wwa}`,
    "--- Acceptance Criteria ---",
    ...input.acceptance_criteria,
    "--- Test Scenarios ---",
    ...input.test_scenarios,
  ]);
  const result = await jiraFetch<JiraIssueRef>("/issue", "POST", {
    fields: {
      project:           { key: cfg.projectKey },
      summary:           input.summary,
      description,
      issuetype:         { name: "Story" },
      story_points:      input.story_points,
      customfield_10014: input.epicKey,   // Epic Link -- adjust ID
    },
  });
  return {
    key:                result.key,
    summary:            input.summary,
    acceptance_criteria: input.acceptance_criteria,
    story_points:       input.story_points,
    epic_key:           input.epicKey,
    job_story:          input.job_story,
    wwa:                input.wwa,
    test_scenarios:     input.test_scenarios,
  };
}

// ---- Test Case ---------------------------------------------------------

export async function createTestCase(tc: {
  title: string; steps: string[]; storyKey: string; type?: string;
}): Promise<JiraIssueRef> {
  return jiraFetch<JiraIssueRef>("/issue", "POST", {
    fields: {
      project:     { key: cfg.projectKey },
      summary:     `[QA] ${tc.title}`,
      issuetype:   { name: "Test" },
      description: adfBullets([
        `Type: ${tc.type ?? "functional"}`,
        `Story: ${tc.storyKey}`,
        "--- Steps ---",
        ...tc.steps.map((s, i) => `${i + 1}. ${s}`),
      ]),
    },
  });
}

// ---- Transitions -------------------------------------------------------
// Moves a ticket along its workflow. Soft-fails so the pipeline never
// crashes if a transition name does not match your Jira project workflow.

export async function transitionIssue(
  issueKey: string,
  transitionName: string
): Promise<void> {
  try {
    const { transitions } = await jiraFetch<{
      transitions: Array<{ id: string; name: string }>
    }>(`/issue/${issueKey}/transitions`);
    const match = transitions.find(
      t => t.name.toLowerCase().includes(transitionName.toLowerCase())
    );
    if (!match) {
      console.warn(`[Jira] Transition '${transitionName}' not found on ${issueKey}. Available: ${transitions.map(t => t.name).join(", ")}`);
      return;
    }
    await jiraFetch(`/issue/${issueKey}/transitions`, "POST", {
      transition: { id: match.id },
    });
  } catch (err) {
    console.warn(`[Jira] transitionIssue failed for ${issueKey}: ${(err as Error).message}`);
  }
}

// ---- Progress comment --------------------------------------------------
// Added to every story/bug at each agent stage so the ticket has a full
// audit trail of what the agent did and when.

export async function addProgressComment(
  issueKey: string,
  stage:    string,
  status:   "started" | "complete" | "kicked_back" | "blocked",
  detail:   string,
  links?:   { label: string; url: string }[]
): Promise<void> {
  const emoji = { started: "🔄", complete: "✅", kicked_back: "↩️", blocked: "🚫" }[status];
  const linkText = links?.map(l => `${l.label}: ${l.url}`).join(" | ") ?? "";

  await jiraFetch(`/issue/${issueKey}/comment`, "POST", {
    body: {
      type: "doc", version: 1,
      content: [
        { type: "paragraph", content: [
          { type: "text", text: `${emoji} [AgentSDLC] Stage: ${stage} — ${status.toUpperCase()}`, marks: [{ type: "strong" }] },
        ]},
        { type: "paragraph", content: [{ type: "text", text: detail }] },
        ...(linkText ? [{ type: "paragraph", content: [{ type: "text", text: linkText }] }] : []),
      ],
    },
  }).catch(err => console.warn(`[Jira] comment failed on ${issueKey}: ${(err as Error).message}`));
}

// ---- Bulk story lifecycle update ---------------------------------------
// Called by orchestrator after each pipeline stage completes.
// Moves ALL stories for this feature to the correct Jira status and
// adds a progress comment so the ticket reflects the full agent timeline.

export async function updateStoriesForStage(
  storyKeys: string[],
  stage:     string,
  transition: string,
  detail:    string,
  links?:    { label: string; url: string }[]
): Promise<void> {
  await Promise.allSettled(
    storyKeys.map(async key => {
      await transitionIssue(key, transition);
      await addProgressComment(key, stage, "complete", detail, links);
    })
  );
}

// Story transition map -- what transition to call at each pipeline stage
export const STAGE_TRANSITIONS: Record<string, { transition: string; label: string }> = {
  pm_brainstorm: { transition: "In Progress",         label: "PM analysis complete" },
  po:            { transition: "In Progress",         label: "Stories created in Jira" },
  design:        { transition: "In Progress",         label: "Wireframes published to Figma" },
  architect:     { transition: "In Progress",         label: "ADR written, branch created" },
  dev_swarm:     { transition: "In Progress",         label: "Code written to project files, PR opened" },
  nfr:           { transition: "In Review",           label: "NFR review complete" },
  review:        { transition: "In Review",           label: "Peer review complete, PR approved" },
  cicd:          { transition: "In Review",           label: "Deployed to staging" },
  qa:            { transition: "Done",                label: "QA complete, all gates passed" },
  escalated:     { transition: "Blocked",             label: "Pipeline escalated — manual intervention needed" },
};

// ---- Bug creation ------------------------------------------------------

export async function createBug(bug: Omit<BugReport, "key">): Promise<BugReport> {
  const priorityMap = { critical: "Highest", high: "High", medium: "Medium", low: "Low" };

  const content = [
    ...adfHeadingPara("Steps to Reproduce", bug.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join("\n")),
    ...adfHeadingPara("Expected Behaviour", bug.expectedBehaviour),
    ...adfHeadingPara("Actual Behaviour",   bug.actualBehaviour),
    ...adfHeadingPara("Environment",        bug.environment),
    ...(bug.stackTrace ? [
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Stack Trace" }] },
      { type: "codeBlock", attrs: { language: "text" }, content: [{ type: "text", text: bug.stackTrace }] },
    ] : []),
    ...(bug.videoUrl ? [
      { type: "paragraph", content: [{ type: "text", text: `Video: ${bug.videoUrl}` }] },
    ] : []),
  ];

  const result = await jiraFetch<JiraIssueRef>("/issue", "POST", {
    fields: {
      project:     { key: cfg.projectKey },
      summary:     `[BUG] ${bug.summary}`,
      description: { type: "doc", version: 1, content },
      issuetype:   { name: "Bug" },
      priority:    { name: priorityMap[bug.severity] },
    },
  });

  // Link to the story that surfaced this bug
  if (bug.affectedStoryKey) {
    await jiraFetch("/issueLink", "POST", {
      type:         { name: "Caused by" },
      inwardIssue:  { key: result.key },
      outwardIssue: { key: bug.affectedStoryKey },
    }).catch(() => {});
  }

  return { ...bug, key: result.key };
}

// ---- Bug fix updates ---------------------------------------------------

export async function updateBugWithFix(
  bugKey:       string,
  fixSummary:   string,
  prUrl:        string,
  filesChanged: string[]
): Promise<void> {
  await addProgressComment(bugKey, "bug-fix", "complete",
    `Fix applied: ${fixSummary}\nFiles: ${filesChanged.join(", ")}`,
    [{ label: "View PR", url: prUrl }]
  );
  await transitionIssue(bugKey, "In Review");
}

export async function closeBugAsFixed(bugKey: string, testVideoUrl?: string): Promise<void> {
  await addProgressComment(bugKey, "qa-verification", "complete",
    "Bug verified as fixed by QA Agent.",
    testVideoUrl ? [{ label: "Verification Video", url: testVideoUrl }] : undefined
  );
  await transitionIssue(bugKey, "Done");
}

// ---- Get issue details (bug pipeline input) ----------------------------

export async function getIssue(issueKey: string): Promise<{
  key: string; summary: string; description: string;
  issuetype: string; status: string; priority: string;
}> {
  const issue = await jiraFetch<any>(
    `/issue/${issueKey}?fields=summary,description,issuetype,status,priority`
  );
  return {
    key:         issue.key,
    summary:     issue.fields.summary,
    description: issue.fields.description?.content?.[0]?.content?.[0]?.text ?? "",
    issuetype:   issue.fields.issuetype?.name ?? "",
    status:      issue.fields.status?.name ?? "",
    priority:    issue.fields.priority?.name ?? "",
  };
}

// ---- Attach video to issue (QA results) --------------------------------

export async function attachVideoLinkToIssue(
  issueKey: string,
  videoUrl: string,
  result:   "pass" | "fail"
): Promise<void> {
  await addProgressComment(issueKey, "qa", result === "pass" ? "complete" : "kicked_back",
    `QA Result: ${result.toUpperCase()}\nVideo: ${videoUrl}`,
    [{ label: "Watch Video", url: videoUrl }]
  );
}
