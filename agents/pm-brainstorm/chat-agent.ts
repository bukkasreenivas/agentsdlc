// agents/pm-brainstorm/chat-agent.ts
// Single-agent PM brainstorm chat turn.
// Called once per user message — cheap (~3k tokens per turn).
// Asks clarifying questions AND updates a structured PRD draft each turn.

import { withFailover, resolveModel } from "../../config/llm-client";
import { AGENT_MODELS }               from "../../config/agents";
import { loadSkillsForPath, findSkill } from "./skill-registry";
import type { PipelineState, PMChatTurn, PMModularBrainstormDeliverable } from "../../types/state";

export interface ChatTurnResult {
  assistant_reply: string;
  updated_prd:     string;
  prd_complete:    boolean;
  skill_used:      string;
}

// ── PRD template ──────────────────────────────────────────────────────────────

const PRD_TEMPLATE = `# PRD: {TITLE}

## Problem Statement
[TBD — pending: What problem does this solve? Who experiences it?]

## Target Users
[TBD — pending: Which user roles/personas? What is their context?]

## Goals / Non-Goals
**Goals:**
[TBD — pending: What outcomes does this feature achieve?]

**Non-Goals:**
[TBD — pending: What is explicitly out of scope?]

## User Stories
[TBD — pending: Specific jobs-to-be-done from the user's perspective]

## Success Metrics
[TBD — pending: How will we measure success? What are the KPIs?]

## Out of Scope
[TBD — pending: Future phases, related ideas not included]

## Open Questions
[TBD — pending: Unresolved decisions that need stakeholder input]
`;

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(
  state: PipelineState,
  skillBody: string,
  skillName: string,
  currentPrd: string,
): string {
  return `You are an expert Product Manager conducting a structured discovery session.
Your goal: help the PM refine their feature idea into a complete PRD through targeted questioning.

FEATURE BEING EXPLORED: "${state.feature_title}"
DISCOVERY PATH: ${state.pm_brainstorm_path ?? "discovery"}
ACTIVE SKILL: ${skillName}

--- SKILL FRAMEWORK ---
${skillBody}
--- END SKILL ---

CODEBASE CONTEXT:
This is an existing product. Base your analysis on real product constraints, not hypotheticals.

CURRENT PRD STATE:
${currentPrd}

YOUR BEHAVIOUR RULES:
1. Ask 2-3 FOCUSED clarifying questions per turn — not a wall of questions. Prioritise the most important unknown sections first.
2. After the PM answers, UPDATE the PRD with what you've learned. Fill in specific sections with concrete content. Replace [TBD] with real content.
3. Your response MUST be valid JSON (no markdown fences around the whole thing):
   {
     "reply": "<conversational response to PM — acknowledge their input, then ask next questions>",
     "prd": "<FULL updated PRD markdown — copy the whole document with sections filled in>",
     "prd_complete": <true if ALL sections have substantive content, false otherwise>
   }
4. Be direct and structured. Don't pad with generic statements.
5. When prd_complete is true, end your reply with: "The PRD looks solid — you can **Approve & Start PO** or **Run Full PM Thesis** for a deeper strategic review."
6. Never fabricate business context. If you don't know something, ask.`;
}

// ── JSON extractor ────────────────────────────────────────────────────────────

function extractChatResponse(raw: string): { reply: string; prd: string; prd_complete: boolean } {
  const fallback = {
    reply: raw,
    prd: "",
    prd_complete: false,
  };
  try {
    // Strip possible outer markdown fences
    const clean = raw.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    if (start === -1 || end === -1) return fallback;
    const parsed = JSON.parse(clean.slice(start, end + 1));
    return {
      reply:        typeof parsed.reply === "string" ? parsed.reply : raw,
      prd:          typeof parsed.prd   === "string" ? parsed.prd   : "",
      prd_complete: parsed.prd_complete === true,
    };
  } catch {
    return fallback;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runChatTurn(
  state: PipelineState,
  userMessage: string,
): Promise<ChatTurnResult> {
  const pathName    = state.pm_brainstorm_path ?? "discovery";
  const existing    = state.deliverables?.pm_brainstorm?.content as PMModularBrainstormDeliverable | undefined;
  const history: PMChatTurn[] = existing?.chat_history ?? [];
  const currentPrd  = existing?.prd_draft || PRD_TEMPLATE.replace("{TITLE}", state.feature_title || "Feature");

  // Pick primary skill for this path
  const skills     = loadSkillsForPath(pathName);
  const activeSkill = skills[0];
  if (!activeSkill) throw new Error(`No skills found for path: ${pathName}`);

  const skillBody = activeSkill.body.replace(/\$ARGUMENTS/g, state.feature_description || state.feature_title || "");

  // Build message history for the LLM
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const turn of history) {
    messages.push({ role: turn.role, content: turn.text });
  }
  messages.push({ role: "user", content: userMessage });

  const cfg = AGENT_MODELS.pm_chat;
  const systemPrompt = buildSystemPrompt(state, skillBody, activeSkill.name, currentPrd);

  const raw = await withFailover(async (client) => {
    const response = await client.messages.create({
      model:      resolveModel(cfg.model),
      max_tokens: cfg.maxTokens,
      system:     systemPrompt,
      messages,
    });
    return response.content[0].type === "text" ? response.content[0].text : "{}";
  }, "pm:chat");

  const { reply, prd, prd_complete } = extractChatResponse(raw);

  console.log(`  [PM Chat] Turn complete. PRD complete: ${prd_complete}`);
  if (prd_complete) console.log(`  [PM Chat] PRD is ready for approval or thesis.`);

  return {
    assistant_reply: reply,
    updated_prd:     prd || currentPrd,
    prd_complete,
    skill_used:      activeSkill.id,
  };
}
