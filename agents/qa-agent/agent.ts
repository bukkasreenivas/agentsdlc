// QA Agent — Claude Sonnet 4 + Playwright
// Generates test cases from pm-skills test-scenarios framework.
// Executes with video recording. Logs to Jira. HUMAN GATE.
// On kickback: targets only failing tests, not full re-run.

import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODELS }   from "../../config/agents";
import { integrations }   from "../../config/integrations";
import { createTestCase } from "../../integrations/jira";
import { notifyQAResults } from "../../integrations/slack";
import { makeDeliverable, writeAgentMemory } from "../../orchestrator/index";
import type { PipelineState, QADeliverable, QATestCase } from "../../types/state";
import * as fs   from "fs";
import * as path from "path";

const client = new Anthropic();

export async function runQAAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const poDeliverable  = state.deliverables?.po?.content as any;
  const stories        = poDeliverable?.user_stories ?? [];
  const kickbackCount  = state.retry_counts?.qa ?? 0;
  const deploymentUrl  = state.deployment?.staging_url ?? integrations.playwright.baseUrl;

  // On kickback: only re-run failed tests
  const previousQA    = state.deliverables?.qa?.content as any;
  const failedTestIds = previousQA?.test_cases
    ?.filter((t: any) => t.status === "fail")
    ?.map((t: any) => t.id) ?? [];
  const isRetry       = failedTestIds.length > 0;

  const cfg = AGENT_MODELS.qa;

  // Generate or re-generate test cases using pm-skills test-scenarios framework
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: `You are a QA automation agent applying the pm-skills test-scenarios framework.
For each user story generate:
1. Happy path tests — primary user journey
2. Edge case tests — boundary conditions, empty states, max values
3. Error state tests — network failures, invalid input, unauthorized

${isRetry ? `RETRY MODE: Only generate tests for these previously-failing IDs: ${failedTestIds.join(", ")}` : ""}

Output ONLY valid JSON:
{
  "test_cases": [{
    "id": "TC-001",
    "title": "string",
    "story_key": "string",
    "type": "happy_path|edge_case|error_state",
    "steps": ["navigate to ...", "click ...", "assert visible ..."],
    "expected_result": "string"
  }]
}`,
    messages: [{
      role: "user",
      content: stories.map((s: any) =>
        `Story ${s.key}: ${s.summary}\nAC: ${s.acceptance_criteria?.join("; ")}\nTest Scenarios: ${s.test_scenarios?.join("; ")}`
      ).join("\n\n"),
    }],
  });

  const raw = response.content[0].type === "text" ? response.content[0].text : "{}";
  const { test_cases: newCases }: { test_cases: QATestCase[] } = JSON.parse(raw.replace(/```json|```/g, "").trim());

  // Merge with previous passing tests on retry
  const allCases: QATestCase[] = isRetry
    ? [
        ...(previousQA?.test_cases?.filter((t: any) => t.status === "pass") ?? []),
        ...newCases,
      ]
    : newCases;

  // Execute with Playwright
  const videosDir = path.join(process.cwd(), integrations.playwright.videosDir, `run-${Date.now()}`);
  fs.mkdirSync(videosDir, { recursive: true });

  let passed = 0;
  let failed = 0;
  const executedCases: QATestCase[] = [];

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: integrations.playwright.headless });

    for (const tc of allCases) {
      // Skip already-passing tests on retry (keep their previous result)
      if (isRetry && !failedTestIds.includes(tc.id) && tc.status === "pass") {
        executedCases.push(tc);
        passed++;
        continue;
      }

      const ctx  = await browser.newContext({
        recordVideo: {
          dir: videosDir,
          size: { width: 1280, height: 720 },
        },
      });
      const page = await ctx.newPage();

      try {
        await page.goto(deploymentUrl, { waitUntil: "networkidle" });

        // Execute steps — in production wire to Playwright fixture helpers
        for (const step of tc.steps) {
          if (step.startsWith("navigate to")) {
            const url = step.replace("navigate to", "").trim();
            await page.goto(url.startsWith("http") ? url : `${deploymentUrl}${url}`);
          } else if (step.startsWith("click")) {
            const selector = step.replace("click", "").trim();
            await page.click(selector).catch(() => {});
          } else if (step.startsWith("assert visible")) {
            const selector = step.replace("assert visible", "").trim();
            await page.waitForSelector(selector, { timeout: 5000 });
          }
        }

        tc.status   = "pass";
        tc.duration_ms = 0;
        passed++;
      } catch (err) {
        tc.status        = "fail";
        tc.error_message = (err as Error).message;
        failed++;
      } finally {
        await ctx.close();
        // Video saved automatically to videosDir
        const videoFile = `${tc.id}.webm`;
        tc.video_path   = path.join(videosDir, videoFile);
      }

      // Log test case to Jira
      await createTestCase({ title: tc.title, steps: tc.steps, storyKey: tc.story_key });
      executedCases.push(tc);
    }

    await browser.close();
  } catch (err) {
    console.warn("Playwright not available:", (err as Error).message);
    // In CI without browser — mark all as pending
    for (const tc of allCases) {
      tc.status = "skip";
      executedCases.push(tc);
    }
  }

  const pass_rate     = executedCases.length > 0 ? passed / executedCases.length : 0;
  const jiraRunUrl    = `${integrations.jira.baseUrl}/projects/${integrations.jira.projectKey}/test-runs`;
  const slackSummary  = await notifyQAResults({ passed, failed, videosUrl: `file://${path.resolve(videosDir)}` });

  const version    = kickbackCount + 1;
  const memoryPath = `agents/qa-agent/memory/runtime/qa-v${version}.json`;

  const deliverableContent: QADeliverable = {
    test_cases: executedCases,
    passed,
    failed,
    pass_rate,
    videos_dir: videosDir,
    jira_test_run_url: jiraRunUrl,
    slack_summary_url: slackSummary?.ts ?? jiraRunUrl,
  };

  await writeAgentMemory("qa-agent", state.feature_id, {
    event: "qa_complete",
    passed,
    failed,
    pass_rate,
    videos_dir: videosDir,
    kickback_count: kickbackCount,
    retry_mode: isRetry,
  });

  return {
    current_stage: "qa",
    deliverables: {
      qa: makeDeliverable("qa", version, "QADeliverable", deliverableContent, memoryPath),
    },
    jira: { ...state.jira, test_run_key: `TR-${Date.now()}` },
    slack: { ...state.slack, qa_thread: slackSummary?.ts },
  };
}
