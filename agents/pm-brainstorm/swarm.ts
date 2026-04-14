// agents/pm-brainstorm/swarm.ts  — v3: grounded in real codebase
// Agents read actual project files (README, entry points, routers, models)
// before analysing the feature so they never hallucinate a different product.
import * as fs from "fs";
import * as path from "path";
import { resolveModel, withFailover } from "../../config/llm-client";
import { AGENT_MODELS }   from "../../config/agents";
import { scanCodebase }   from "../../tools/codebase-scanner";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import { extractAllFromDir } from "../../tools/data-parser";
import { featuresDir, syncFromPipelineState } from "../../orchestrator/feature-store";
import type { PipelineState, BrainstormRound, PMBrainstormDeliverable } from "../../types/state";

/** Robust JSON parser that handles markdown fences and trailing noise */
function safeJSONParse(raw: string, fallback: any = {}): any {
  try {
    const clean = raw.trim().replace(/^```json/, "").replace(/```$/, "").trim();
    // Try finding the first { and last }
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      return JSON.parse(clean.substring(start, end + 1));
    }
    return JSON.parse(clean);
  } catch (err) {
    console.warn(` [safeJSONParse] Failed to parse: ${err.message}. Retrying simple repair...`);
    try {
        // Attempt very simple repair for unterminated strings if possible
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
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Integration strategy grounded in real files","ost_opportunity":"string","north_star_impact":"string","lean_canvas":{"problem":"string","solution":"string","unique_value_prop":"string","unfair_advantage":"string"},"pm_skills_used":["string"]}` },
  { id:"critic",      label:"Critic PM",       model_key:"pm_critic",     skills:["/identify-assumptions","/prioritize-assumptions","risk-mapping"],
    system:`You are a Devil's Advocate PM focused on RISK & SECURITY for an EXISTING product.
CRITICAL: IDENTIFY and PRIORITIZE ASSUMPTIONS.
1. What EXISTING dependencies/APIs could break?
2. Are there any security or permission (RBAC) concerns?
3. Rank assumptions by (Uncertainty x Impact).
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Security and risk analysis","riskiest_assumptions":[{"assumption":"string","impact":1-10,"uncertainty":1-10}],"tigers":["..."],"pm_skills_used":["string"]}` },
  { id:"data",        label:"Data Analyst PM", model_key:"pm_critic",     skills:["RICE","sentiment-analysis","cohorts"],
    system:`You are a Data-driven PM. Reference real existing metrics and data models.
1. How does this affect the existing database schema?
2. If in DISCOVERY MODE: Perform SENTIMENT ANALYSIS on raw customer feedback.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Data & schema impact","sentiment_summary":"string","rice_score":{"reach":0-10,"impact":0-10,"confidence":0.1-1.0,"effort":1-10},"pm_skills_used":["string"]}` },
  { id:"market",      label:"Market Intelligence",model_key:"pm_critic",     skills:["/competitor-analysis","SWOT","stay-afloat"],
    system:`You are a Market Intelligence PM focused on COMPETITOR ANALYSIS and SWOT.
1. Research the market for the provided competitors.
2. Identify "STAY AFLOAT" features (Market Parity) vs "GROWTH" features.
3. Generate a SWOT analysis for this feature/area.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Market & Competitor analysis","swot":{"strengths":[],"weaknesses":[],"opportunities":[],"threats":[]},"market_parity_features":["..."],"pm_skills_used":["string"]}` },
  { id:"user",        label:"User Advocate PM",model_key:"pm_critic",     skills:["JTBD","personas","journey-map"],
    system:`You are a User Advocate identifying UX and ROLE-BASED personas.
1. Which specific User Persona from the ACTUAL product is the primary beneficiary?
2. How does the user's role/permission level change the experience?
3. Map the JTBD (Jobs to be done) grounded in real app workflows.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"User persona and role-based journey","primary_persona":"string","jtbd":"When X, I want Y, so I can Z","journey_stage":"string","pm_skills_used":["string"]}` },
  { id:"technical",   label:"Technical PM",    model_key:"pm_critic",     skills:["feasibility","RICE","roadmap"],
    system:`You are a Technical PM identifying API DEPENDENCIES and FEASIBILITY.
1. List all EXISTING internal/external API dependencies this feature relies on.
2. Estimate effort based on the technical complexity of existing modules.
3. Identify potential refactoring needs in the current codebase.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"Technical dependency and complexity report","tech_complexity":"low|medium|high","codebase_concerns":["..."],"sprint_estimate":"string","pm_skills_used":["string"]}` },
];

/** Extract meaningful keywords from the feature description for file relevance scoring */
function extractKeywords(featureDesc: string): string[] {
  const stopWords = new Set([
    "a","an","the","is","it","in","on","at","to","for","of","and","or","but","with",
    "as","be","by","from","that","this","have","has","not","are","was","were","will",
    "can","could","would","should","new","add","create","build","make","feature","when",
    "want","so","i","we","our","my","need","use","get","give","allow","enable","support",
  ]);
  return featureDesc
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .slice(0, 10);
}

/** Build the full codebase context block sent to every PM agent */
function buildCodeContext(codeCtx: Awaited<ReturnType<typeof scanCodebase>>): string {
  const parts: string[] = [];

  parts.push("=== WHAT THIS PRODUCT IS ===");
  parts.push(codeCtx.projectIdentity);

  if (codeCtx.apiRoutes.length > 0) {
    parts.push("\n=== EXISTING API ENDPOINTS ===");
    parts.push(codeCtx.apiRoutes.slice(0, 15).join("\n"));
  }

  if (codeCtx.dbSchema.length > 0) {
    parts.push("\n=== DATABASE SCHEMA FILES ===");
    parts.push(codeCtx.dbSchema.join("\n"));
  }

  parts.push("\n=== PROJECT FILE STRUCTURE ===");
  parts.push(codeCtx.fileTree.slice(0, 2000));

  // Key file excerpts (README, entry points, sample routes, models)
  if (codeCtx.keyFileExcerpts.length > 0) {
    parts.push("\n=== KEY FILE CONTENTS ===");
    for (const kf of codeCtx.keyFileExcerpts) {
      parts.push(`\n-- ${kf.path} (${kf.reason}) --\n${kf.content}`);
    }
  }

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
  const previousContext = previousRounds.length > 0
    ? `\n\nPrevious perspectives:\n${previousRounds.map(r => `${r.agent_id}: fit_score=${r.fit_score}, concern: ${r.arguments_against[0] ?? "none"}`).join("\n")}\nRespond to these in your analysis.`
    : "";

  const modeContext = state.pipeline_mode === "discovery"
    ? `\n\nPIPELINE MODE: STRATEGIC DISCOVERY
Focus: Analyzing raw customer signals/tickets and competitor benchmarks.
1. Synthesize raw feedback into THEMES.
2. Use Opportunity Solution Tree (OST) to map outcomes to feature opportunities.
3. Identify "Stay Afloat" features (market parity).`
    : state.pipeline_mode === "idea"
    ? `\n\nPIPELINE MODE: IDEA PIPELINE (Discovery & Strategy)
Focus: Synthesizing raw customer feedback into a pristine opportunity. 
1. Use LEAN CANVAS and JTBD frameworks.
2. Define how this fits with existing RBAC and USER ROLES.`
    : `\n\nPIPELINE MODE: FEATURE EXECUTION
Focus: Validating a confirmed requirement before handing off to PO for engineering.
Required PM Tools: Assumption Mapping, RICE prioritization, Pre-mortems.`;

  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system:     agent.system,
      messages:   [{
        role: "user",
        content: `You are adding this feature to the EXISTING product shown below.
Feature request: ${state.feature_description}
${modeContext}

=== GLOBAL STRATEGY & COMPETITORS ===
${strategyContext}

=== SUPPLEMENTARY DATA (User Feedback / Metrics) ===
${supplementaryData || "No supplementary data files provided."}

EXISTING CODEBASE CONTEXT (read carefully before analysing):
${codeContext}
${previousContext}

Remember: every point in your response must relate to THIS actual product, not a hypothetical one.
Output ONLY valid JSON.`,
      }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, `pm-brainstorm:${agent.id}`);

  const parsed = safeJSONParse(raw, { perspective: "Error parsing agent response", fit_score: 5, arguments_for: [], arguments_against: [] });
  return {
    agent_id:          agent.id,
    perspective:       parsed.perspective ?? "",
    fit_score:         parsed.fit_score ?? 5,
    arguments_for:     parsed.arguments_for ?? [],
    arguments_against: parsed.arguments_against ?? [],
    pm_skills_used:    agent.skills,

    // Extraction of discovery/strategy fields
    swot:                 parsed.swot,
    sentiment_summary:    parsed.sentiment_summary,
    riskiest_assumptions: parsed.riskiest_assumptions,
    lean_canvas:          parsed.lean_canvas,
    market_parity_features: parsed.market_parity_features,
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
  const roundsSummary = rounds.map(r =>
    `## ${r.agent_id} (fit_score: ${r.fit_score}/10)\n${r.perspective}\nFor: ${r.arguments_for.join("; ")}\nAgainst: ${r.arguments_against.join("; ")}`
  ).join("\n\n");

  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system: `You are a senior PM synthesizer for an EXISTING product.
Your pm_memo must describe the feature as an ADDITION to the existing codebase —
reference real modules, routes, and data models from the codebase context.
Do NOT invent a different product. Do NOT write generic feature descriptions.

build_decision rules:
- "proceed" — feature is valid and ready to build (use this for most well-defined features)
- "reject"  — feature conflicts with strategy or is clearly wrong (rare)
- "modify"  — ONLY if critical scope ambiguity exists AND this is the first iteration (avoid loops)

Output ONLY valid JSON:
{"consensus":{"build_decision":"proceed|modify|reject","confidence":0.0-1.0,"agreed_scope":"string","open_risks":["..."],"north_star_impact":"string","ost_opportunity":"string"},"pm_memo":"full markdown PM memo that references real existing code"}`,
      messages: [{
        role: "user",
        content: `Feature to add to EXISTING product: ${feature}

EXISTING CODEBASE CONTEXT:
${codeContext.slice(0, 2000)}

PM Brainstorm Rounds:
${roundsSummary}

=== SUPPLEMENTARY DATA (User Feedback / Metrics) ===
${supplementaryData || "No supplementary data files provided."}

=== USER FEEDBACK & CHAT HISTORY (ACTION REQUIRED) ===
${chatHistory.length > 0 ? chatHistory.map(m => `[${m.role}] ${m.text}`).join("\n") : "No user chat history. Use the brainstorm rounds as primary source."}

Synthesize and write a pm_memo grounded in the real product and data. 
If user chat history is present, PRIORITIZE the user's instructions and modify the PRD accordingly.
Output ONLY valid JSON.`,
      }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, "pm-brainstorm:synthesizer");

async function runDiscoverySynthesizer(
  rounds: BrainstormRound[],
  codeContext: string,
  supplementaryData: string,
) {
  const cfg = AGENT_MODELS.pm_synthesizer;
  const roundsSummary = rounds.map(r =>
    `## ${r.agent_id}\n${r.perspective}`
  ).join("\n\n");

  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system: `You are a Strategic Discovery PM. Your goal is to synthesize raw customer signals and competitor benchmark into a Discovery Report.
Output ONLY valid JSON:
{
  "signals_count": number,
  "sentiment_score": 0.0-1.0,
  "swot": { "strengths": [], "weaknesses": [], "opportunities": [], "threats": [] },
  "ost": [
    { "outcome": "string", "opportunities": [{ "title": "string", "description": "string", "rationale": "string", "market_parity": boolean }] }
  ],
  "discovery_memo": "markdown summary of the strategic landscape"
}`,
      messages: [{
        role: "user",
        content: `STRATEGIC DISCOVERY FOR EXISTING PRODUCT
        
EXISTING CODEBASE CONTEXT:
${codeContext.slice(0, 2000)}

ANALYSIS ROUNDS:
${roundsSummary}

RAW SIGNALS (Feedback/Tickets):
${supplementaryData}`,
      }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, "pm-discovery:synthesizer");

  return safeJSONParse(raw, { signals_count: 0, swot: { strengths: [], weaknesses: [], opportunities: [], threats: [] }, ost: [], discovery_memo: "Failed to synthesize discovery report." });
}

export async function runPMBrainstormSwarm(state: PipelineState): Promise<Partial<PipelineState>> {
  const { feature_description, repo_path, feature_id } = state;
  const kickbackCount = state.retry_counts?.pm_brainstorm ?? 0;

  // Extract keywords from feature description for relevance scoring
  const keywords = extractKeywords(feature_description);
  console.log(`  [PM] Scanning codebase at: ${repo_path}`);
  console.log(`  [PM] Feature keywords: ${keywords.join(", ")}`);

  const codeCtx     = await scanCodebase(repo_path, keywords);
  const codeContext = buildCodeContext(codeCtx);

  // Load Strategy Context
  const strategyDir = path.join(__dirname, "../../../memory/strategy");
  let strategyContext = "";
  if (fs.existsSync(path.join(strategyDir, "project_context.md"))) {
    strategyContext += fs.readFileSync(path.join(strategyDir, "project_context.md"), "utf8");
  } else {
    strategyContext += "No global strategy file found. Please run Strategy Sync.";
  }
  if (fs.existsSync(path.join(strategyDir, "competitor_analysis.md"))) {
    strategyContext += "\n\n=== COMPETITOR STRATEGY ===\n" + fs.readFileSync(path.join(strategyDir, "competitor_analysis.md"), "utf8");
  }

  console.log(`  [PM] API routes found: ${codeCtx.apiRoutes.length}`);

  const storeType = state.pipeline_mode === "feature" ? "features" : "ideas";

  // Load Supplementary Data (Uploaded files)
  const attachmentsDir = path.join(featuresDir(storeType), feature_id, "attachments");
  const extracted = await extractAllFromDir(attachmentsDir);
  const supplementaryData = extracted.map(e => `FILE: ${e.filename} (${e.summary})\n${e.content}`).join("\n\n---\n\n");
  if (extracted.length > 0) {
      console.log(`  [PM] Read ${extracted.length} supplementary data files.`);
  }

  // DISCOVERY PHASE: Log the implementation footprint
  console.log(`  [PM] Discovery: Mapping feature to existing architecture...`);
  console.log(`  [PM] Identity:  ${codeCtx.projectIdentity.substring(0, 100)}...`);
  
  const rbacFiles = codeCtx.fileTree.split('\n').filter(f => f.match(/auth|role|permission|rbac|acl/i)).slice(0, 3);
  if (rbacFiles.length > 0) {
      console.log(`  [PM] RBAC Scope: Identified access control logic in: ${rbacFiles.map(f => path.basename(f)).join(', ')}`);
  }
  
  if (codeCtx.apiRoutes.length > 0) {
      console.log(`  [PM] Footprint: Affects up to ${codeCtx.apiRoutes.length} potential endpoints/dependencies.`);
  }

  const rounds: BrainstormRound[] = [];
  for (const agent of PM_AGENTS) {
    console.log(`  [PM] Running ${agent.label}...`);
    const round = await runBrainstormAgent(agent, state, codeContext, rounds, strategyContext, supplementaryData);
    rounds.push(round);
    
    console.log(`  [PM] ${agent.label} Score: ${round.fit_score}/10`);
    console.log(`  [PM] ${agent.label} Insight: "${round.perspective.substring(0, 150)}..."`);
    
    // PROGRESS SYNC: Update UI after each agent finishes
    const tempContent: PMBrainstormDeliverable = {
      feature_id,
      feature_title:    state.feature_title,
      brainstorm_rounds: rounds,
      consensus: { build_decision: "proceed", confidence: 0.5, agreed_scope: "Partial analysis in progress...", open_risks: [], north_star_impact: "", ost_opportunity: "" },
      pm_memo: "Analysis in progress. Please wait for the synthesizer to finish..."
    };
    const syncState = { 
        ...state, 
        current_stage: "pm_brainstorm", 
        deliverables: { 
            ...state.deliverables, 
            pm_brainstorm: makeDeliverable("pm_brainstorm", kickbackCount + 1, "PMBrainstormDeliverable", tempContent, "") 
        } 
    };
    syncFromPipelineState(feature_id, syncState, storeType);
  }

  console.log(`  [PM] Running synthesizer...`);
  const existingDeliverable = state.deliverables?.pm_brainstorm?.content as PMBrainstormDeliverable;
  const chatHistory = existingDeliverable?.chat_history || [];
  
  if (chatHistory.length > 0) {
      console.log(`  [PM] Received ${chatHistory.length} chat messages from user.`);
      const lastMsg = chatHistory[chatHistory.length - 1];
      console.log(`  [PM] Applying Feedback: "${lastMsg.text.substring(0, 50)}..."`);
  }
  
  if (state.pipeline_mode === "discovery") {
    console.log(`  [PM] Synthesizing Strategic Discovery Report...`);
    const discoveryObj = await runDiscoverySynthesizer(rounds, codeContext, supplementaryData);
    
    return {
      deliverables: {
        ...state.deliverables,
        pm_brainstorm: makeDeliverable("pm_brainstorm", kickbackCount + 1, "DiscoveryDeliverable", discoveryObj, "")
      }
    };
  }

  const { consensus, pm_memo } = await runSynthesizer(feature_description, rounds, codeContext, supplementaryData, chatHistory);
  console.log(`  [PM] Synthesis Complete!`);
  console.log(`  [PM] Decision:   ${consensus.build_decision.toUpperCase()}`);
  console.log(`  [PM] Confidence: ${(consensus.confidence * 100).toFixed(0)}%`);
  console.log(`  [PM] Impact:     ${consensus.north_star_impact}`);
  console.log(`  [PM] Memo:       ${pm_memo.substring(0, 300)}...`);

  const version    = kickbackCount + 1;
  const memoryPath = `agents/pm-brainstorm/memory/runtime/pm-brainstorm-v${version}.json`;
  const content: PMBrainstormDeliverable = {
    feature_id,
    feature_title:    state.feature_title,
    brainstorm_rounds: rounds,
    consensus,
    pm_memo,
    chat_history: chatHistory
  };

  await writeAgentMemory("pm-brainstorm", feature_id, {
    event:          "brainstorm_complete",
    decision:       consensus.build_decision,
    confidence:     consensus.confidence,
    kickback_count: kickbackCount,
    codebase_tech:  codeCtx.techStack,
    key_files_read: codeCtx.keyFileExcerpts.map(f => f.path),
  });

  return {
    current_stage: "pm_brainstorm",
    deliverables:  { pm_brainstorm: makeDeliverable("pm_brainstorm", version, "PMBrainstormDeliverable", content, memoryPath) },
  };
}
