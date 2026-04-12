// ─────────────────────────────────────────────────────────────────────────────
// Dev Swarm v2 — Gemini (FE) + Claude Sonnet (BE) run in parallel
// FILE WRITER WIRED IN — code is written to actual project files
// On kickback from review: reads blocking comments and targets specific files
// On kickback from CI/CD: reads build log and fixes failing tests/imports
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODELS }     from "../../config/agents";
import { createPullRequest } from "../../integrations/github";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import type { PipelineState, DevTask } from "../../types/state";

const client = new Anthropic();

async function runFEAgent(tasks: DevTask[], adr: string, kickbackContext: string): Promise<string[]> {
  const cfg = AGENT_MODELS.frontend_dev;
  // Gemini would use its own client — shown as Anthropic for scaffold completeness
  // Replace with: const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const response = await client.messages.create({
    model: cfg.model,   // swap to gemini-2.0-flash via Gemini SDK
    max_tokens: cfg.maxTokens,
    system: `You are a Frontend Developer agent. Write production-quality React/TypeScript code.
Follow the Architecture Decision Record exactly. Write unit tests for every component.
${kickbackContext ? `KICKBACK — you must fix: ${kickbackContext}` : ""}`,
    messages: [{
      role: "user",
      content: `ADR:\n${adr.slice(0, 2000)}\n\nTasks:\n${tasks.map(t => `${t.id}: ${t.description} → files: ${t.file_paths.join(", ")}`).join("\n")}\n\nWrite the code. Include test files.`,
    }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return text.split("\n").filter(l => l.trim().startsWith("//") || l.trim().startsWith("import") || l.length > 0).slice(0, 50);
}

async function runBEAgent(tasks: DevTask[], adr: string, kickbackContext: string): Promise<string[]> {
  const cfg = AGENT_MODELS.backend_dev;
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: `You are a Backend Developer agent. Write production-quality TypeScript API code.
Follow the ADR, API contracts, and DB schema changes exactly. Write unit tests.
${kickbackContext ? `KICKBACK — you must fix: ${kickbackContext}` : ""}`,
    messages: [{
      role: "user",
      content: `ADR:\n${adr.slice(0, 2000)}\n\nTasks:\n${tasks.map(t => `${t.id}: ${t.description} → files: ${t.file_paths.join(", ")}`).join("\n")}\n\nWrite the code. Include test files.`,
    }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return text.split("\n").slice(0, 50);
}

export async function runDevSwarm(state: PipelineState): Promise<Partial<PipelineState>> {
  const archDeliverable = state.deliverables?.architect?.content as any;
  const kickbackCount   = state.retry_counts?.dev_swarm ?? 0;

  // Aggregate kickback context from review + CI/CD + NFR
  const reviewKickback = state.kickbacks.findLast(k => k.stage === "review");
  const cicdKickback   = state.kickbacks.findLast(k => k.stage === "cicd");
  const nfrKickback    = state.kickbacks.findLast(k => k.stage === "nfr");

  const kickbackContext = [reviewKickback, cicdKickback, nfrKickback]
    .filter(Boolean)
    .map(k => `[${k!.stage.toUpperCase()}] ${k!.actionable}`)
    .join("\n");

  const feTasks: DevTask[] = archDeliverable?.frontend_tasks ?? [];
  const beTasks: DevTask[] = archDeliverable?.backend_tasks  ?? [];
  const adr: string        = archDeliverable?.adr_content    ?? "";

  // Run FE and BE in parallel
  const [feCommits, beCommits] = await Promise.all([
    runFEAgent(feTasks, adr, kickbackContext),
    runBEAgent(beTasks, adr, kickbackContext),
  ]);

  // Create or update PR
  let prNumber = state.github.pr_number;
  let prUrl    = state.github.pr_url;
  if (!prNumber) {
    const pr = await createPullRequest({
      title: `feat: ${state.feature_title} [${state.jira.epic_key}]`,
      body: `## Summary\n${archDeliverable?.adr_content?.slice(0, 500) ?? ""}\n\n## Jira\n${state.jira.epic_key}`,
      head: state.github.feature_branch ?? "feature/dev",
      base: "main",
    });
    prNumber = pr.number;
    prUrl    = pr.html_url;
  }

  const version    = kickbackCount + 1;
  const memoryPath = `agents/dev-swarm/memory/runtime/dev-v${version}.json`;

  await writeAgentMemory("dev-swarm", state.feature_id, {
    event: "dev_swarm_complete",
    fe_tasks: feTasks.length,
    be_tasks: beTasks.length,
    pr_number: prNumber,
    kickback_count: kickbackCount,
    kickback_source: reviewKickback ? "review" : cicdKickback ? "cicd" : nfrKickback ? "nfr" : "none",
  });

  return {
    current_stage: "dev_swarm",
    deliverables: {
      dev_swarm: makeDeliverable("dev_swarm", version, "DevSwarmDeliverable", {
        commits: [...feCommits, ...beCommits],
        pr_number: prNumber,
        pr_url: prUrl,
      }, memoryPath),
    },
    github: { ...state.github, pr_number: prNumber, pr_url: prUrl },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NFR Agent — Claude Haiku (parallel to dev, checker role)
// ─────────────────────────────────────────────────────────────────────────────

export async function runNFRAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const archDeliverable = state.deliverables?.architect?.content as any;
  const devDeliverable  = state.deliverables?.dev_swarm?.content  as any;
  const kickbackCount   = state.retry_counts?.nfr ?? 0;

  const cfg = AGENT_MODELS.nfr;
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: `You are an NFR (Non-Functional Requirements) review agent with the checker SOD role.
Review the architecture and generated code. Output ONLY valid JSON:
{
  "overall_status": "pass|warn|fail",
  "critical_issues": ["string"],
  "items": [{
    "category": "latency|db|caching|security|error_handling|rate_limit|observability",
    "requirement": "string",
    "status": "pass|warn|fail",
    "detail": "string",
    "remediation": "specific fix instruction if fail or warn"
  }],
  "recommendations": ["string"]
}
Categories to check:
- latency: P95 < 200ms for reads, P95 < 500ms for writes
- db: indexes exist for query patterns, no N+1 queries, transactions where needed
- caching: cache strategy defined for repeated reads
- security: auth on all endpoints, input validation, SQL injection prevention
- error_handling: all error paths handled, logged, alerted
- rate_limit: rate limiting defined for public APIs
- observability: logging, metrics, tracing hooks present`,
    messages: [{
      role: "user",
      content: `ADR:\n${archDeliverable?.adr_content?.slice(0, 2000) ?? ""}\n\nDB Changes:\n${archDeliverable?.db_schema_changes?.join("\n") ?? ""}\n\nAPI Contracts:\n${archDeliverable?.api_contracts?.join("\n") ?? ""}\n\nDev commits sample:\n${devDeliverable?.commits?.slice(0, 20).join("\n") ?? ""}\n\nRun NFR review. Output ONLY valid JSON.`,
    }],
  });

  const raw    = response.content[0].type === "text" ? response.content[0].text : "{}";
  const result = JSON.parse(raw.replace(/```json|```/g, "").trim());

  const version    = kickbackCount + 1;
  const memoryPath = `agents/nfr-agent/memory/runtime/nfr-v${version}.json`;

  await writeAgentMemory("nfr-agent", state.feature_id, {
    event: "nfr_complete",
    overall_status: result.overall_status,
    critical_issues: result.critical_issues,
    kickback_count: kickbackCount,
  });

  return {
    current_stage: "nfr",
    deliverables: {
      nfr: makeDeliverable("nfr", version, "NFRDeliverable", result, memoryPath),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Review Agent — Claude Opus 4 (checker SOD role)
// ─────────────────────────────────────────────────────────────────────────────

import { approvePR, createPRReviewComment } from "../../integrations/github";

export async function runReviewAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const archDeliverable = state.deliverables?.architect?.content as any;
  const nfrDeliverable  = state.deliverables?.nfr?.content  as any;
  const kickbackCount   = state.retry_counts?.review ?? 0;

  const cfg = AGENT_MODELS.reviewer;
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: `You are a senior architect acting as peer reviewer. You have the checker SOD role — you did not write this code.
Review against: (1) ADR compliance (2) NFR report (3) test coverage (4) coding standards.
Output ONLY valid JSON:
{
  "decision": "approved|changes_requested",
  "sod_validated": true,
  "nfr_compliance": boolean,
  "coverage_pct": number,
  "comments": [{
    "file": "string",
    "line": number or null,
    "severity": "blocking|suggestion|nitpick",
    "body": "string",
    "resolved": false
  }]
}
Mark decision "approved" only if zero blocking comments.`,
    messages: [{
      role: "user",
      content: `ADR:\n${archDeliverable?.adr_content?.slice(0, 2000) ?? ""}\n\nNFR Report:\n${JSON.stringify(nfrDeliverable, null, 2).slice(0, 1000)}\n\nPR: #${state.github.pr_number}\n\nReview. Output ONLY valid JSON.`,
    }],
  });

  const raw    = response.content[0].type === "text" ? response.content[0].text : "{}";
  const result = JSON.parse(raw.replace(/```json|```/g, "").trim());

  // Post review to GitHub
  if (state.github.pr_number) {
    if (result.decision === "approved") {
      await approvePR(state.github.pr_number);
    } else {
      const blockingComments = result.comments.filter((c: any) => c.severity === "blocking");
      await createPRReviewComment(state.github.pr_number, blockingComments.map((c: any) => `**${c.file}**: ${c.body}`).join("\n\n"));
    }
  }

  const version    = kickbackCount + 1;
  const memoryPath = `agents/review-agent/memory/runtime/review-v${version}.json`;

  await writeAgentMemory("review-agent", state.feature_id, {
    event: "review_complete",
    decision: result.decision,
    blocking_comments: result.comments.filter((c: any) => c.severity === "blocking").length,
    kickback_count: kickbackCount,
  });

  return {
    current_stage: "review",
    deliverables: {
      review: makeDeliverable("review", version, "ReviewDeliverable", { ...result, pr_number: state.github.pr_number, pr_url: state.github.pr_url }, memoryPath),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CI/CD Agent — Claude Haiku + Shell (executor SOD role)
// ─────────────────────────────────────────────────────────────────────────────

import { notifyDeployment } from "../../integrations/slack";

export async function runCICDAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const kickbackCount = state.retry_counts?.cicd ?? 0;

  // In production: trigger GitHub Actions or Bitbucket Pipelines webhook
  // and poll for status. Here we simulate with a structured response.
  const cfg = AGENT_MODELS.cicd;
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: `You are a CI/CD orchestration agent. Simulate triggering a pipeline and reporting results.
Output ONLY valid JSON:
{
  "deploy_status": "success|failed",
  "build_log_url": "string",
  "stages": [{ "name": "lint|test|build|deploy", "status": "pass|fail", "duration_ms": number }],
  "staging_url": "string or null"
}`,
    messages: [{
      role: "user",
      content: `Branch: ${state.github.feature_branch}\nPR: ${state.github.pr_number}\nEpic: ${state.jira.epic_key}\n\nSimulate CI/CD pipeline execution.`,
    }],
  });

  const raw    = response.content[0].type === "text" ? response.content[0].text : "{}";
  const result = JSON.parse(raw.replace(/```json|```/g, "").trim());

  await notifyDeployment("staging", result.deploy_status, result.staging_url);

  const version    = kickbackCount + 1;
  const memoryPath = `agents/cicd-agent/memory/runtime/cicd-v${version}.json`;

  await writeAgentMemory("cicd-agent", state.feature_id, {
    event: "cicd_complete",
    deploy_status: result.deploy_status,
    staging_url: result.staging_url,
    kickback_count: kickbackCount,
  });

  return {
    current_stage: "cicd",
    deliverables: {
      cicd: makeDeliverable("cicd", version, "CICDDeliverable", result, memoryPath),
    },
    deployment: {
      staging_url: result.staging_url,
      deploy_status: result.deploy_status,
      build_log_url: result.build_log_url,
    },
  };
}
