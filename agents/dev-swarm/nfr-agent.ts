// agents/dev-swarm/nfr-agent.ts — extracted from swarm, uses unified LLM client
import { resolveModel, withFailover } from "../../config/llm-client";
import { AGENT_MODELS }    from "../../config/agents";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import type { PipelineState, NFRItem } from "../../types/state";

export async function runNFRAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const archDeliverable = state.deliverables?.architect?.content as any;
  const devDeliverable  = state.deliverables?.dev_swarm?.content as any;
  const kickbackCount   = state.retry_counts?.nfr ?? 0;

  const cfg = AGENT_MODELS.nfr;
  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system: `You are an NFR review agent (checker SOD role). Output ONLY valid JSON:
{"overall_status":"pass|warn|fail","critical_issues":["string"],"items":[{"category":"latency|db|caching|security|error_handling|rate_limit|observability","requirement":"string","status":"pass|warn|fail","detail":"string","remediation":"specific fix if fail/warn"}],"recommendations":["string"]}`,
      messages: [{ role: "user", content: `ADR:\n${archDeliverable?.adr_content?.slice(0,2000) ?? ""}\n\nDB Changes:\n${archDeliverable?.db_schema_changes?.join("\n") ?? ""}\n\nAPI Contracts:\n${archDeliverable?.api_contracts?.join("\n") ?? ""}\n\nOutput ONLY valid JSON.` }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, "nfr-agent");

  const result     = JSON.parse(raw.replace(/```json|```/g, "").trim());
  const version    = kickbackCount + 1;
  const memoryPath = `agents/nfr-agent/memory/runtime/nfr-v${version}.json`;

  await writeAgentMemory("nfr-agent", state.feature_id, { event: "nfr_complete", overall_status: result.overall_status, critical_issues: result.critical_issues, kickback_count: kickbackCount });
  return { current_stage: "nfr", deliverables: { nfr: makeDeliverable("nfr", version, "NFRDeliverable", result, memoryPath) } };
}
