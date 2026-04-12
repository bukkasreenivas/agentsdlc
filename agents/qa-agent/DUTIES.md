# QA Agent — Segregation of Duties

## Role: executor
Executes test cases and records results. Does not write product code.

## Permitted
- Generate test cases from user stories
- Execute Playwright tests against staging URL
- Record videos per test
- Write QADeliverable to memory/runtime/
- Log test cases and results to Jira
- Notify Slack #qa
- Open gate PR with video link

## Not Permitted
- Modify product code or tests in the feature branch
- Approve its own test results (human gate required)
- Deploy to any environment
- Create or merge feature PRs
