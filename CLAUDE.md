# AgentSDLC — Claude Code Context

This is the AgentSDLC multi-agent SDLC pipeline, living as a self-contained
subfolder inside a host VS Code project.

## Structure
```
.agentsdlc/              ← YOU ARE HERE (self-contained, independent)
  agents/                ← one folder per agent
  config/                ← llm-client.ts (provider switching), agents.ts, integrations.ts
  graph/                 ← LangGraph pipeline definition
  integrations/          ← Jira, GitHub, Teams, Slack, Figma
  orchestrator/          ← run.ts (entry point), jira-lifecycle.ts
  tools/                 ← codebase-scanner.ts, file-writer.ts
  types/                 ← state.ts (all TypeScript types)
  .env                   ← credentials (NOT host project .env)
  package.json           ← own dependencies (NOT shared with host)
  tsconfig.json          ← own TypeScript config
  CLAUDE.md              ← this file
```

## Key rules
- ALL commands run from INSIDE .agentsdlc/ directory (cd .agentsdlc first)
- Credentials are in .agentsdlc/.env — completely separate from host .env
- LLM providers: Priority 1=Bedrock, Priority 2=Copilot, Priority 3=Anthropic
- The pipeline reads the HOST project (../) to understand existing code but
  never modifies host files without explicit user approval
- To remove: node .agentsdlc/scripts/remove.js (from host project root)

## LLM Provider config
Set in .agentsdlc/.env:
- Bedrock bearer: AWS_BEARER_TOKEN_BEDROCK=your-token, AWS_REGION=us-east-1
- Bedrock keys:   AWS_ACCESS_KEY_ID=..., AWS_SECRET_ACCESS_KEY=..., AWS_REGION=...
- Copilot:        GITHUB_TOKEN=ghp_... (run copilot-api proxy separately)
- Anthropic:      ANTHROPIC_API_KEY=sk-ant-...

## Running
```bash
cd .agentsdlc

# Check which LLM provider is detected
npm run provider:check

# Feature pipeline
npm run pipeline:feature "Add AI-powered reference matching to search"

# Bug pipeline
npm run pipeline:bug "Search returns 500 when query has apostrophe"

# Bug from Jira ticket
npm run bug:from-jira PROJ-456
```

## Common issues
- "Cannot find module" — run npm install from inside .agentsdlc/
- Provider shows ANTHROPIC with no key — check .agentsdlc/.env (not host .env)
- TypeScript errors — ensure you cd into .agentsdlc first
