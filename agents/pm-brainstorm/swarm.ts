// agents/pm-brainstorm/swarm.ts  — v3: Strategic Discovery Lab
import * as fs from "fs";
import * as path from "path";
import { resolveModel, withFailover } from "../../config/llm-client";
import { AGENT_MODELS }   from "../../config/agents";
import { scanCodebase }   from "../../tools/codebase-scanner";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import { extractAllFromDir } from "../../tools/data-parser";
import { featuresDir, syncFromPipelineState } from "../../orchestrator/feature-store";
import type { PipelineState, BrainstormRound, PMBrainstormDeliverable, DiscoveryDeliverable } from "../../types/state";

/** Robust JSON parser that handles markdown fences and trailing noise */
function safeJSONParse(raw: string, fallback: any = {}): any {
  try {
    const clean = raw.trim().replace(/^```json/, "").replace(/```$/, "").trim();
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      return JSON.parse(clean.substring(start, end + 1));
    }
    return JSON.parse(clean);
  } catch (err) {
    console.warn(` [safeJSONParse] Failed to parse: ${(err as any).message}. Retrying simple repair...`);
    try {
        let repair = raw.trim();
        if (repair.endsWith('...')) repair = repair.substring(0, repair.length - 3) + '"}';
        if (!repair.endsWith('}')) repair += '}';
        return JSON.parse(repair);
    } catch {
        return fallback;
    }
  }
}

const PM_AGENTS = [
  { id:"visionary",   label:"Visionary PM",    model_key:"pm_brainstorm", skills:["/lean-canvas","/value-proposition","OST"],
    system:`You are a Discovery PM identifying architectural needs for an EXISTING product.
CRITICAL: Use the LEAN CANVAS and VALUE PROPOSITION frameworks.
1. Map the new feature to EXISTING USER PERSONAS and RBAC (Roles).
2. Propose a high-level integration plan using the Opportunity Solution Tree (OST).
3. If in DISCOVERY MODE: Synthesize raw customer signals into actionable feature ideas.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Integration strategy","ost_opportunity":"string","north_star_impact":"string","lean_canvas":{"problem":"string","solution":"string","unique_value_prop":"string","unfair_advantage":"string"},"pm_skills_used":["string"]}` },
  { id:"critic",      label:"Critic PM",       model_key:"pm_critic",     skills:["/identify-assumptions","/prioritize-assumptions","risk-mapping"],
    system:`You are a Devil's Advocate PM focused on RISK & SECURITY for an EXISTING product.
CRITICAL: IDENTIFY and PRIORITIZE ASSUMPTIONS.
1. What EXISTING dependencies/APIs could break?
2. Are there any security or permission (RBAC) concerns?
3. Rank assumptions by (Uncertainty x Impact).
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Security analysis","riskiest_assumptions":[{"assumption":"string","impact":1-10,"uncertainty":1-10}],"tigers":["..."],"pm_skills_used":["string"]}` },
  { id:"data",        label:"Data Analyst PM", model_key:"pm_critic",     skills:["RICE","sentiment-analysis","cohorts"],
    system:`You are a Data-driven PM. Reference real existing metrics and data models.
1. How does this affect the existing database schema?
2. If in DISCOVERY MODE: Perform SENTIMENT ANALYSIS on raw customer feedback.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Data impact","sentiment_summary":"string","rice_score":{"reach":0-10,"impact":0-10,"confidence":0.1-1.0,"effort":1-10},"pm_skills_used":["string"]}` },
  { id:"market",      label:"Market Intelligence",model_key:"pm_critic",     skills:["/competitor-analysis","SWOT","stay-afloat"],
    system:`You are a Market Intelligence PM focused on SWOT and Market Parity.
1. Research the market for the provided competitors.
2. Identify "STAY AFLOAT" features (Market Parity) vs "GROWTH" features.
3. Generate a SWOT analysis for this feature/area.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Market analysis","swot":{"strengths":[],"weaknesses":[],"opportunities":[],"threats":[]},"market_parity_features":["..."],"pm_skills_used":["string"]}` },
  { id:"user",        label:"User Advocate PM",model_key:"pm_critic",     skills:["JTBD","personas","journey-map"],
    system:`You are a User Advocate identifying UX and ROLE-BASED personas.
1. Which specific User Persona from the ACTUAL product is the primary beneficiary?
2. How does the user's role/permission level change the experience?
3. Map the JTBD (Jobs to be done) grounded in real app workflows.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"User journey","primary_persona":"string","jtbd":"When X, I want Y, so I can Z","journey_stage":"string","pm_skills_used":["string"]}` },
  { id:"technical",   label:"Technical PM",    model_key:"pm_critic",     skills:["feasibility","RICE","roadmap"],
    system:`You are a Technical PM identifying API DEPENDENCIES and FEASIBILITY.
1. List all EXISTING internal/external API dependencies this feature relies on.
2. Estimate effort based on the technical complexity of existing modules.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Technical report","tech_complexity":"low|medium|high","codebase_concerns":["..."],"sprint_estimate":"string","pm_skills_used":["string"]}` },
];

function extractKeywords(featureDesc: string): string[] {
  const stopWords = new Set(["a","an","the","is","it","in","on","at","to","for","of","and","or","but","with","as","be","by","from","that","this","have","has","not","are","was","were","will"]);
  return featureDesc.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w)).slice(0, 10);
}

function buildCodeContext(codeCtx: Awaited<ReturnType<typeof scanCodebase>>): string {
  const parts: string[] = [];
  parts.push("=== WHAT THIS PRODUCT IS ===");
  parts.push(codeCtx.projectIdentity);
  if (codeCtx.apiRoutes.length > 0) parts.push("\n=== EXISTING API ENDPOINTS ===\n" + codeCtx.apiRoutes.slice(0, 15).join("\n"));
  parts.push("\n=== PROJECT FILE STRUCTURE ===\n" + codeCtx.fileTree.slice(0, 2000));
  return parts.join("\n");
}

async function runBrainstormAgent(
  agent: typeof PM_AGENTS[0],
  state: PipelineState,
  codeContext: string,
  previousRounds: BrainstormRound[],
  strategyContext: string,
  supplementaryData: string
): Promise<BrainstormRound> {
  const cfg = AGENT_MODELS[agent.model_key];
  const previousSum = previousRounds.map(r => `${r.agent_id}: ${r.perspective.substring(0, 50)}`).join("\n");
  
  const raw: any = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system:     agent.system,
      messages:   [{ 
        role: "user", 
        content: `Feature request: ${state.feature_description}\n\nEXISTING CODEBASE CONTEXT:\n${codeContext}\n\nPREVIOUS PERSPECTIVES:\n${previousSum}\n\nSIGNALS:\n${supplementaryData}` 
      }],
    });
    return { text: response.content[0].type === "text" ? response.content[0].text : "{}" };
  }, `pm:${agent.id}`);

  const parsed = safeJSONParse(raw.text, { perspective: "Error parsing agent response", fit_score: 5, arguments_for: [], arguments_against: [] });
  return { 
    agent_id: agent.id, 
    perspective: parsed.perspective || "No analysis provided", 
    fit_score: parsed.fit_score || 5, 
    arguments_for: parsed.arguments_for || [], 
    arguments_against: parsed.arguments_against || [], 
    pm_skills_used: agent.skills,
    ...parsed 
  };
}

async function runSynthesizer(
  feature: string,
  rounds: BrainstormRound[],
  codeContext: string,
  supplementaryData: string,
  chatHistory: any[] = []
) {
  const cfg = AGENT_MODELS.pm_synthesizer;
  const roundsSummary = rounds.map(r => `## ${r.agent_id} (fit_score: ${r.fit_score}/10)\n${r.perspective}`).join("\n\n");
  
  const raw: any = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system:     `You are a senior PM synthesizer for an EXISTING product. Output ONLY valid JSON: {"consensus":{"build_decision":"proceed|modify|reject","confidence":0.0-1.0,"agreed_scope":"string","open_risks":["..."],"north_star_impact":"string","ost_opportunity":"string"},"pm_memo":"markdown memo"}`,
      messages:   [{ role: "user", content: `Synthesize Feature: ${feature}\nRounds:\n${roundsSummary}\n\nChat:\n${JSON.stringify(chatHistory)}` }],
    });
    return { text: response.content[0].type === "text" ? response.content[0].text : "{}" };
  }, "pm:synthesizer");

  const synthesizedRaw = raw.text || "{}";
  const { consensus, pm_memo } = safeJSONParse(synthesizedRaw, { 
    consensus: { build_decision: "proceed", confidence: 0.5, agreed_scope: "Parsing Error", open_risks: [], north_star_impact: "", ost_opportunity: "" }, 
    pm_memo: "An error occurred while parsing the agent's PRD synthesis." 
  });

  return { consensus, pm_memo };
}

async function runDiscoverySynthesizer(
  rounds: BrainstormRound[],
  codeContext: string,
  supplementaryData: string
): Promise<DiscoveryDeliverable> {
  const cfg = AGENT_MODELS.pm_synthesizer;
  const roundsSummary = rounds.map(r => `## ${r.agent_id}\n${r.perspective}`).join("\n\n");
  
  const raw: any = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system:     `You are a Strategic Discovery PM. Synthesize signals into a Discovery Report. Output JSON.`,
      messages:   [{ role: "user", content: `ANALYSIS ROUNDS:\n${roundsSummary}\n\nRAW SIGNALS:\n${supplementaryData}` }],
    });
    return { text: response.content[0].type === "text" ? response.content[0].text : "{}" };
  }, "pm:discovery");

  const synthesizedRaw = raw.text || "{}";
  return safeJSONParse(synthesizedRaw, { 
    feature_id: "temp",
    signals_count: 0, 
    sentiment_score: 0.5,
    swot: { strengths: [], weaknesses: [], opportunities: [], threats: [] }, 
    ost: [], 
    discovery_memo: "Failed to synthesize discovery report.",
    competitors_searched: [] 
  });
}

export async function runPMBrainstormSwarm(state: PipelineState): Promise<Partial<PipelineState>> {
  const { feature_description, repo_path, feature_id } = state;
  const kickbackCount = state.retry_counts?.pm_brainstorm ?? 0;
  
  const codeCtx = await scanCodebase(repo_path, extractKeywords(feature_description));
  const codeContext = buildCodeContext(codeCtx);
  
  const storeType = state.pipeline_mode === "feature" ? "features" : "ideas";
  const attachmentsDir = path.join(featuresDir(storeType), feature_id, "attachments");
  const extracted = await extractAllFromDir(attachmentsDir);
  const supplementaryData = extracted.map(e => `FILE: ${e.filename}\n${e.content}`).join("\n---\n");

  const rounds: BrainstormRound[] = [];
  for (const agent of PM_AGENTS) {
    console.log(`  [PM] Running ${agent.label}...`);
    rounds.push(await runBrainstormAgent(agent, state, codeContext, rounds, "", supplementaryData));
  }

  const existingDeliverable = state.deliverables?.pm_brainstorm?.content as PMBrainstormDeliverable;
  const chatHistory = existingDeliverable?.chat_history || [];

  if (state.pipeline_mode === "discovery") {
    console.log(`  [PM] Synthesizing Strategic Discovery Report...`);
    const discoveryObj = await runDiscoverySynthesizer(rounds, codeContext, supplementaryData);
    discoveryObj.feature_id = feature_id;
    return { 
      deliverables: { 
        ...state.deliverables, 
        pm_brainstorm: makeDeliverable("pm_brainstorm", kickbackCount + 1, "DiscoveryDeliverable", discoveryObj, "") 
      } 
    };
  }

  const { consensus, pm_memo } = await runSynthesizer(feature_description, rounds, codeContext, supplementaryData, chatHistory);
  const content: PMBrainstormDeliverable = { 
    feature_id, 
    feature_title: state.feature_title, 
    brainstorm_rounds: rounds, 
    consensus, 
    pm_memo, 
    chat_history: chatHistory 
  };
  
  return { 
    current_stage: "pm_brainstorm", 
    deliverables: { 
      pm_brainstorm: makeDeliverable("pm_brainstorm", kickbackCount + 1, "PMBrainstormDeliverable", content, "") 
    } 
  };
}
