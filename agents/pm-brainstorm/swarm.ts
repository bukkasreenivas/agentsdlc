// agents/pm-brainstorm/swarm.ts  — updated to use unified LLM client
import { createClient, resolveModel, withFailover } from "../../config/llm-client";
import { AGENT_MODELS }   from "../../config/agents";
import { scanCodebase }   from "../../tools/codebase-scanner";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import type { PipelineState, BrainstormRound, PMBrainstormDeliverable } from "../../types/state";

const PM_AGENTS = [
  { id:"visionary",   label:"Visionary PM",    model_key:"pm_brainstorm", skills:["/strategy","/north-star","OST"],
    system:`You are a Visionary PM. Apply: Opportunity Solution Tree (Teresa Torres), North Star Impact, Product Strategy Fit.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences","ost_opportunity":"string","north_star_impact":"string","pm_skills_used":["string"]}` },
  { id:"critic",      label:"Critic PM",       model_key:"pm_critic",     skills:["/pre-mortem","Tigers/Elephants","identify-assumptions"],
    system:`You are a Devil's Advocate PM. Apply: Pre-mortem, Tigers/Paper Tigers/Elephants, Assumption Prioritization.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences","tigers":["..."],"elephants":["..."],"riskiest_assumption":"string","pm_skills_used":["string"]}` },
  { id:"data",        label:"Data Analyst PM", model_key:"pm_critic",     skills:["RICE","market-sizing","cohorts"],
    system:`You are a Data-driven PM. Apply: RICE, Market Sizing (TAM/SAM/SOM), Cohort Impact, Measurement Plan.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences","rice_score":{"reach":0-10,"impact":0-10,"confidence":0-1,"effort":1-10},"metrics_affected":["..."],"pm_skills_used":["string"]}` },
  { id:"user",        label:"User Advocate PM",model_key:"pm_critic",     skills:["JTBD","personas","journey-map"],
    system:`You are a User-obsessed PM (Teresa Torres continuous discovery). Apply: User Personas, JTBD, Customer Journey Map.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences","primary_persona":"string","jtbd":"When X, I want Y, so I can Z","journey_stage":"string","pm_skills_used":["string"]}` },
  { id:"technical",   label:"Technical PM",    model_key:"pm_critic",     skills:["feasibility","RICE","roadmap"],
    system:`You are a Technical PM bridging product and engineering. Apply: Feasibility Assessment, RICE Score, Sprint Estimation.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences","tech_complexity":"low|medium|high","codebase_concerns":["..."],"sprint_estimate":"string","pm_skills_used":["string"]}` },
];

async function runBrainstormAgent(
  agent: typeof PM_AGENTS[0],
  feature: string,
  codeContext: string,
  previousRounds: BrainstormRound[]
): Promise<BrainstormRound> {
  const cfg = AGENT_MODELS[agent.model_key];
  const previousContext = previousRounds.length > 0
    ? `\n\nPrevious perspectives:\n${previousRounds.map(r => `${r.agent_id}: fit_score=${r.fit_score}, concern: ${r.arguments_against[0] ?? "none"}`).join("\n")}\nRespond to these in your analysis.`
    : "";

  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system:     agent.system,
      messages:   [{ role: "user", content: `Feature: ${feature}\n\nCodebase:\n${codeContext}${previousContext}\n\nOutput ONLY valid JSON.` }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, `pm-brainstorm:${agent.id}`);

  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  return {
    agent_id:          agent.id,
    perspective:       parsed.perspective ?? "",
    fit_score:         parsed.fit_score ?? 5,
    arguments_for:     parsed.arguments_for ?? [],
    arguments_against: parsed.arguments_against ?? [],
    pm_skills_used:    agent.skills,
  };
}

async function runSynthesizer(feature: string, rounds: BrainstormRound[], codeContext: string) {
  const cfg = AGENT_MODELS.pm_synthesizer;
  const roundsSummary = rounds.map(r =>
    `## ${r.agent_id} (fit_score: ${r.fit_score}/10)\n${r.perspective}\nFor: ${r.arguments_for.join("; ")}\nAgainst: ${r.arguments_against.join("; ")}`
  ).join("\n\n");

  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system: `You are a senior PM synthesizer. Read all 5 PM perspectives and produce consensus.
Output ONLY valid JSON: {"consensus":{"build_decision":"proceed|modify|reject","confidence":0.0-1.0,"agreed_scope":"string","open_risks":["..."],"north_star_impact":"string","ost_opportunity":"string"},"pm_memo":"full markdown PM memo"}`,
      messages: [{ role: "user", content: `Feature: ${feature}\n\nPM Brainstorm Rounds:\n${roundsSummary}\n\nCodebase:\n${codeContext.slice(0, 1000)}\n\nSynthesize and decide. Output ONLY valid JSON.` }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, "pm-brainstorm:synthesizer");

  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

export async function runPMBrainstormSwarm(state: PipelineState): Promise<Partial<PipelineState>> {
  const { feature_description, repo_path, feature_id } = state;
  const kickbackCount = state.retry_counts?.pm_brainstorm ?? 0;
  const codeCtx  = await scanCodebase(repo_path);
  const codeContext = `Tech: ${codeCtx.techStack.join(", ")}\n${codeCtx.fileTree.slice(0, 2000)}`;
  const rounds: BrainstormRound[] = [];

  for (const agent of PM_AGENTS) {
    const round = await runBrainstormAgent(agent, feature_description, codeContext, rounds);
    rounds.push(round);
  }

  const { consensus, pm_memo } = await runSynthesizer(feature_description, rounds, codeContext);
  const version     = kickbackCount + 1;
  const memoryPath  = `agents/pm-brainstorm/memory/runtime/pm-brainstorm-v${version}.json`;
  const content: PMBrainstormDeliverable = { feature_id, feature_title: state.feature_title, brainstorm_rounds: rounds, consensus, pm_memo };

  await writeAgentMemory("pm-brainstorm", feature_id, { event: "brainstorm_complete", decision: consensus.build_decision, confidence: consensus.confidence, kickback_count: kickbackCount });
  return { current_stage: "pm_brainstorm", deliverables: { pm_brainstorm: makeDeliverable("pm_brainstorm", version, "PMBrainstormDeliverable", content, memoryPath) } };
}
