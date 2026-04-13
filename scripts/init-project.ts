#!/usr/bin/env node
// scripts/init-project.ts
//
// Run automatically after install/upgrade:   (postinstall in package.json)
// Run manually to force a refresh:           npm run project:init
//
// Scans the host project codebase and writes memory/project-overview.md —
// a stable, human-editable description of the product that ALL agents read
// before generating features, stories, code, or tests.
//
// If the host project is empty (no manifest, no entry points), the LLM
// generates a new-project template for you to fill in.

import * as dotenv from "dotenv";
import * as path   from "path";
import * as fs     from "fs";

// Load .agentsdlc/.env before importing any module that needs credentials
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { scanCodebase }                        from "../tools/codebase-scanner";
import { withFailover, resolveModel, providerSummary } from "../config/llm-client";
import { AGENT_MODELS }                        from "../config/agents";

// ── Paths ─────────────────────────────────────────────────────────────────────

// HOST_PROJECT_PATH env var (relative to .agentsdlc/) or default to parent dir
const hostPath = process.env.HOST_PROJECT_PATH
  ? path.resolve(__dirname, "..", process.env.HOST_PROJECT_PATH)
  : path.resolve(__dirname, "../..");

const OVERVIEW_PATH = path.resolve(__dirname, "../memory/project-overview.md");
const FORCE         = process.argv.includes("--force");
const MAX_AGE_DAYS  = 7;   // Regenerate if overview is older than this

// ── Staleness check ───────────────────────────────────────────────────────────

function isOverviewFresh(): boolean {
  if (FORCE) return false;
  if (!fs.existsSync(OVERVIEW_PATH)) return false;
  const age = (Date.now() - fs.statSync(OVERVIEW_PATH).mtimeMs) / (1000 * 60 * 60 * 24);
  return age < MAX_AGE_DAYS;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n AgentSDLC — Project Overview Init\n");

  if (isOverviewFresh()) {
    const age = (Date.now() - fs.statSync(OVERVIEW_PATH).mtimeMs) / (1000 * 60 * 60);
    console.log(` ✓ memory/project-overview.md is fresh (${Math.round(age)}h old)`);
    console.log(`   Run with --force to regenerate: npm run project:init -- --force\n`);
    return;
  }

  console.log(` Host project: ${hostPath}`);
  console.log(providerSummary());
  console.log("\n Scanning codebase...");

  const codeCtx = await scanCodebase(hostPath);

  const isEmpty =
    codeCtx.techStack[0]?.startsWith("Unknown") &&
    codeCtx.entryPoints.length === 0 &&
    codeCtx.keyFileExcerpts.length === 0;

  console.log(` Tech stack:   ${isEmpty ? "none detected (new project)" : codeCtx.techStack.join(", ")}`);
  if (!isEmpty) {
    console.log(` Entry points: ${codeCtx.entryPoints.join(", ") || "none"}`);
    console.log(` API routes:   ${codeCtx.apiRoutes.length} found`);
    console.log(` Key files:    ${codeCtx.keyFileExcerpts.map(f => f.path).join(", ") || "none"}`);
  }

  const cfg = AGENT_MODELS.pm_brainstorm;
  console.log("\n Generating project overview with LLM...");

  const systemPrompt = isEmpty
    ? `You are a product strategist helping a team set up a new software project.
Generate a project-overview.md that documents the product vision the team will build.
Use this structure:
# Project Overview
## Product Name & Purpose
## Target Users
## Core Features (planned)
## Tech Stack (recommended)
## Key Principles
## What NOT to build (anti-scope)

Be specific enough that an AI agent reading this will know exactly what kind of product to build features for.
Do NOT add commentary — output the markdown document directly.`
    : `You are a senior product analyst. Read the codebase context below and write a concise project-overview.md.
This file will be read by AI agents (PM, PO, Architect, Developer, QA) before every pipeline run.
It must tell them EXACTLY what product this is so they cannot hallucinate a wrong product.

Use this structure:
# Project Overview
## Product Name & Purpose (1-2 sentences — what does this product DO for its users?)
## Target Users (who uses it?)
## Core Domain Entities (list the main data models, e.g. "References, Requests, Accounts")
## Existing Features (bullet list of what is ALREADY built — agents must NOT rebuild these)
## Tech Stack (be specific: framework versions, DB, auth method, deployment)
## Key API Endpoints (list the most important routes)
## What NOT to build (anti-scope — prevents agents generating wrong features)

Be specific — name real files, real routes, real data models from the codebase.
Do NOT add commentary or preamble — output the markdown document directly.`;

  const userMessage = isEmpty
    ? `Empty project detected at: ${hostPath}\n\nGenerate a project-overview.md template for a new product.
The team will edit this file to define their product vision.`
    : `Host project at: ${hostPath}

Tech stack: ${codeCtx.techStack.join(", ")}
Entry points: ${codeCtx.entryPoints.join(", ")}
API routes (${codeCtx.apiRoutes.length}): ${codeCtx.apiRoutes.join(", ")}
DB schema files: ${codeCtx.dbSchema.join(", ")}

Key file contents:
${codeCtx.keyFileExcerpts.map(f => `### ${f.path} (${f.reason})\n${f.content}`).join("\n\n")}

File tree (first 2000 chars):
${codeCtx.fileTree.slice(0, 2000)}

Write a detailed project-overview.md so agents know exactly what product this is.`;

  const overviewContent = await withFailover(async (client) => {
    const res = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: 2048,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userMessage }],
    });
    return res.content[0].type === "text" ? res.content[0].text : "";
  }, "init-project");

  if (!overviewContent.trim()) {
    console.warn(" ⚠ LLM returned empty response — overview not written");
    return;
  }

  fs.mkdirSync(path.dirname(OVERVIEW_PATH), { recursive: true });

  const header = [
    `<!-- Auto-generated by AgentSDLC on ${new Date().toISOString()} -->`,
    `<!-- Edit freely — agents will use this file as their product context -->`,
    `<!-- Delete this file and run "npm run project:init" to regenerate -->`,
    "",
  ].join("\n");

  fs.writeFileSync(OVERVIEW_PATH, header + overviewContent, "utf8");

  console.log(` ✓ Project overview written: memory/project-overview.md`);
  console.log(`\n IMPORTANT: Review and edit the overview to correct any inaccuracies.`);
  console.log(`   Agents will use this file as their product context on every pipeline run.\n`);
}

main().catch(err => {
  // Non-fatal — don't break npm install if LLM is unavailable
  console.warn(`\n [project:init] Skipped: ${err.message}`);
  console.warn(`   Run manually once credentials are set: npm run project:init\n`);
  process.exit(0);
});
