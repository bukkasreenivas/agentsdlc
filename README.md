# AgentSDLC

A self-contained multi-agent SDLC pipeline that lives inside any VS Code project as `.agentsdlc/`. It is completely independent of the host project — separate dependencies, separate credentials, separate memory. Drop it in, run it, remove it cleanly when needed.

---

## What it does

You can drop in rough customer feedback, and the pipeline handles everything from PM Discovery through to QA sign-off across a **Dual-Pipeline**:

**1. Discovery Pipeline (Ideas)**
```text
Customer Idea / Meeting Notes
  → PM Brainstorm Swarm    5 specialist PM agents debate the feature
  → Synthesizer            Generates Product Requirements Document
  → PM Promote Gate        Review the PRD                           [human gate ⏸]
```

**2. Execution Pipeline (Features)**
*Once a PRD is approved, it promotes into Execution:*
```text
  → PO Agent               Creates Jira Epic + User Stories              
  → Design Agent           Generates Figma wireframes                    [human gate ⏸]
  → Architect Agent        Reads tracked codebase, writes ADR, creates branches
  → Dev Swarm              Writes code into your actual project files
  → NFR Agent              Reviews latency, DB, security (runs in parallel)
  → Review Agent           Peer reviews the PR
  → Code PR Gate           Tech Lead review before merging/deploying     [human gate ⏸]
  → CI/CD Agent            Triggers your pipeline, deploys to staging
  → QA Agent               Generates tests, records a video per test     [human gate ⏸]
  → Done                   Jira updated, Teams/Slack notified
```

At each `[human gate ⏸]` the pipeline pauses and opens a **Vercel-like PM Workspace UI** at `http://localhost:7842`. 
The PM/PO/QA team reviews deliverables in a beautiful Light/Dark mode interface with a full Workflow Dashboard tracking your nodes. Approvals push automatically to Git.

It also has a separate bug fix pipeline:
```
Bug report / Jira ticket
  → Triage    → Reproduce (writes a failing test)    → Fix
  → NFR Check → Fix Review → Deploy Fix → Verify    → Jira ticket closed
```

---

## Folder structure

Everything lives inside `.agentsdlc/`. Nothing outside this folder is modified without your approval.

```
.agentsdlc/
  agents/              one folder per agent
  config/              model routing (agents.ts), credentials (integrations.ts), LLM client (llm-client.ts)
  graph/               LangGraph pipeline definition
  integrations/        Jira, GitHub, Bitbucket, Figma, Teams, Slack
  orchestrator/        pipeline entry point, Jira lifecycle hooks, feature-store (git persistence)
  server/              HTTP approval server (index.ts) + browser UI (ui/index.html)
  tools/               codebase scanner, file writer (with backup + rollback)
  types/               all TypeScript types
  memory/
    ideas/             raw discovery, synthesized requirements, and idea approvals
    features/          active SDLC execution artifacts + git persistence
    checkpoints/       resume state for --resume flag
    runtime/           pipeline audit logs
    strategy/          auto-generated context, competitor analysis, and codebase graphs
  scripts/             strategy-sync.ts, upgrade.js, remove.js
  .env                 your credentials — separate from host project .env
  package.json         agent dependencies — separate from host project
  tsconfig.json        TypeScript config scoped to .agentsdlc only
  CLAUDE.md            context file for Claude Code
```

---

## Installation

### Step 1 — Unzip into your project root

Download `agentsdlc.zip` and extract it:

**Mac / Linux:**
```bash
cd your-project/
unzip ~/Downloads/agentsdlc.zip
mv agentsdlc .agentsdlc
```

**Windows (PowerShell):**
```powershell
cd your-project
Expand-Archive -Path "$env:USERPROFILE\Downloads\agentsdlc.zip" -DestinationPath "."
Rename-Item agentsdlc .agentsdlc
```

### Step 2 — Install dependencies

All commands run from **inside `.agentsdlc/`**:

```bash
cd .agentsdlc
npm install
npx playwright install chromium
```

This creates `.agentsdlc/node_modules/` — completely separate from your host project's packages.

### Step 3 — Configure credentials

Edit `.agentsdlc/.env` — this is separate from your host project's `.env`:

```bash
# Priority 1 — AWS Bedrock (bearer token)
AWS_BEARER_TOKEN_BEDROCK=your-bearer-token
AWS_REGION=us-east-1

# Priority 2 — GitHub Copilot (run proxy first: npx @ericc-ch/copilot-api start)
# GITHUB_TOKEN=ghp_...

# Priority 3 — Anthropic direct
# ANTHROPIC_API_KEY=sk-ant-...

# Jira
JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_API_TOKEN=atl_...
JIRA_PROJECT_KEY=PROJ

# GitHub (for branches and PRs)
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo

# Teams (one webhook per channel)
TEAMS_ENABLED=true
TEAMS_WEBHOOK_PO=https://yourorg.webhook.office.com/webhookb2/...
TEAMS_WEBHOOK_ARCH=https://yourorg.webhook.office.com/webhookb2/...
TEAMS_WEBHOOK_QA=https://yourorg.webhook.office.com/webhookb2/...
TEAMS_WEBHOOK_CICD=https://yourorg.webhook.office.com/webhookb2/...
```

Only `AWS_BEARER_TOKEN_BEDROCK` (or one of the other LLM credentials) is required to start. Everything else stubs gracefully if not set.

### Step 4 — Check which provider is active

```bash
npm run provider:check
```

Expected output:
```
Active provider: BEDROCK
  ✓ Bedrock credentials found
  ✗ GitHub Copilot proxy not running
  ✗ Anthropic API key not set
```

### Step 5 — Run

```bash
# Feature pipeline
npm run pipeline:feature "Describe the feature you want to build"

# Bug fix pipeline
npm run pipeline:bug "Describe the bug"

# Bug fix from an existing Jira ticket
npm run bug:from-jira PROJ-123
```

Or use the VS Code task shortcut: **Ctrl+Shift+B** (Windows) / **Cmd+Shift+B** (Mac) → select **AgentSDLC: Run Feature Pipeline**.

---

## LLM provider priority

The pipeline tries providers in this order and falls back automatically if one fails:

| Priority | Provider | What to set in `.agentsdlc/.env` |
|---|---|---|
| 1 | AWS Bedrock | `AWS_BEARER_TOKEN_BEDROCK` or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| 2 | GitHub Copilot | `GITHUB_TOKEN` + run `npx @ericc-ch/copilot-api start` in a separate terminal |
| 3 | Anthropic direct | `ANTHROPIC_API_KEY` |

To force a specific provider: `LLM_PROVIDER=bedrock` (or `copilot` or `anthropic`) in `.agentsdlc/.env`.

---

## Upgrading

When a new version of AgentSDLC is available, use the upgrade script. It preserves all your data automatically.

### What is preserved on upgrade

| Preserved | Why |
|---|---|
| `.env` | Your credentials and webhook URLs |
| `memory/runtime/` | Pipeline audit logs and deliverables |
| `agents/*/memory/runtime/` | Per-agent logs, ADRs, QA results |
| `backups/` | File writer backups (used for rollback) |
| `qa-videos/` | All QA test recordings |

### What gets smart-merged

These files may have been edited by you, so the upgrade keeps your version and saves the new version alongside for comparison:

| File | What happens |
|---|---|
| `config/agents.ts` | Your model routing is kept. New version saved as `config/agents.ts.upgraded` |
| `config/integrations.ts` | Your settings kept. New version saved as `config/integrations.ts.upgraded` |

### How to upgrade

**Step 1 — dry run first** (see what will change, nothing is modified):

```bash
cd .agentsdlc
node scripts/upgrade.js --zip /path/to/new/agentsdlc.zip --dry-run
```

**Step 2 — run the upgrade:**

```bash
node scripts/upgrade.js --zip /path/to/new/agentsdlc.zip
```

**Windows example:**
```powershell
cd .agentsdlc
node scripts/upgrade.js --zip "C:\Users\yourname\Downloads\agentsdlc.zip"
```

Or via VS Code task: **Ctrl+Shift+B** → **AgentSDLC: Upgrade (safe)** — it will prompt for the zip path.

The script will:
1. Save all preserved items to a temp location
2. Extract and install the new version
3. Restore your `.env`, memory, videos, and backups
4. Run `npm install` for any new dependencies
5. Report which config files need manual review (if any)

### After upgrade — review merged config files

If any config files changed between versions, you will see:

```
Config files with changes (your version kept, new version saved as .upgraded):
  config/agents.ts          ← your version (kept)
  config/agents.ts.upgraded ← new version (review and merge manually)
```

Open both files, copy any new settings you want from `.upgraded` into your version, then delete the `.upgraded` file.

---

## Human Approval UI

### How it works

When the pipeline reaches a human gate (PO Stories, Design, or QA), it automatically:

1. Starts a local web server on **port 7842** (if not already running)
2. Writes the deliverable to `memory/features/<featureId>/`
3. Prints the URL in the terminal:
   ```
   🌐 Open browser to review and approve:
      http://localhost:7842
   ```
4. Waits up to **30 minutes** for a browser decision
5. Resumes the pipeline within **2 seconds** of Approve/Reject
6. Commits the approval + all deliverables to git

### Opening the UI

The URL is printed automatically when a gate is reached. You can also open it manually:

```bash
cd .agentsdlc

# Start the UI server (useful for reviewing past features)
npm run ui:start

# Open in browser (Windows)
npm run ui:open
```

Then navigate to: **http://localhost:7842**

### What you see in the UI

| Panel | What it shows |
|---|---|
| Workspace Header | Settings ⚙️ Modal (Connect Git URL natively), Theme toggle (Light/Dark Mode). |
| Workflow Dashboard | Real-time sequence flowchart showing active/completed/pending nodes. |
| Left sidebar | Dual "Ideas" vs "Execution" toggle. All items shown with relative badges. |
| PM Synthesis tab | PRD generated from Customer Feedback, and the AI's consensus build/confidence decision. |
| PO Stories tab | Epic summary with Jira link, user stories, acceptance criteria, test scenarios. |
| Design tab | Figma file key and frame URLs. |
| QA Results tab | Pass rate, passed/failed counts, individual test case results. |
| Floating Approval Panel | Sticky bottom bar active during a gate. Type feedback or click Approve. |

### Approving or rejecting

- **Approve** — click **✓ Approve** (no comment needed). Pipeline continues to next stage immediately.
- **Reject** — type your revision instructions in the text box, then click **✗ Reject**. The feedback is passed back to the agent as a kickback, which revises and re-presents for review.

### Git memory — single source of truth

Every deliverable and approval is committed to git in `memory/features/<featureId>/`:

```
memory/features/<featureId>/
  manifest.json          feature identity, stage list, Jira/GitHub links
  pm_brainstorm.json     PM analysis output
  po.json                Epic + user stories
  po.approval.json       approval record (who approved, when, comment)
  design.json            design output
  design.approval.json
  qa.json                QA results
  qa.approval.json
  approvals.json         append-only audit log of all approvals
```

Git commits are made automatically at:
- Each human approval or rejection (with `approvedBy`, timestamp, comment)
- Pipeline completion (`done`)
- Pipeline escalation (`escalated`)

### Fallback behaviour

If the server fails to start, or 30 minutes pass with no browser action, the pipeline falls back to the original **terminal prompt**:

```
▶  Approve and proceed?  [Enter/Y = approve  |  type feedback = revise]:
```

---

## Using with Claude Code

Open `.agentsdlc/` as a workspace in Claude Code. The `CLAUDE.md` file inside gives Claude Code full context about the project automatically — it knows the folder structure, how to run the pipeline, and how credentials are configured.

---

## Removing completely

Run from your **host project root** (not inside `.agentsdlc/`):

```bash
node .agentsdlc/scripts/remove.js
```

This removes `.agentsdlc/` entirely including all agent code, memory, and logs. Your host project files are not touched.

---

## Troubleshooting

**"Cannot find module" errors**
Run `npm install` from inside `.agentsdlc/` — not from your host project root.

**Provider shows ANTHROPIC with no key set**
Check `.agentsdlc/.env` — not your host project `.env`. They are separate files.

**TypeScript errors when running**
Make sure you `cd .agentsdlc` first. The `tsconfig.json` inside is scoped to the agent project only.

**Teams messages not arriving**
Each channel needs its own webhook URL. Teams: channel → `...` → Connectors → Incoming Webhook → Configure → copy URL → paste into `TEAMS_WEBHOOK_*` in `.agentsdlc/.env`.

**Bedrock bearer token not detected**
Use the variable name `AWS_BEARER_TOKEN_BEDROCK` exactly. Run `npm run provider:check` to confirm detection.
