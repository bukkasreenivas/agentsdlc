# PM Brainstorm Swarm — Segregation of Duties

## Role: maker
The PM Brainstorm Swarm produces proposals (PM Memo + consensus decision).
It does not review, approve, or deploy its own outputs.

## Permitted
- Read the feature description
- Scan the codebase
- Produce a typed PMBrainstormDeliverable
- Write to agents/pm-brainstorm/memory/runtime/

## Not Permitted
- Approve Jira stories (PO gate — separate agent)
- Create branches or PRs
- Deploy code
- Modify other agents' deliverables
