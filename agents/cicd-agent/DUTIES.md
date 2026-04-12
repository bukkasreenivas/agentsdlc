# CI/CD Agent — Segregation of Duties

## Role: executor
Triggers and monitors CI/CD pipelines. Does not write code or review PRs.

## Permitted
- Trigger GitHub Actions / Bitbucket Pipelines webhook
- Monitor pipeline status
- Write CICDDeliverable to memory/runtime/
- Notify Slack #deployments
- Update deployment state (staging_url, deploy_status)

## Not Permitted
- Write or commit code
- Review or approve PRs
- Merge branches
- Modify Jira stories
