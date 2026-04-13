// agents/po-agent/agent.ts — updated to use unified LLM client
import { createClient, resolveModel, withFailover } from "../../config/llm-client";
import { AGENT_MODELS }   from "../../config/agents";
import { createEpic, createUserStory } from "../../integrations/jira";
import { notifyPOForStoryReview }      from "../../integrations/slack";
import { integrations }                from "../../config/integrations";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import type { PipelineState, PODeliverable, UserStory, KickbackRecord } from "../../types/state";

export async function runPOAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const pmDeliverable  = state.deliverables?.pm_brainstorm?.content as any;
  const pmMemo: string = pmDeliverable?.pm_memo ?? "";
  const kickbackCount  = state.retry_counts?.po ?? 0;
  const lastKickback   = state.kickbacks.findLast((k: KickbackRecord) => k.stage === "po");
  const kickbackContext = lastKickback
    ? `\n\nIMPORTANT — Revision ${kickbackCount}. Previous rejected.\nReason: ${lastKickback.detail}\nFix: ${lastKickback.actionable}`
    : "";

  const cfg = AGENT_MODELS.po;

  async function callPOAgent(limit: string): Promise<string> {
    return withFailover(async (client) => {
      const response = await client.messages.create({
        model:      resolveModel(cfg.model),
        max_tokens: cfg.maxTokens,
        system: `You are a Product Owner AI agent applying pm-skills frameworks.
For each story apply: User Story + Job Story (When/Want/So) + WWA (Why-What-Acceptance) + Test Scenarios.
IMPORTANT: Generate a MAXIMUM of ${limit} user stories. Keep each story concise (2-3 acceptance criteria, 1-2 test scenarios each). Prioritise the most critical stories.
Output ONLY valid JSON — no markdown, no comments, no trailing commas:
{"epic_summary":"string","epic_description":"string","stories":[{"summary":"string","job_story":"string","wwa":"string","acceptance_criteria":["string"],"test_scenarios":{"happy_path":["string"],"edge_cases":["string"],"error_states":["string"]},"story_points":number}]}`,
        messages: [{ role: "user", content: `PM Memo:\n${pmMemo.slice(0, 3000)}${kickbackContext}\n\nGenerate Epic and max ${limit} Stories. Output ONLY valid JSON.` }],
      });
      return response.content[0].type === "text" ? response.content[0].text : "{}";
    }, "po-agent");
  }

  let raw = await callPOAgent("5");
  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    // Response may have been truncated — retry asking for fewer stories
    console.warn("[PO] JSON parse failed (likely truncated), retrying with 3 stories...");
    raw = await callPOAgent("3");
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  }
  const epic   = await createEpic(parsed.epic_summary, parsed.epic_description);
  const stories: UserStory[] = [];

  for (const s of parsed.stories) {
    const story = await createUserStory({
      key: "", summary: s.summary, acceptance_criteria: s.acceptance_criteria,
      story_points: s.story_points, epicKey: epic.key, job_story: s.job_story,
      wwa: s.wwa, test_scenarios: [...s.test_scenarios.happy_path, ...s.test_scenarios.edge_cases, ...s.test_scenarios.error_states],
    });
    stories.push(story);
  }

  const jiraUrl     = `${integrations.jira.baseUrl}/browse/${epic.key}`;
  const slackThread = await notifyPOForStoryReview(epic.key, jiraUrl);
  const version     = kickbackCount + 1;
  const memoryPath  = `agents/po-agent/memory/runtime/po-v${version}.json`;

  const content: PODeliverable = { epic_key: epic.key, epic_summary: parsed.epic_summary, user_stories: stories, story_map_url: jiraUrl, slack_thread_url: slackThread?.ts ?? jiraUrl };
  await writeAgentMemory("po-agent", state.feature_id, { event: "po_complete", epic_key: epic.key, stories_count: stories.length, kickback_count: kickbackCount });

  return {
    current_stage: "po",
    deliverables:  { po: makeDeliverable("po", version, "PODeliverable", content, memoryPath) },
    jira:          { ...state.jira, epic_key: epic.key, story_keys: stories.map(s => s.key) },
    slack:         { ...state.slack, po_thread: slackThread?.ts },
  };
}
