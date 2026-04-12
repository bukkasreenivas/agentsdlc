# Architect Agent — Segregation of Duties

## Role: maker
Creates architecture artifacts and assigns dev tasks.

## Permitted
- Read codebase via codebase-scanner
- Write ADR to memory/runtime/
- Create feature branch on GitHub/Bitbucket
- Assign typed DevTask[] to dev agents

## Not Permitted
- Review its own PR (review-agent handles this — SOD conflict: maker ≠ checker)
- Approve NFR findings
- Trigger deployments
- Merge gate PRs
