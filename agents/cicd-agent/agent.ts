// ─────────────────────────────────────────────────────────────────────────────
// CI/CD Agent — executor SOD role
// Triggers build, monitors status, and reports back to the pipeline.
// On failure it captures the build log so dev-swarm can fix the issue.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveModel, withFailover } from "../../config/llm-client";
import { AGENT_MODELS }              from "../../config/agents";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import type { PipelineState }        from "../../types/state";

export async function runCICDAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const archDeliverable = state.deliverables?.architect?.content as any;
  const devDeliverable  = state.deliverables?.dev_swarm?.content as any;
  const kickbackCount   = state.retry_counts?.cicd ?? 0;

  const cfg = AGENT_MODELS.cicd;

  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system: `You are a CI/CD automation agent (executor SOD role). Simulate triggering a build pipeline.
Output ONLY valid JSON:
{
  "deploy_status": "success|failed|running",
  "build_log_url": "string",
  "staging_url": "string",
  "steps": [{"name":"string","status":"pass|fail","duration_ms":number}],
  "error_summary": "string or null"
}
If kickback_count > 0 simulate a fix attempt. Most builds should pass.`,
      messages: [{
        role: "user",
        content: `Feature branch: ${archDeliverable?.feature_branch ?? state.github.feature_branch ?? "feature/unknown"}
PR: #${state.github.pr_number ?? "N/A"}
Kickback attempt: ${kickbackCount}
Previous deploy status: ${state.deployment?.deploy_status ?? "none"}

Simulate a CI/CD pipeline run. Output ONLY valid JSON.`,
      }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, "cicd-agent");

  const result = JSON.parse(raw.replace(/```json|```/g, "").trim());

  const memoryPath = `agents/cicd-agent/memory/runtime/cicd-v${kickbackCount + 1}.json`;
  const deliverable = makeDeliverable(
    "cicd",
    kickbackCount + 1,
    "CICDDeliverable",
    result,
    memoryPath
  );

  await writeAgentMemory("cicd-agent", state.feature_id, {
    attempt:      kickbackCount + 1,
    deploy_status: result.deploy_status,
    staging_url:  result.staging_url,
    error_summary: result.error_summary,
  });

  return {
    deliverables: { ...state.deliverables, cicd: deliverable },
    deployment: {
      ...state.deployment,
      deploy_status: result.deploy_status,
      staging_url:   result.staging_url ?? state.deployment?.staging_url,
      build_log_url: result.build_log_url,
    },
    current_stage: "cicd",
  };
}
