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
import { featuresDir } from "../../orchestrator/feature-store";
import type { PipelineState, BrainstormRound, PMBrainstormDeliverable } from "../../types/state";

const PM_AGENTS = [
  { id:"visionary",   label:"Visionary PM",    model_key:"pm_brainstorm", skills:["/strategy","/north-star","OST"],
    system:`You are a Visionary PM analysing a NEW FEATURE for an EXISTING product.
CRITICAL: You must ground every point in the ACTUAL codebase shown. Do NOT invent a different product.
Apply: Opportunity Solution Tree (Teresa Torres), North Star Impact, Product Strategy Fit.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences grounded in the real codebase","ost_opportunity":"string","north_star_impact":"string","pm_skills_used":["string"]}` },
  { id:"critic",      label:"Critic PM",       model_key:"pm_critic",     skills:["/pre-mortem","Tigers/Elephants","identify-assumptions"],
    system:`You are a Devil's Advocate PM analysing a NEW FEATURE for an EXISTING product.
CRITICAL: You must ground every risk in the ACTUAL codebase shown. Do NOT invent a different product.
Apply: Pre-mortem, Tigers/Paper Tigers/Elephants, Assumption Prioritization.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences grounded in the real codebase","tigers":["..."],"elephants":["..."],"riskiest_assumption":"string","pm_skills_used":["string"]}` },
  { id:"data",        label:"Data Analyst PM", model_key:"pm_critic",     skills:["RICE","market-sizing","cohorts"],
    system:`You are a Data-driven PM analysing a NEW FEATURE for an EXISTING product.
CRITICAL: Mention the real existing modules/endpoints this feature will affect. Do NOT invent a different product.
Apply: RICE, Market Sizing (TAM/SAM/SOM), Cohort Impact, Measurement Plan.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences referencing real existing code","rice_score":{"reach":0-10,"impact":0-10,"confidence":0-1,"effort":1-10},"metrics_affected":["..."],"pm_skills_used":["string"]}` },
  { id:"user",        label:"User Advocate PM",model_key:"pm_critic",     skills:["JTBD","personas","journey-map"],
    system:`You are a User-obsessed PM (Teresa Torres continuous discovery) analysing a NEW FEATURE for an EXISTING product.
CRITICAL: The persona must be a user of the ACTUAL product shown in the codebase. Do NOT invent a different product.
Apply: User Personas, JTBD, Customer Journey Map.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences about real users of this product","primary_persona":"string","jtbd":"When X, I want Y, so I can Z","journey_stage":"string","pm_skills_used":["string"]}` },
  { id:"technical",   label:"Technical PM",    model_key:"pm_critic",     skills:["feasibility","RICE","roadmap"],
    system:`You are a Technical PM bridging product and engineering for an EXISTING codebase.
CRITICAL: Reference the real files, routes, and modules shown. Estimate effort based on the ACTUAL tech stack. Do NOT invent a different product.
Apply: Feasibility Assessment, RICE Score, Sprint Estimation.
Output ONLY valid JSON: {"fit_score":1-10,"arguments_for":["..."],"arguments_against":["..."],"perspective":"2-3 sentences about real technical implications","tech_complexity":"low|medium|high","codebase_concerns":["..."],"sprint_estimate":"string","pm_skills_used":["string"]}` },
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

  const modeContext = state.pipeline_mode === "idea"
    ? `\n\nPIPELINE MODE: IDEA PIPELINE (Discovery & Strategy)
Focus: Synthesizing raw customer feedback into a pristine opportunity. 
Required PM Tools: Discovery, JTBD, Opportunity Solution Tree, Competitor Analysis, Problem Solving.
Use the Competitor Strategy provided below to align this idea.`
    : `\n\nPIPELINE MODE: FEATURE EXECUTION
Focus: Validating a confirmed requirement before handing off to PO for engineering.
Required PM Tools: Lean Canvas, RICE Prioritization, Assumption Mapping, Pre-mortems.`;

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

async function runSynthesizer(
  feature: string,
  rounds: BrainstormRound[],
  codeContext: string,
  supplementaryData: string,
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

Synthesize and write a pm_memo grounded in the real product and data. Output ONLY valid JSON.`,
      }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, "pm-brainstorm:synthesizer");

  return JSON.parse(raw.replace(/```json|```/g, "").trim());
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

  // Load Supplementary Data (Uploaded files)
  const attachmentsDir = path.join(featuresDir("features"), feature_id, "attachments");
  const extracted = await extractAllFromDir(attachmentsDir);
  const supplementaryData = extracted.map(e => `FILE: ${e.filename} (${e.summary})\n${e.content}`).join("\n\n---\n\n");
  if (extracted.length > 0) {
      console.log(`  [PM] Read ${extracted.length} supplementary data files.`);
  }

  const rounds: BrainstormRound[] = [];
  for (const agent of PM_AGENTS) {
    console.log(`  [PM] Running ${agent.label}...`);
    const round = await runBrainstormAgent(agent, state, codeContext, rounds, strategyContext, supplementaryData);
    rounds.push(round);
  }

  console.log(`  [PM] Running synthesizer...`);
  const { consensus, pm_memo } = await runSynthesizer(feature_description, rounds, codeContext, supplementaryData);
  const version    = kickbackCount + 1;
  const memoryPath = `agents/pm-brainstorm/memory/runtime/pm-brainstorm-v${version}.json`;
  const content: PMBrainstormDeliverable = {
    feature_id,
    feature_title:    state.feature_title,
    brainstorm_rounds: rounds,
    consensus,
    pm_memo,
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
