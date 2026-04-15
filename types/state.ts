// ─────────────────────────────────────────────────────────────────────────────
// AgentSDLC v2 — LangGraph State Schema
//
// Every node in the graph reads from and writes to PipelineState.
// LangGraph persists this between node executions, enabling:
//   - Kickback loops (retry_count, kickback_reason)
//   - Human gates (human_approvals, branch PRs)
//   - Full audit trail (stage_log)
// ─────────────────────────────────────────────────────────────────────────────

export type StageId =
  | "pm_brainstorm"
  | "pm_promote"
  | "po"
  | "design"
  | "architect"
  | "dev_swarm"
  | "nfr"
  | "review"
  | "code_pr"
  | "cicd"
  | "qa"
  | "done"
  | "escalated";

export type KickbackReason =
  | "pm_fit_rejected"       // PM brainstorm consensus: don't build this
  | "po_stories_rejected"   // PO approval denied
  | "design_rejected"       // Design approval denied
  | "nfr_critical_fail"     // NFR agent found blocking issues
  | "review_changes_req"    // Review agent requested changes
  | "ci_build_failed"       // CI/CD build red
  | "qa_tests_failed"       // QA tests below pass threshold
  | "max_retries_exceeded"; // 3 kickbacks hit — escalate

export interface KickbackRecord {
  stage: StageId;
  reason: KickbackReason;
  detail: string;           // Structured detail — what exactly failed
  retry_count: number;
  timestamp: string;
  actionable: string;       // Specific instruction to the target agent
}

export interface Deliverable {
  stage: StageId;
  version: number;          // Increments on each kickback + rework
  schema: string;           // Which TypeScript interface this satisfies
  content: unknown;         // The actual typed payload
  validated: boolean;
  produced_at: string;
  memory_path: string;      // agents/<name>/memory/runtime/<stage>-v<n>.json
}

// ── PM Modular Brainstorm (new) ───────────────────────────────────────────────

export interface PMChatTurn {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  skill_used?: string;       // which SKILL.md was active for this assistant turn
  prd_snapshot?: string;     // PRD state after this assistant turn
}

export interface PMModularBrainstormDeliverable {
  feature_id: string;
  feature_title: string;
  path: "discovery" | "competitor" | "synthesis";
  chat_history: PMChatTurn[];
  prd_draft: string;         // living PRD markdown — updated every agent turn
  prd_complete: boolean;     // agent signals all sections are filled
  prd_approved: boolean;     // PM clicked Approve
  prd_github_url?: string;   // URL of committed PRD.md in host repo
  // Populated only after thesis runs:
  brainstorm_rounds?: BrainstormRound[];
  consensus?: PMConsensus;
  pm_memo?: string;
}

// PM Brainstorm deliverable — output of the multi-agent swarm (legacy)
export interface PMBrainstormDeliverable {
  feature_id: string;
  feature_title: string;
  brainstorm_rounds: BrainstormRound[];
  consensus: PMConsensus;
  pm_memo: string;          // Final synthesized markdown memo
  chat_history: { role: string; text: string; timestamp: string }[];
}

export interface BrainstormRound {
  agent_id: string;         // "visionary" | "critic" | "data_analyst" | "user_advocate" | "technical_pm"
  perspective: string;
  fit_score: number;        // 1-10
  arguments_for: string[];
  arguments_against: string[];
  pm_skills_used: string[]; // Which pm-skills commands were applied
  // Discovery outputs (optional)
  swot?: { strengths: string[]; weaknesses: string[]; opportunities: string[]; threats: string[] };
  sentiment_summary?: string;
  riskiest_assumptions?: Array<{ assumption: string; impact: number; uncertainty: number }>;
  lean_canvas?: { problem: string; solution: string; unique_value_prop: string; unfair_advantage: string };
  market_parity_features?: string[];
}

export interface PMConsensus {
  build_decision: "proceed" | "modify" | "reject";
  confidence: number;       // 0-1
  agreed_scope: string;
  open_risks: string[];
  north_star_impact: string;
  ost_opportunity: string;  // Opportunity Solution Tree node
}

// Discovery deliverable
export interface DiscoveryDeliverable {
  feature_id: string;
  signals_count: number;
  sentiment_score: number; // 0-1
  swot: {
    strengths: string[];
    weaknesses: string[];
    opportunities: string[];
    threats: string[];
  };
  ost: Array<{
    outcome: string;
    opportunities: Array<{
      title: string;
      description: string;
      rationale: string;
      market_parity: boolean; // Must-have to stay afloat
    }>;
  }>;
  competitors_searched: string[];
}

// PO deliverable
export interface PODeliverable {
  epic_key: string;
  epic_summary: string;
  user_stories: UserStory[];
  story_map_url: string;
  slack_thread_url: string;
}

export interface UserStory {
  key: string;
  summary: string;
  acceptance_criteria: string[];
  story_points: number;
  epic_key?: string;        // Jira epic link
  job_story: string;        // "When X, I want Y, so I can Z" (pm-skills job-stories)
  wwa: string;              // Why-What-Acceptance format
  test_scenarios: string[];
}

// Architecture deliverable
export interface ArchitectureDeliverable {
  adr_path: string;         // agents/architect-agent/memory/runtime/adr-v<n>.md
  adr_content: string;
  feature_branch: string;
  pr_url?: string;
  frontend_tasks: DevTask[];
  backend_tasks: DevTask[];
  db_schema_changes: string[];
  api_contracts: string[];  // OpenAPI snippets
}

export interface DevTask {
  id: string;
  description: string;
  file_paths: string[];
  agent: "frontend" | "backend";
  model: string;
  estimated_loc: number;
  test_file_paths: string[];
}

// NFR deliverable
export interface NFRDeliverable {
  overall_status: "pass" | "warn" | "fail";
  critical_issues: string[];
  items: NFRItem[];
  recommendations: string[];
}

export interface NFRItem {
  category: "latency" | "db" | "caching" | "security" | "error_handling" | "rate_limit" | "observability";
  requirement: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  remediation?: string;     // Specific fix instruction if fail/warn
}

// Review deliverable
export interface ReviewDeliverable {
  pr_number: number;
  pr_url: string;
  decision: "approved" | "changes_requested";
  comments: ReviewComment[];
  sod_validated: boolean;
  nfr_compliance: boolean;
  coverage_pct: number;
}

export interface ReviewComment {
  file: string;
  line?: number;
  severity: "blocking" | "suggestion" | "nitpick";
  body: string;
  resolved: boolean;
}

// QA deliverable
export interface QADeliverable {
  test_cases: QATestCase[];
  passed: number;
  failed: number;
  pass_rate: number;
  videos_dir: string;
  jira_test_run_url: string;
  slack_summary_url: string;
}

export interface QATestCase {
  id: string;
  title: string;
  story_key: string;
  steps: string[];
  expected_result: string;
  status: "pass" | "fail" | "skip";
  video_path?: string;
  error_message?: string;
  duration_ms?: number;
}

// ── Root Pipeline State (LangGraph channel) ───────────────────────────────────
export interface PipelineState {
  // Identity
  feature_id: string;
  feature_title: string;
  feature_description: string;
  repo_path: string;
  requested_by: string;
  created_at: string;
  pipeline_mode: "idea" | "feature" | "discovery";
  is_discovery?: boolean;

  // PM modular brainstorm (new)
  pm_brainstorm_path?: "discovery" | "competitor" | "synthesis";
  pm_thesis_requested?: boolean;   // PM clicked Run Thesis → triggers full 5-PM swarm

  // Graph navigation
  current_stage: StageId;
  next_stage: StageId | null;
  stage_history: StageId[];

  // Kickback tracking
  kickbacks: KickbackRecord[];
  retry_counts: Partial<Record<StageId, number>>;
  max_retries: number;      // default: 3

  // Deliverables (typed, versioned)
  deliverables: Partial<Record<StageId, Deliverable>>;

  // Human gates
  human_approvals: Partial<Record<StageId, {
    approved: boolean;
    reviewer: string;
    comment?: string;
    approved_at?: string;
    gate_url: string;
  }>>;

  // Integration outputs (raw references, not full content)
  jira: {
    epic_key?: string;
    story_keys?: string[];
    test_run_key?: string;
  };
  github: {
    feature_branch?: string;
    pr_number?: number;
    pr_url?: string;
  };
  figma: {
    file_key?: string;
    frame_urls?: string[];
  };
  slack: {
    po_thread?: string;
    design_thread?: string;
    qa_thread?: string;
    cicd_thread?: string;
  };
  deployment: {
    staging_url?: string;
    deploy_status?: "pending" | "running" | "success" | "failed";
    build_log_url?: string;
  };

  // Audit log (append-only)
  stage_log: StageLogEntry[];

  // Escalation
  escalated: boolean;
  escalation_reason?: string;
}

export interface StageLogEntry {
  stage: StageId;
  event: "started" | "completed" | "kicked_back" | "human_gate" | "approved" | "escalated";
  timestamp: string;
  detail: string;
  deliverable_version?: number;
}
