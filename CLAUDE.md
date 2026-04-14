# AgentSDLC — Project Overview for Claude Code

> **IMPORTANT for Claude Code:** This file describes the AgentSDLC pipeline tool itself.
> The HOST project (the parent folder, `../`) is the actual product being built.
> Do NOT confuse AgentSDLC internals with the host product when generating stories or code.

---

## What is AgentSDLC?

AgentSDLC is a **self-contained multi-agent SDLC pipeline** that installs as `.agentsdlc/` inside any VS Code project. It orchestrates a team of AI agents that take a feature description from idea all the way to QA sign-off — generating Jira tickets, Figma wireframes, architecture decisions, code, CI/CD runs, and test videos along the way.

It is completely independent of the host project:
- Its own `package.json`, `node_modules/`, `tsconfig.json`
- Its own `.env` (credentials never shared with host)
- Its own memory in `memory/` (gitignored by default, except `memory/features/`)
- All commands run from **inside** `.agentsdlc/`

---

## Pipeline stages

```
npm run pipeline:feature "Describe the feature"
  │
  ├─ PM Brainstorm Swarm     5 PM agents debate feasibility, risks, scope
  │                          Output: pm_memo, consensus (build/modify/reject), agreed_scope
  │
  ├─ PO Agent                Reads PM memo + real codebase → Jira Epic + User Stories
  │                          Output: epic_key, user_stories[] with AC + test scenarios
  │
  ├─ ⏸ PO Gate              Human reviews stories in browser UI → Approve / Reject
  │
  ├─ Design Agent            Generates Figma wireframes for each story
  │                          Output: figma_file_key, frame_urls[]
  │
  ├─ ⏸ Design Gate          Human reviews wireframes → Approve / Reject
  │
  ├─ Architect Agent         Reads codebase, writes ADR, creates git branch
  │                          Output: adr_content, feature_branch, frontend_tasks[], backend_tasks[]
  │
  ├─ Dev Swarm               Writes code into host project files (never modifies .agentsdlc/)
  │                          Output: commits[], pr_number
  │
  ├─ NFR Agent               Reviews non-functional requirements (latency, security, DB)
  │                          Output: overall_status (pass/fail), items[], critical_issues[]
  │
  ├─ Review Agent            Peer reviews the PR (blocking vs non-blocking comments)
  │                          Output: decision (approved/changes_requested), comments[]
  │
  ├─ CI/CD Agent             Triggers pipeline, deploys to staging
  │                          Output: deploy_status, staging_url, build_log_url
  │
  ├─ QA Agent                Generates tests, records Playwright video per test case
  │                          Output: test_cases[], passed, failed, pass_rate
  │
  ├─ ⏸ QA Gate              Human reviews test results in browser UI → Approve / Reject
  │
  └─ Done                    All Jira tickets updated, Teams/Slack notified
```

Bug pipeline: `npm run pipeline:bug "description"` or `npm run bug:from-jira PROJ-123`

---

## Folder structure

```
.agentsdlc/
│
├─ agents/
│   ├─ pm-brainstorm/swarm.ts      5-agent PM debate swarm
│   ├─ po-agent/agent.ts           Epic + user story generator
│   ├─ design-agent/agent.ts       Figma wireframe generator
│   ├─ architect-agent/agent.ts    ADR writer + branch creator
│   ├─ dev-swarm/swarm.ts          Code writer (edits host project files)
│   ├─ nfr-agent/agent.ts          Non-functional requirements checker
│   ├─ review-agent/agent.ts       Code reviewer
│   ├─ cicd-agent/agent.ts         CI/CD trigger + deploy
│   ├─ qa-agent/agent.ts           Test generator + Playwright runner
│   └─ bug-pipeline/pipeline.ts    Standalone bug fix pipeline
│
├─ config/
│   ├─ llm-client.ts               Provider switching (Bedrock → Copilot → Anthropic)
│   ├─ agents.ts                   Model + token config per agent
│   └─ integrations.ts             Reads .env, exports typed integration configs
│
├─ graph/
│   └─ pipeline.ts                 LangGraph StateGraph — all nodes, edges, gate nodes
│                                  Key exports: buildGraph()
│                                  Key helpers: wrapNode(), webUIGate(), askTerminalApproval()
│
├─ orchestrator/
│   ├─ run.ts                      CLI entry point — parses args, streams graph, saves state
│   ├─ index.ts                    makeDeliverable(), writeMemory(), logStage(), validateDeliverable()
│   ├─ feature-store.ts            Git-backed persistence — memory/features/<id>/
│   ├─ human-gate.ts               openHumanGatePR() — opens GitHub PR for gate
│   ├─ jira-lifecycle.ts           updateStoriesForStage() — bulk Jira transitions
│   ├─ memory.ts                   writeMemory(), logStage()
│   ├─ validator.ts                validateDeliverable() — required field checks per stage
│   └─ sod.ts                      sodCheck() — segregation of duties enforcement
│
├─ server/
│   ├─ index.ts                    Node.js HTTP server on port 7842
│   │                              Routes: GET /, GET /api/features, GET /api/pending,
│   │                                      POST /api/approve, GET /api/health
│   └─ ui/index.html               Single-page approval dashboard (no framework, CDN marked.js)
│
├─ integrations/
│   ├─ jira.ts                     createEpic(), createUserStory(), createBug(), transitionIssue()
│   ├─ github.ts                   createBranch(), createPullRequest(), mergePR()
│   ├─ figma.ts                    createFile(), createFrame()
│   ├─ slack.ts                    notifyPOForStoryReview(), notifyTeam()
│   └─ teams.ts                    postToChannel() — one webhook per channel
│
├─ tools/
│   ├─ codebase-scanner.ts         scanCodebase(repoPath) — reads HOST project structure
│   │                              Returns: techStack, apiRoutes, keyFileExcerpts, projectIdentity
│   │                              IGNORE_DIRS: .agentsdlc, node_modules, .git, agent-layer, .claude
│   └─ file-writer.ts              writeToHostProject() — writes code with backup + rollback
│
├─ types/
│   └─ state.ts                    All TypeScript types: PipelineState, Deliverable, StageId,
│                                  KickbackRecord, UserStory, PODeliverable, etc.
│
├─ scripts/
│   ├─ init-project.ts             ensureProjectOverview() — auto-generates memory/project-overview.md
│   ├─ upgrade.js                  Safe upgrade preserving .env + memory
│   └─ remove.js                   Clean removal of entire .agentsdlc/
│
├─ memory/
│   ├─ features/<featureId>/       Git-committed deliverables + approvals per feature
│   │   ├─ manifest.json           Feature identity, stage list, Jira/GitHub links
│   │   ├─ pm_brainstorm.json      PM analysis output
│   │   ├─ po.json                 Epic + stories
│   │   ├─ po.pending.json         Exists while UI gate is waiting (deleted after approval)
│   │   ├─ po.approval.json        Written by browser UI on approve/reject
│   │   ├─ approvals.json          Append-only audit log of all approvals
│   │   └─ ...                     Same pattern for design, qa stages
│   ├─ checkpoints/<id>.state.json Full LangGraph state for --resume
│   ├─ project-overview.md         Auto-generated HOST project description (anti-hallucination)
│   └─ runtime/pipeline.log.md     Append-only pipeline event log
│
├─ .env                            Credentials (NEVER commit this)
├─ package.json
└─ tsconfig.json
```

---

## Key types (types/state.ts)

```typescript
type StageId = "pm_brainstorm" | "po" | "design" | "architect" | "dev_swarm"
             | "nfr" | "review" | "cicd" | "qa" | "done" | "escalated";

interface PipelineState {
  feature_id:          string;
  feature_title:       string;
  feature_description: string;
  repo_path:           string;          // path to HOST project root
  current_stage:       StageId;
  deliverables:        Partial<Record<StageId, Deliverable>>;
  human_approvals:     Partial<Record<string, { approved: boolean; comment: string }>>;
  kickbacks:           KickbackRecord[];
  retry_counts:        Partial<Record<StageId, number>>;
  max_retries:         number;
  jira:                { epic_key?: string; story_keys?: string[] };
  github:              { pr_url?: string; branch?: string };
  figma:               { file_key?: string };
  slack:               { po_thread?: string };
  deployment:          { staging_url?: string; deploy_status?: string };
  stage_log:           StageLogEntry[];
  escalated:           boolean;
  escalation_reason?:  string;
}

interface Deliverable {
  stage:        StageId;
  version:      number;
  schema:       string;
  content:      unknown;   // typed per agent
  validated:    boolean;   // set by validator.ts
  produced_at:  string;
  memory_path:  string;
}
```

---

## How human gates work

1. Agent completes and produces a validated deliverable
2. `webUIGate(stage, label, state, summary, detail)` is called in `graph/pipeline.ts`
3. Gate writes `memory/features/<id>/<stage>.pending.json`
4. HTTP server starts on port **7842** (idempotent — safe to call multiple times)
5. Terminal prints: `🌐 Open browser: http://localhost:7842`
6. Gate polls `memory/features/<id>/<stage>.approval.json` every 2 seconds
7. Human opens browser → reviews deliverable → clicks Approve or Reject with comment
8. Browser POSTs to `/api/approve` → server writes approval JSON + commits to git
9. Gate reads the file → pipeline continues within 2 seconds
10. Fallback: terminal prompt if server fails or 30-minute timeout

---

## LLM provider priority

| Priority | Provider | Env var |
|---|---|---|
| 1 | AWS Bedrock (bearer) | `AWS_BEARER_TOKEN_BEDROCK` |
| 1 | AWS Bedrock (keys) | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| 2 | GitHub Copilot proxy | `GITHUB_TOKEN` (also run: `npx @ericc-ch/copilot-api start`) |
| 3 | Anthropic direct | `ANTHROPIC_API_KEY` |

Force a provider: `LLM_PROVIDER=bedrock` in `.agentsdlc/.env`

---

## All npm scripts

```bash
# Pipeline
npm run pipeline:feature "Feature description"   # run feature pipeline
npm run pipeline:feature --resume                # resume from last checkpoint
npm run pipeline:bug "Bug description"           # run bug pipeline
npm run bug:from-jira PROJ-123                   # bug pipeline from Jira ticket

# UI
npm run ui:start                                 # start approval UI server on port 7842
npm run ui:open                                  # open http://localhost:7842 in browser (Windows)

# Setup & maintenance
npm run provider:check                           # show which LLM provider is active
npm run project:init                             # generate memory/project-overview.md
npm run project:reinit                           # force-regenerate project overview
npm run typecheck                                # TypeScript check (tsc --noEmit)
npm run upgrade                                  # upgrade agentsdlc safely
npm run remove                                   # remove .agentsdlc entirely
```

---

## Key patterns

### Adding a new agent
1. Create `agents/<name>/agent.ts` exporting `run<Name>Agent(state: PipelineState): Promise<Partial<PipelineState>>`
2. Use `makeDeliverable()` from `orchestrator/index.ts` to produce the deliverable
3. Add the stage to `StageId` union in `types/state.ts`
4. Add required fields to `REQUIRED_FIELDS` in `orchestrator/index.ts`
5. Register the node in `graph/pipeline.ts` using `wrapNode()`
6. Add edges in `buildGraph()`

### Resume / checkpoint
- Full `PipelineState` saved to `memory/checkpoints/<id>.state.json` after every node
- `wrapNode()` has a resume guard: skips stages where `state.deliverables[stage].validated === true`
- Run with `npm run pipeline:feature --resume` to continue from last saved stage

### Kickback (agent revision)
- If validator rejects a deliverable: `retry_counts[stage]++`, `kickbacks.push(...)`, node returns
- Agent reads `state.kickbacks.findLast(k => k.stage === stageId)` to get feedback
- If `retry_counts[stage] >= max_retries`: routes to `escalate` node
- Human rejection at gate: sets `human_approvals[stage].approved = false`, `comment` = feedback

### Integration stubs
All integrations gracefully degrade when not configured:
- Jira: stubs with `PROJ-XXXX` random key, logs `[Jira stub]`
- GitHub: returns local file path instead of PR URL
- Figma: returns stub file key
- Slack/Teams: logs `[Slack stub]` / `[Teams stub]`

---

## Common commands for Claude Code chat

```bash
# Always cd first
cd .agentsdlc

# Check everything is working
npm run provider:check
npm run typecheck

# Run pipeline
npm run pipeline:feature "Your feature description here"

# If pipeline stopped at a gate, open the UI to approve
npm run ui:start
# then open http://localhost:7842

# Resume if pipeline was interrupted
npm run pipeline:feature --resume
```

---

## What NOT to do

- Do NOT run commands from outside `.agentsdlc/` (except `node .agentsdlc/scripts/remove.js`)
- Do NOT edit the host project's `.env` — AgentSDLC uses `.agentsdlc/.env`
- Do NOT read `.agentsdlc/CLAUDE.md` as product documentation — it describes the pipeline tool, not the host product
- Do NOT add `.agentsdlc/` to `IGNORE_DIRS` exceptions in codebase-scanner — it must be excluded so agents don't hallucinate pipeline internals as product features
- Do NOT commit `.agentsdlc/.env` to git
