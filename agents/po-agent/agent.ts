// agents/po-agent/agent.ts — v4: INVEST + As-a/GWT format
// Stories follow "As a <user>, I would like to <action>, so that <benefit>" format.
// Acceptance Criteria follow Given / When / Then (GWT) table format.
// INVEST criteria enforced in the LLM prompt.
import { resolveModel, withFailover } from "../../config/llm-client";
import { AGENT_MODELS }   from "../../config/agents";
import { scanCodebase }   from "../../tools/codebase-scanner";
import { createEpic, createUserStory } from "../../integrations/jira";
import { notifyPOForStoryReview }      from "../../integrations/slack";
import { integrations }                from "../../config/integrations";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import type { PipelineState, PODeliverable, UserStory, KickbackRecord } from "../../types/state";

export async function runPOAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const pmDeliverable  = state.deliverables?.pm_brainstorm?.content as any;
  const pmMemo: string = pmDeliverable?.pm_memo ?? "";
  const agreedScope    = pmDeliverable?.consensus?.agreed_scope ?? "";
  const kickbackCount  = state.retry_counts?.po ?? 0;
  const lastKickback   = state.kickbacks.findLast((k: KickbackRecord) => k.stage === "po");
  const kickbackContext = lastKickback
    ? `\n\nIMPORTANT — Revision ${kickbackCount}. Previous revision was rejected.\nReason: ${lastKickback.detail}\nFix required: ${lastKickback.actionable}`
    : "";

  // Scan the codebase so stories reference real existing code
  const codeCtx = await scanCodebase(state.repo_path);
  const codeContext = [
    `Tech stack: ${codeCtx.techStack.join(", ")}`,
    codeCtx.apiRoutes.length > 0
      ? `Existing API routes: ${codeCtx.apiRoutes.slice(0, 10).join(", ")}`
      : "",
    codeCtx.keyFileExcerpts.slice(0, 3).map(f => `[${f.path}]\n${f.content.slice(0, 300)}`).join("\n"),
  ].filter(Boolean).join("\n\n");

  const cfg = AGENT_MODELS.po;

  async function callPOAgent(limit: string): Promise<string> {
    return withFailover(async (client) => {
      const response = await client.messages.create({
        model:      resolveModel(cfg.model),
        max_tokens: cfg.maxTokens,
        system: `You are a Product Owner AI agent writing user stories for an EXISTING software product.

CRITICAL RULES:
1. Read the codebase context carefully — you are ADDING to this product, not inventing a new one.
2. Every story must reference real, existing parts of the codebase (real routes, real screens, real data models).
3. Do NOT write generic or vague stories. Write specific, testable stories grounded in THIS codebase.
4. Generate a MAXIMUM of ${limit} user stories.

## Story Format (MANDATORY)
Each story MUST use the "As a / I would like to / So that" format:
  "user_story": "As a <specific user role>, I would like to <specific action>, so that <specific benefit>"

## INVEST Criteria (MANDATORY — each story must pass ALL)
- Independent: Can be developed/delivered without depending on other stories in this set
- Negotiable: Scope can be adjusted without loss of core value
- Valuable: Directly delivers user or business value
- Estimable: Complexity is clear enough to assign story points (Fibonacci: 1,2,3,5,8,13)
- Small: Can be completed within one sprint
- Testable: Has clear, measurable acceptance criteria

## Acceptance Criteria Format (MANDATORY — Given/When/Then table)
Each acceptance criterion MUST be a structured object with three fields:
  { "given": "system state / precondition", "when": "user action or event", "then": "observable outcome" }
Write 2-4 GWT criteria per story. Each must be specific and testable.

Output ONLY valid JSON — no markdown fences, no comments, no trailing commas:
{
  "epic_summary": "string",
  "epic_description": "string",
  "stories": [
    {
      "summary": "string (short Jira title)",
      "user_story": "As a <role>, I would like to <action>, so that <benefit>",
      "invest_notes": "one sentence — why this story is Independent, Small, and Testable",
      "acceptance_criteria": [
        { "given": "string", "when": "string", "then": "string" }
      ],
      "test_scenarios": {
        "happy_path": ["string"],
        "edge_cases": ["string"],
        "error_states": ["string"]
      },
      "story_points": 1
    }
  ]
}`,
        messages: [{
          role: "user",
          content: `EXISTING PRODUCT CONTEXT:
${codeContext}

PM MEMO (feature analysis):
${pmMemo.slice(0, 2500)}

AGREED SCOPE:
${agreedScope}
${kickbackContext}

Generate an Epic and max ${limit} user stories SPECIFIC to this actual product.
- Use "As a / I would like to / So that" format for every user_story field
- Use Given/When/Then objects for every acceptance_criteria item
- Apply INVEST criteria — each story must be completable in one sprint
- Reference real existing modules, routes, or screens from the codebase context
Output ONLY valid JSON.`,
        }],
      });
      return response.content[0].type === "text" ? response.content[0].text : "{}";
    }, "po-agent");
  }

  let raw = await callPOAgent("5");
  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    // Response may have been truncated — retry with fewer stories
    console.warn("[PO] JSON parse failed (likely truncated), retrying with 3 stories...");
    raw = await callPOAgent("3");
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  }

  const epic   = await createEpic(parsed.epic_summary, parsed.epic_description);
  const stories: UserStory[] = [];

  for (const s of parsed.stories) {
    // Flatten GWT objects to strings for Jira (which expects plain strings)
    const acStrings: string[] = (s.acceptance_criteria ?? []).map((ac: any) =>
      typeof ac === "string"
        ? ac
        : `Given ${ac.given} | When ${ac.when} | Then ${ac.then}`
    );

    const story = await createUserStory({
      key: "",
      summary: s.summary,
      // Store user_story in job_story field for backward compat; also store raw GWT
      job_story: s.user_story ?? s.job_story ?? "",
      acceptance_criteria: acStrings,
      story_points: s.story_points,
      epicKey: epic.key,
      wwa: s.invest_notes ?? s.wwa ?? "",
      test_scenarios: [
        ...(s.test_scenarios?.happy_path ?? []),
        ...(s.test_scenarios?.edge_cases ?? []),
        ...(s.test_scenarios?.error_states ?? []),
      ],
    });

    // Attach the raw structured GWT array for the UI to render as a table
    (story as any).acceptance_criteria_gwt = s.acceptance_criteria ?? [];
    (story as any).user_story = s.user_story ?? s.job_story ?? "";
    (story as any).invest_notes = s.invest_notes ?? "";

    stories.push(story);
  }

  const jiraUrl     = `${integrations.jira.baseUrl}/browse/${epic.key}`;
  const slackThread = await notifyPOForStoryReview(epic.key, jiraUrl);
  const version     = kickbackCount + 1;
  const memoryPath  = `agents/po-agent/memory/runtime/po-v${version}.json`;

  const content: PODeliverable = {
    epic_key:         epic.key,
    epic_summary:     parsed.epic_summary,
    user_stories:     stories,
    story_map_url:    jiraUrl,
    slack_thread_url: slackThread?.ts ?? jiraUrl,
  };

  console.log(`  [PO] Synthesis Complete!`);
  console.log(`  [PO] Epic Created: ${epic.key} — ${parsed.epic_summary}`);
  console.log(`  [PO] Stories (${stories.length}): `);
  stories.forEach((s, i) => console.log(`      ${i+1}. ${s.summary} (${s.story_points} pts)`));
  console.log(`  [PO] View on Jira: ${jiraUrl}`);

  await writeAgentMemory("po-agent", state.feature_id, {
    event:          "po_complete",
    epic_key:       epic.key,
    stories_count:  stories.length,
    kickback_count: kickbackCount,
  });

  // Clear the PO approval so the gate re-prompts the human with the revised stories.
  const { po: _clearPoApproval, ...restApprovals } = (state.human_approvals ?? {}) as any;

  return {
    current_stage:   "po",
    deliverables:    { po: makeDeliverable("po", version, "PODeliverable", content, memoryPath) },
    jira:            { ...state.jira, epic_key: epic.key, story_keys: stories.map(s => s.key) },
    slack:           { ...state.slack, po_thread: slackThread?.ts },
    human_approvals: restApprovals,   // po approval cleared — gate will re-prompt
  };
}
