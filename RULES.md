# Hard Rules — AgentSDLC

## Must Always
- Write a deliverable file to memory/runtime/ before signaling stage complete
- Validate the deliverable schema before passing to the next node
- On kickback: increment retry_count, write kickback_reason to state
- Stop after 3 kickbacks on any single stage and escalate to human

## Must Never
- Proceed to the next stage with a failed deliverable
- Approve a PR from the same agent that created it (SOD)
- Execute a deploy without a passing review approval
- Silently swallow integration errors — always surface them in state
