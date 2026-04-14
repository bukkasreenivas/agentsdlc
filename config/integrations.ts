// config/integrations.ts — reads from .agentsdlc/.env (NOT host project .env)
import * as dotenv from "dotenv";
import * as path   from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const opt = (key: string, fb = "") => process.env[key] ?? fb;

export const integrations = {
  jira: {
    baseUrl:    opt("JIRA_BASE_URL",    "https://yourorg.atlassian.net"),
    email:      opt("JIRA_EMAIL"),
    apiToken:   opt("JIRA_API_TOKEN"),
    projectKey: opt("JIRA_PROJECT_KEY", "PROJ"),
  },
  figma: {
    accessToken: opt("FIGMA_ACCESS_TOKEN"),
    teamId:      opt("FIGMA_TEAM_ID"),
    projectId:   opt("FIGMA_PROJECT_ID"),
  },
  github: {
    token:       opt("GITHUB_TOKEN"),
    owner:       opt("GITHUB_OWNER"),
    repo:        opt("GITHUB_REPO"),
    defaultBase: opt("GITHUB_BASE_BRANCH", "main"),
  },
  bitbucket: {
    username:    opt("BITBUCKET_USERNAME"),
    appPassword: opt("BITBUCKET_APP_PASSWORD"),
    workspace:   opt("BITBUCKET_WORKSPACE"),
    repoSlug:    opt("BITBUCKET_REPO_SLUG"),
  },
  slack: {
    botToken: opt("SLACK_BOT_TOKEN"),
    channels: {
      po:     opt("SLACK_CHANNEL_PO",     "#product"),
      design: opt("SLACK_CHANNEL_DESIGN", "#design"),
      qa:     opt("SLACK_CHANNEL_QA",     "#qa"),
      cicd:   opt("SLACK_CHANNEL_CICD",   "#deployments"),
      arch:   opt("SLACK_CHANNEL_ARCH",   "#engineering"),
    },
  },
  teams: {
    enabled: opt("TEAMS_ENABLED", "true") === "true",
    channels: {
      po:     opt("TEAMS_WEBHOOK_PO"),
      design: opt("TEAMS_WEBHOOK_DESIGN"),
      arch:   opt("TEAMS_WEBHOOK_ARCH"),
      qa:     opt("TEAMS_WEBHOOK_QA"),
      cicd:   opt("TEAMS_WEBHOOK_CICD"),
    },
  },
  playwright: {
    baseUrl:   opt("PLAYWRIGHT_BASE_URL",   "http://localhost:3000"),
    headless:  opt("PLAYWRIGHT_HEADLESS",   "true") !== "false",
    videosDir: opt("PLAYWRIGHT_VIDEOS_DIR", "./qa-videos"),
    slowMo:    parseInt(opt("PLAYWRIGHT_SLOW_MO", "0"), 10),
  },
  project: {
    gitUrl:    opt("PROJECT_GIT_URL"),
  },
  gate: {
    strategy:           opt("GATE_STRATEGY",        "web_ui"),   // "web_ui" | "github_review" | "jira_transition"
    jiraApprovedStatus: opt("JIRA_APPROVED_STATUS", "Ready for Dev"),
  },
};
