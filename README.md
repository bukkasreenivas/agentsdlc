# AgentSDLC

A self-contained multi-agent SDLC pipeline that lives inside any VS Code project as `.agentsdlc/`. It is completely independent of the host project — separate dependencies, separate credentials, separate memory. Drop it in, run it, remove it cleanly when needed.

---

## What it does

You describe a feature. The pipeline handles everything from PM analysis through to QA sign-off:

```
Feature description
  → PM Brainstorm Swarm    5 specialist PM agents debate the feature
  → PO Agent               Creates Jira Epic + User Stories
  → Design Agent           Generates Figma wireframes                    [human gate]
  → Architect Agent        Reads your codebase, writes ADR, creates branch
  → Dev Swarm              Writes code into your actual project files
  → NFR Agent              Reviews latency, DB, security (runs in parallel)
  → Review Agent           Peer reviews the PR
  → CI/CD Agent            Triggers your pipeline, deploys to staging
  → QA Agent               Generates tests, records a video per test     [human gate]
  → Done                   All Jira tickets updated, Teams/Slack notified
```

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
  orchestrator/        pipeline entry point, Jira lifecycle hooks
  tools/               codebase scanner, file writer (with backup + rollback)
  types/               all TypeScript types
  memory/              pipeline audit logs (gitignored)
  scripts/             upgrade.js, remove.js
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
