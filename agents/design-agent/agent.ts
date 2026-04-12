// Design Agent — Claude Sonnet 4
// Uses pm-skills: user-personas, customer-journey-map, value-proposition
// Generates Figma component specs + wireframe descriptions.
// Posts to Figma via API, opens gate PR, notifies Slack #design.
// On kickback: reads designer feedback and revises specific screens.

import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODELS }    from "../../config/agents";
import { integrations }    from "../../config/integrations";
import { createFigmaFile, addDesignSpec, getFigmaShareUrl } from "../../integrations/figma";
import { notifyDesignReview } from "../../integrations/slack";
import { createGatePR }       from "../../integrations/github";
import { makeDeliverable, writeAgentMemory, logStage } from "../../orchestrator/index";
import type { PipelineState } from "../../types/state";

const client = new Anthropic();

export interface DesignDeliverable {
  figma_file_key:   string;
  figma_share_url:  string;
  frame_urls:       string[];
  components:       DesignComponent[];
  screens:          DesignScreen[];
  design_tokens:    DesignTokens;
  accessibility:    string[];
}

export interface DesignComponent {
  name:        string;
  type:        "atom" | "molecule" | "organism" | "template";
  props:       string[];
  variants:    string[];
  description: string;
}

export interface DesignScreen {
  name:          string;
  story_key:     string;
  journey_stage: string;
  layout:        string;
  interactions:  string[];
  edge_states:   string[];    // empty, loading, error states
}

export interface DesignTokens {
  colors:     Record<string, string>;
  typography: Record<string, string>;
  spacing:    string[];
}

export async function runDesignAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  const poDeliverable  = state.deliverables?.po?.content as any;
  const kickbackCount  = state.retry_counts?.design ?? 0;
  const stories        = poDeliverable?.user_stories ?? [];
  const epicSummary    = poDeliverable?.epic_summary ?? state.feature_title;

  // On kickback: include designer feedback
  const lastKickback = state.kickbacks.findLast(k => k.stage === "design");
  const kickbackContext = lastKickback
    ? `\n\nDESIGNER FEEDBACK (Revision ${kickbackCount}): ${lastKickback.actionable}\nRevise ONLY the mentioned screens. Keep approved screens unchanged.`
    : "";

  const cfg = AGENT_MODELS.design;
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: `You are a Design Agent applying pm-skills UX frameworks:
1. user-personas — Design for primary and secondary personas
2. customer-journey-map — Map each screen to a journey stage (Awareness → Consideration → Adoption → Retention)
3. value-proposition — Reflect the 6-part JTBD value prop in the UI

Generate a complete design specification. Output ONLY valid JSON:
{
  "screens": [{
    "name": "string",
    "story_key": "string",
    "journey_stage": "awareness|consideration|adoption|retention",
    "layout": "detailed layout description for Figma",
    "interactions": ["click X → navigate to Y", "hover Z → show tooltip"],
    "edge_states": ["empty state: ...", "loading state: ...", "error state: ..."]
  }],
  "components": [{
    "name": "ComponentName",
    "type": "atom|molecule|organism|template",
    "props": ["propName: type"],
    "variants": ["default", "hover", "disabled", "error"],
    "description": "what this component does"
  }],
  "design_tokens": {
    "colors": { "primary": "#...", "secondary": "#...", "error": "#...", "success": "#...", "background": "#...", "surface": "#..." },
    "typography": { "h1": "font spec", "body": "font spec", "caption": "font spec" },
    "spacing": ["4px", "8px", "16px", "24px", "32px", "48px"]
  },
  "accessibility": ["WCAG 2.1 AA", "keyboard navigation for X", "aria-labels for Y"]
}`,
    messages: [{
      role: "user",
      content: `Epic: ${epicSummary}
Stories: ${stories.map((s: any) => `${s.key}: ${s.summary} — Journey stage: ${s.job_story}`).join("\n")}
${kickbackContext}

Generate the design specification. Output ONLY valid JSON.`,
    }],
  });

  const raw  = response.content[0].type === "text" ? response.content[0].text : "{}";
  const spec = JSON.parse(raw.replace(/```json|```/g, "").trim());

  // Create / update Figma file
  const figmaFile = await createFigmaFile(epicSummary);
  const figmaUrl  = await addDesignSpec(figmaFile.key, {
    title:      epicSummary,
    screens:    spec.screens.map((s: any) => `${s.name} (${s.journey_stage}): ${s.layout.slice(0, 100)}`),
    components: spec.components.map((c: any) => `${c.name} [${c.type}]: ${c.description}`),
    notes:      `Tokens: ${JSON.stringify(spec.design_tokens.colors)}\nA11y: ${spec.accessibility.join(", ")}`,
  });

  const shareUrl = getFigmaShareUrl(figmaFile.key);
  const frameUrls = spec.screens.map((_: any, i: number) =>
    getFigmaShareUrl(figmaFile.key, `screen-${i}`)
  );

  // Open gate PR
  const version = kickbackCount + 1;
  const memoryPath = `agents/design-agent/memory/runtime/design-v${version}.json`;

  let gateUrl = shareUrl;
  try {
    const gatePR = await createGatePR({
      stage:           "design",
      title:           `[GATE] Design Review — ${epicSummary}`,
      body:            `Please review the Figma wireframes.\n\nFigma: ${shareUrl}\n\nScreens: ${spec.screens.map((s: any) => s.name).join(", ")}`,
      deliverablePath: memoryPath,
      featureId:       state.feature_id,
    });
    gateUrl = gatePR.html_url;
  } catch (err) {
    console.warn("Gate PR creation failed:", (err as Error).message);
  }

  // Notify #design on Slack
  await notifyDesignReview(shareUrl, gateUrl, spec.screens.length);

  await writeAgentMemory("design-agent", state.feature_id, {
    event:         "design_complete",
    figma_file:    figmaFile.key,
    screens_count: spec.screens.length,
    components:    spec.components.length,
    kickback_count: kickbackCount,
  });

  const deliverableContent: DesignDeliverable = {
    figma_file_key:  figmaFile.key,
    figma_share_url: shareUrl,
    frame_urls:      frameUrls,
    components:      spec.components,
    screens:         spec.screens,
    design_tokens:   spec.design_tokens,
    accessibility:   spec.accessibility,
  };

  return {
    current_stage: "design",
    deliverables: {
      design: makeDeliverable("design", version, "DesignDeliverable", deliverableContent, memoryPath),
    },
    figma: {
      file_key:  figmaFile.key,
      frame_urls: frameUrls,
    },
    github: { ...state.github, pr_url: gateUrl },
  };
}
