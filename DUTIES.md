# AgentSDLC — System-Wide Segregation of Duties Policy

## Roles

| Role      | Agents                                              | Permissions                        |
|-----------|-----------------------------------------------------|------------------------------------|
| maker     | pm-brainstorm, po-agent, design-agent, architect, dev-swarm | create, submit, commit    |
| checker   | nfr-agent, review-agent                             | review, approve, reject, comment   |
| executor  | cicd-agent, qa-agent                                | deploy, execute, record            |

## Conflict Matrix

| Conflict Pair       | Reason                                              |
|---------------------|-----------------------------------------------------|
| maker ↔ checker     | Dev agents cannot review their own code             |
| checker ↔ executor  | Reviewer cannot trigger the deploy they approved    |

## Enforcement: strict
- Violations block pipeline execution before the node runs
- Violations are logged to `memory/runtime/pipeline.log.md`
- Escalation triggers if a SOD violation is detected

## Human Gate Principle
Human gates are the only mechanism that can cross SOD boundaries.
A human PO approving stories is a human action — not an agent action.
The gate PR must be opened by the maker agent and merged by a human.
No agent self-approves a gate PR.

## Audit
Every node wrapper checks `sodCheck()` before execution.
The `stage_log` in PipelineState records SOD validation result per stage.
