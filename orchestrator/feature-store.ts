// orchestrator/feature-store.ts
// Git-backed feature persistence layer.
// Every stage deliverable, approval, and manifest is written to
// memory/features/<featureId>/ so git becomes the single source of truth.
//
// Layout:
//   memory/features/<featureId>/
//     manifest.json          — feature identity + stage completion list
//     <stage>.json           — raw deliverable content from each agent
//     <stage>.pending.json   — exists while a human gate is waiting for approval
//     <stage>.approval.json  — written by web UI POST /api/approve
//     approvals.json         — append-only audit log of all approvals
//
// Git commits are made at:
//   1. Each stage completion (non-blocking, soft-fail)
//   2. Each human approval / rejection
//   3. Pipeline done / escalated

import * as fs   from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ── Path helpers ─────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, "..");

export type StoreType = "features" | "ideas";

export function featuresDir(type: StoreType = "features"): string {
  return path.join(PROJECT_ROOT, "memory", type);
}

export function featureDir(featureId: string, type: StoreType = "features"): string {
  return path.join(featuresDir(type), featureId);
}

function ensure(featureId: string, type: StoreType = "features"): void {
  fs.mkdirSync(featureDir(featureId, type), { recursive: true });
}

export function deleteFeature(featureId: string, type: StoreType = "features"): void {
  const dir = featureDir(featureId, type);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export interface FeatureManifest {
  featureId:    string;
  featureTitle: string;
  startedAt:    string;
  updatedAt:    string;
  repoPath:     string;
  requestedBy:  string;
  stages:       string[];
  currentStage: string;
  status:       "running" | "done" | "escalated";
  jira?:        { epicKey?: string; storyKeys?: string[] };
  github?:      { prUrl?: string };
  storeType?:   StoreType; // helps UI determine if idea or feature
}

export function writeManifest(featureId: string, manifest: FeatureManifest, type: StoreType = "features"): void {
  ensure(featureId, type);
  fs.writeFileSync(
    path.join(featureDir(featureId, type), "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
}

export function readManifest(featureId: string, type: StoreType = "features"): FeatureManifest | null {
  const f = path.join(featureDir(featureId, type), "manifest.json");
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

export function listFeatures(type: StoreType = "features"): FeatureManifest[] {
  const dir = featuresDir(type);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(d => fs.statSync(path.join(dir, d)).isDirectory())
    .map(d => readManifest(d, type))
    .filter((m): m is FeatureManifest => m !== null)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

// ── Stage deliverable ─────────────────────────────────────────────────────────

export function writeStageData(featureId: string, stage: string, data: unknown, type: StoreType = "features"): void {
  ensure(featureId, type);
  fs.writeFileSync(
    path.join(featureDir(featureId, type), `${stage}.json`),
    JSON.stringify({ stage, data, writtenAt: new Date().toISOString() }, null, 2)
  );
}

export function readStageData(featureId: string, stage: string, type: StoreType = "features"): unknown | null {
  const f = path.join(featureDir(featureId, type), `${stage}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

// ── Pending gate ─────────────────────────────────────────────────────────────
// A <stage>.pending.json file signals the UI that a gate is waiting.
// It carries the deliverable summary so the UI can render it without
// needing to load the full stage file.

export interface PendingGate {
  featureId:    string;
  featureTitle: string;
  stage:        string;
  stageLabel:   string;
  summary:      string;       // short human-readable summary of what to review
  detail:       unknown;      // full deliverable content for the UI
  createdAt:    string;
  timeoutAt:    string;       // ISO — UI shows a countdown
}

export function writePending(featureId: string, stage: string, pending: PendingGate, type: StoreType = "features"): void {
  ensure(featureId, type);
  fs.writeFileSync(
    path.join(featureDir(featureId, type), `${stage}.pending.json`),
    JSON.stringify(pending, null, 2)
  );
}

export function deletePending(featureId: string, stage: string, type: StoreType = "features"): void {
  const f = path.join(featureDir(featureId, type), `${stage}.pending.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function readPending(featureId: string, stage: string, type: StoreType = "features"): PendingGate | null {
  const f = path.join(featureDir(featureId, type), `${stage}.pending.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

export function listAllPending(type: StoreType = "features"): PendingGate[] {
  const dir = featuresDir(type);
  if (!fs.existsSync(dir)) return [];
  const results: PendingGate[] = [];
  for (const fid of fs.readdirSync(dir)) {
    const d = path.join(dir, fid);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const fname of fs.readdirSync(d)) {
      if (fname.endsWith(".pending.json")) {
        try {
          results.push(JSON.parse(fs.readFileSync(path.join(d, fname), "utf8")));
        } catch { /* skip */ }
      }
    }
  }
  return results.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

// ── Approval ─────────────────────────────────────────────────────────────────

export interface ApprovalRecord {
  featureId:   string;
  stage:       string;
  approved:    boolean;
  comment:     string;
  approvedBy:  string;          // "human" | email | name
  approvedAt:  string;
}

export function writeApproval(featureId: string, stage: string, rec: ApprovalRecord, type: StoreType = "features"): void {
  ensure(featureId, type);
  // Per-stage approval file (polled by webUIGate)
  fs.writeFileSync(
    path.join(featureDir(featureId, type), `${stage}.approval.json`),
    JSON.stringify(rec, null, 2)
  );
  // Append to audit log
  const auditPath = path.join(featureDir(featureId, type), "approvals.json");
  let history: ApprovalRecord[] = [];
  if (fs.existsSync(auditPath)) {
    try { history = JSON.parse(fs.readFileSync(auditPath, "utf8")); } catch { history = []; }
  }
  history.push(rec);
  fs.writeFileSync(auditPath, JSON.stringify(history, null, 2));
}

export function readApproval(featureId: string, stage: string, type: StoreType = "features"): ApprovalRecord | null {
  const f = path.join(featureDir(featureId, type), `${stage}.approval.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

export function readApprovalHistory(featureId: string, type: StoreType = "features"): ApprovalRecord[] {
  const f = path.join(featureDir(featureId, type), "approvals.json");
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; }
}

// ── Git commit ────────────────────────────────────────────────────────────────
// Commits memory/features/<featureId>/ to git so every output is traceable.
// Non-blocking: logs warnings on failure (e.g. not a git repo, nothing staged).

export function commitToGit(featureId: string, message: string, type: StoreType = "features"): void {
  try {
    // Resolve host project root (parent of .agentsdlc/)
    const hostRoot = path.resolve(PROJECT_ROOT, "..");
    const relPath  = path.relative(hostRoot, featureDir(featureId, type));

    execSync(`git add "${relPath}"`, { cwd: hostRoot, stdio: "pipe" });
    execSync(
      `git commit -m "[agentsdlc] ${message} (feature: ${featureId.slice(0, 8)})"`,
      { cwd: hostRoot, stdio: "pipe" }
    );
    console.log(`  [git] Committed: ${message}`);
  } catch (err: any) {
    // Non-fatal — pipeline continues even if git is not configured
    const msg = err?.stderr?.toString() ?? err?.message ?? "unknown";
    if (!msg.includes("nothing to commit")) {
      console.warn(`  [git] Commit skipped: ${msg.split("\n")[0]}`);
    }
  }
}

// ── Full pipeline state snapshot ──────────────────────────────────────────────
// Called from run.ts stream loop to persist the entire LangGraph state after
// every node. This is separate from the memory/checkpoints/ used by --resume.
// The feature store is for human review; checkpoints are for machine recovery.

export function syncFromPipelineState(featureId: string, state: any, type: StoreType = "features"): void {
  try {
    const manifest = readManifest(featureId, type);
    const stages = Object.keys(state.deliverables ?? {}).filter(
      k => state.deliverables[k]?.validated
    );

    writeManifest(featureId, {
      featureId,
      featureTitle: state.feature_title ?? featureId,
      startedAt:    manifest?.startedAt ?? state.created_at ?? new Date().toISOString(),
      updatedAt:    new Date().toISOString(),
      repoPath:     state.repo_path ?? "",
      requestedBy:  state.requested_by ?? "cli",
      stages,
      currentStage: state.current_stage ?? "unknown",
      status:       state.current_stage === "done"      ? "done"
                  : state.current_stage === "escalated" ? "escalated"
                  : "running",
      jira:   { epicKey: state.jira?.epic_key, storyKeys: state.jira?.story_keys },
      github: { prUrl: state.github?.pr_url },
      storeType: type,
    }, type);

    // Write each validated deliverable as its own file for the UI
    for (const [stage, deliverable] of Object.entries(state.deliverables ?? {})) {
      if (deliverable) writeStageData(featureId, stage, deliverable, type);
    }
  } catch (err: any) {
    console.warn(`  [feature-store] sync failed: ${err?.message}`);
  }
}
