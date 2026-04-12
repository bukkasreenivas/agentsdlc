// agents/architect-agent/agent.ts — updated to use unified LLM client
import { resolveModel, withFailover } from "../../config/llm-client";
import { AGENT_MODELS }    from "../../config/agents";
import { scanCodebase }    from "../../tools/codebase-scanner";
import { createBranch }    from "../../integrations/github";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import type { PipelineState, ArchitectureDeliverable } from "../../types/state";
import * as fs   from "fs";
import * as path from "path";

export async function runArchitectAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const poDeliverable  = state.deliverables?.po?.content as any;
  const kickbackCount  = state.retry_counts?.architect ?? 0;
  const reviewKickback = state.kickbacks.findLast(k => k.stage === "review");
  const nfrKickback    = state.kickbacks.findLast(k => k.stage === "nfr");
  const kickbackContext = [reviewKickback, nfrKickback].filter(Boolean)
    .map(k => `KICKBACK from ${k!.stage}: ${k!.actionable}`).join("\n");

  const codeCtx    = await scanCodebase(state.repo_path);
  const branchName = state.github.feature_branch
    ?? `feature/${state.jira.epic_key?.toLowerCase()}-${Date.now()}`;

  const cfg = AGENT_MODELS.architect;
  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system: `You are a principal architect AI. Output ONLY valid JSON:
{"adr_content":"full markdown ADR","frontend_tasks":[{"id":"FE-1","description":"string","file_paths":["src/..."],"agent":"frontend","model":"gemini-2.0-flash","estimated_loc":50,"test_file_paths":["src/__tests__/..."]}],"backend_tasks":[{"id":"BE-1","description":"string","file_paths":["src/..."],"agent":"backend","model":"claude-sonnet-4-20250514","estimated_loc":50,"test_file_paths":["src/__tests__/..."]}],"db_schema_changes":["string"],"api_contracts":["string"]}
ADR must cover: Context, Decision, Consequences, Patterns Followed, NFR Requirements.`,
      messages: [{ role: "user", content: `Epic: ${poDeliverable?.epic_summary}\nStories: ${(poDeliverable?.user_stories ?? []).map((s: any) => s.summary).join("; ")}\nCodebase:\nTech: ${codeCtx.techStack.join(", ")}\n${codeCtx.fileTree.slice(0,3000)}\n${kickbackContext ? `\n--- KICKBACK ---\n${kickbackContext}` : ""}\n\nOutput ONLY valid JSON.` }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, "architect-agent");

  const plan = JSON.parse(raw.replace(/```json|```/g, "").trim());
  if (!state.github.feature_branch) await createBranch(branchName);

  const version  = kickbackCount + 1;
  const adrPath  = path.join(process.cwd(), `agents/architect-agent/memory/runtime/adr-v${version}.md`);
  fs.mkdirSync(path.dirname(adrPath), { recursive: true });
  fs.writeFileSync(adrPath, plan.adr_content);

  const memoryPath = `agents/architect-agent/memory/runtime/arch-v${version}.json`;
  const content: ArchitectureDeliverable = { adr_path: `agents/architect-agent/memory/runtime/adr-v${version}.md`, adr_content: plan.adr_content, feature_branch: branchName, frontend_tasks: plan.frontend_tasks ?? [], backend_tasks: plan.backend_tasks ?? [], db_schema_changes: plan.db_schema_changes ?? [], api_contracts: plan.api_contracts ?? [] };

  await writeAgentMemory("architect-agent", state.feature_id, { event: "arch_complete", branch: branchName, fe_tasks: plan.frontend_tasks?.length, be_tasks: plan.backend_tasks?.length, kickback_count: kickbackCount });
  return { current_stage: "architect", deliverables: { architect: makeDeliverable("architect", version, "ArchitectureDeliverable", content, memoryPath) }, github: { ...state.github, feature_branch: branchName } };
}
