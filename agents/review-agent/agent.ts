// agents/review-agent/agent.ts — updated to use unified LLM client
import { resolveModel, withFailover } from "../../config/llm-client";
import { AGENT_MODELS }   from "../../config/agents";
import { approvePR, createPRReviewComment } from "../../integrations/github";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import type { PipelineState } from "../../types/state";

export async function runReviewAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const archDeliverable = state.deliverables?.architect?.content as any;
  const nfrDeliverable  = state.deliverables?.nfr?.content as any;
  const kickbackCount   = state.retry_counts?.review ?? 0;

  const cfg = AGENT_MODELS.reviewer;
  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system: `You are a senior architect peer reviewer (checker SOD — you did not write this code).
Review against: ADR compliance, NFR report, test coverage, API contracts, DB schema, error handling.
Output ONLY valid JSON: {"decision":"approved|changes_requested","sod_validated":true,"nfr_compliance":boolean,"coverage_pct":number,"comments":[{"file":"string","line":null,"severity":"blocking|suggestion|nitpick","body":"string","resolved":false}]}
Mark approved ONLY if zero blocking comments.`,
      messages: [{ role: "user", content: `ADR:\n${archDeliverable?.adr_content?.slice(0,2000) ?? ""}\n\nNFR Report:\n${JSON.stringify(nfrDeliverable,null,2).slice(0,800)}\n\nPR: #${state.github.pr_number}\n\nReview. Output ONLY valid JSON.` }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, "review-agent");

  const result  = JSON.parse(raw.replace(/```json|```/g, "").trim());
  const blocking = result.comments?.filter((c: any) => c.severity === "blocking") ?? [];

  if (state.github.pr_number) {
    if (result.decision === "approved") {
      await approvePR(state.github.pr_number).catch(() => {});
    } else {
      await createPRReviewComment(state.github.pr_number, blocking.map((c: any) => `**${c.file}**: ${c.body}`).join("\n\n")).catch(() => {});
    }
  }

  const version    = kickbackCount + 1;
  const memoryPath = `agents/review-agent/memory/runtime/review-v${version}.json`;
  await writeAgentMemory("review-agent", state.feature_id, { event: "review_complete", decision: result.decision, blocking_count: blocking.length, kickback_count: kickbackCount });

  return { current_stage: "review", deliverables: { review: makeDeliverable("review", version, "ReviewDeliverable", { ...result, pr_number: state.github.pr_number, pr_url: state.github.pr_url }, memoryPath) } };
}
