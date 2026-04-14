// tools/feature-doc.ts
// Generates and writes docs/features/<feature-id>.md to the HOST project.
// Called at each human gate to give reviewers a single living document that
// accumulates PM, Jira, and Figma content as the pipeline progresses.

import * as fs   from "fs";
import * as path from "path";
import type { PipelineState, StageId } from "../types/state";

// ── Stage label helpers ───────────────────────────────────────────────────────

const STAGE_LABELS: Partial<Record<StageId, string>> = {
  pm_brainstorm: "PM Analysis",
  pm_promote:    "PM Promote",
  po:            "PO Stories",
  design:        "Design",
  architect:     "Architecture",
  dev_swarm:     "Development",
  nfr:           "NFR Review",
  review:        "Code Review",
  cicd:          "CI/CD",
  qa:            "QA",
  done:          "Done",
  escalated:     "Escalated",
};

function stageBadge(stage: StageId): string {
  return STAGE_LABELS[stage] ?? stage;
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderHeader(state: PipelineState, stage: StageId): string {
  const lines = [
    `# Feature: ${state.feature_title}`,
    ``,
    `| Field         | Value |`,
    `|---------------|-------|`,
    `| Feature ID    | \`${state.feature_id}\` |`,
    `| Current Stage | **${stageBadge(stage)}** |`,
    `| Requested By  | ${state.requested_by ?? "—"} |`,
    `| Created       | ${state.created_at?.slice(0, 10) ?? "—"} |`,
    `| Updated       | ${new Date().toISOString().slice(0, 10)} |`,
    ``,
  ];
  if (state.feature_description) {
    lines.push(`> ${state.feature_description}`, ``);
  }
  return lines.join("\n");
}

function renderPMSection(state: PipelineState): string {
  const pm = state.deliverables?.pm_brainstorm?.content as any;
  if (!pm) return "";

  const decision   = pm.consensus?.build_decision ?? "unknown";
  const confidence = pm.consensus?.confidence != null
    ? `${Math.round(pm.consensus.confidence * 100)}%`
    : "N/A";
  const scope      = pm.consensus?.agreed_scope ?? "";
  const memo       = pm.pm_memo ?? "";

  return [
    `## PM Analysis`,
    ``,
    `| Decision | Confidence | Agreed Scope |`,
    `|----------|------------|--------------|`,
    `| **${decision}** | ${confidence} | ${scope} |`,
    ``,
    memo,
    ``,
  ].join("\n");
}

function renderJiraSection(state: PipelineState): string {
  const po       = state.deliverables?.po?.content as any;
  const epicKey  = state.jira?.epic_key ?? po?.epic_key;
  if (!epicKey && !po) return "";

  const jiraBase  = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");
  const isReal    = jiraBase && !jiraBase.includes("yourorg");
  const epicUrl   = isReal ? `${jiraBase}/browse/${epicKey}` : null;
  const epicLink  = epicUrl ? `[${epicKey}](${epicUrl})` : (epicKey ?? "N/A");
  const epicSummary = po?.epic_summary ?? "";

  const lines = [
    `## Jira Epic & Stories`,
    ``,
    `**Epic:** ${epicLink}${epicSummary ? ` — ${epicSummary}` : ""}`,
    ``,
  ];

  const stories: any[] = po?.user_stories ?? [];
  if (stories.length > 0) {
    lines.push(`| Story Key | Summary | Points |`);
    lines.push(`|-----------|---------|--------|`);
    for (const s of stories) {
      const storyUrl  = isReal && s.key ? `${jiraBase}/browse/${s.key}` : null;
      const keyCell   = storyUrl ? `[${s.key}](${storyUrl})` : (s.key ?? "—");
      lines.push(`| ${keyCell} | ${s.summary ?? "—"} | ${s.story_points ?? "?"} |`);
    }
    lines.push(``);
  } else if ((state.jira?.story_keys ?? []).length > 0) {
    for (const k of state.jira.story_keys!) {
      const url = isReal ? `${jiraBase}/browse/${k}` : null;
      lines.push(`- ${url ? `[${k}](${url})` : k}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

function renderDesignSection(state: PipelineState): string {
  const design    = state.deliverables?.design?.content as any;
  const figmaKey  = state.figma?.file_key ?? design?.figma_file_key;
  const frameUrls: string[] = state.figma?.frame_urls ?? design?.frame_urls ?? [];

  if (!figmaKey && frameUrls.length === 0) return "";

  const lines = [`## Design & Wireframes`, ``];

  if (figmaKey) {
    lines.push(`**Figma File:** [Open in Figma](https://www.figma.com/file/${figmaKey})`, ``);
  }

  if (frameUrls.length > 0) {
    lines.push(`**Screens:**`);
    for (const url of frameUrls) {
      lines.push(`- [${url}](${url})`);
    }
    lines.push(``);
  }

  const screens: any[] = design?.screens ?? [];
  if (screens.length > 0) {
    lines.push(`| Screen | Journey Stage | Layout |`);
    lines.push(`|--------|---------------|--------|`);
    for (const s of screens) {
      const layout = (s.layout ?? "").toString().slice(0, 80);
      lines.push(`| ${s.name ?? "—"} | ${s.journey_stage ?? "—"} | ${layout} |`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Renders the full feature doc markdown from the current pipeline state.
 * Only sections with available deliverables are included.
 */
export function generateFeatureDoc(state: PipelineState, stage: StageId): string {
  return [
    renderHeader(state, stage),
    renderPMSection(state),
    renderJiraSection(state),
    renderDesignSection(state),
    `---`,
    `*Generated by AgentSDLC — ${new Date().toISOString()}*`,
    ``,
  ].join("\n");
}

/**
 * Writes docs/features/<feature-id>.md to the HOST project at state.repo_path.
 * Returns the rendered content so callers can pass it to commitFileToBranch()
 * without re-reading from disk.
 */
export async function updateFeatureDoc(state: PipelineState, stage: StageId): Promise<string> {
  const content = generateFeatureDoc(state, stage);

  if (!state.repo_path) {
    console.warn("  [feature-doc] repo_path not set — skipping doc write");
    return content;
  }

  const docDir  = path.join(state.repo_path, "docs", "features");
  const docPath = path.join(docDir, `${state.feature_id}.md`);

  try {
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(docPath, content, "utf8");
    console.log(`  [feature-doc] Written: ${docPath}`);
  } catch (err) {
    console.warn(`  [feature-doc] Write failed: ${(err as Error).message}`);
  }

  return content;
}
