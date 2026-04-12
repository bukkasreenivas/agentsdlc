// integrations/github.ts
// GitHub REST API client for branch management, PRs, and reviews.
// Also exports a Bitbucket adapter using the same interface.

import { integrations } from "../config/integrations";

const { github: cfg } = integrations;

async function ghFetch<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: unknown
): Promise<T> {
  if (!cfg.token) {
    // Dev mode without GitHub — log and return stub
    console.log(`[GitHub stub] ${method} ${endpoint}`);
    return { html_url: `https://github.com/${cfg.owner}/${cfg.repo}/stub`, number: 1, sha: "abc123" } as unknown as T;
  }

  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      Accept:         "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${method} ${endpoint} → ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Branches ──────────────────────────────────────────────────────────────────

export async function getMainSHA(): Promise<string> {
  const ref = await ghFetch<{ object: { sha: string } }>(
    `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${cfg.defaultBase}`
  );
  return ref.object.sha;
}

export async function createBranch(branchName: string): Promise<void> {
  const sha = await getMainSHA();
  await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/git/refs`, "POST", {
    ref: `refs/heads/${branchName}`,
    sha,
  });
}

export async function branchExists(branchName: string): Promise<boolean> {
  try {
    await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${branchName}`);
    return true;
  } catch {
    return false;
  }
}

// ── Pull Requests ─────────────────────────────────────────────────────────────

export interface PRResult {
  number:   number;
  html_url: string;
  node_id:  string;
}

export async function createPullRequest(params: {
  title: string;
  body:  string;
  head:  string;
  base?: string;
  draft?: boolean;
}): Promise<PRResult> {
  return ghFetch<PRResult>(`/repos/${cfg.owner}/${cfg.repo}/pulls`, "POST", {
    title: params.title,
    body:  params.body,
    head:  params.head,
    base:  params.base ?? cfg.defaultBase,
    draft: params.draft ?? false,
  });
}

export async function updatePRBody(prNumber: number, body: string): Promise<void> {
  await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/pulls/${prNumber}`, "PATCH", { body });
}

// ── PR Reviews ────────────────────────────────────────────────────────────────

export async function approvePR(prNumber: number, body = "Approved by Review Agent after architecture + NFR validation."): Promise<void> {
  await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/pulls/${prNumber}/reviews`, "POST", {
    body,
    event: "APPROVE",
  });
}

export async function createPRReviewComment(prNumber: number, body: string): Promise<void> {
  await ghFetch(`/repos/${cfg.owner}/${cfg.repo}/pulls/${prNumber}/reviews`, "POST", {
    body,
    event: "REQUEST_CHANGES",
  });
}

// ── Gate PR (human-in-the-loop) ───────────────────────────────────────────────

export async function createGatePR(params: {
  stage:           string;
  title:           string;
  body:            string;
  deliverablePath: string;
  featureId:       string;
}): Promise<PRResult> {
  const branchName = `gate/${params.stage}/${params.featureId.slice(0, 8)}`;

  const exists = await branchExists(branchName);
  if (!exists) await createBranch(branchName);

  const fullBody = [
    params.body,
    "",
    "---",
    `**Stage:** \`${params.stage}\``,
    `**Feature ID:** \`${params.featureId}\``,
    `**Deliverable:** \`${params.deliverablePath}\``,
    "",
    "> ⚠️ **Merge this PR to approve and continue the pipeline.**",
    "> Close/reject this PR to reject and kick back.",
  ].join("\n");

  return createPullRequest({
    title: params.title,
    body:  fullBody,
    head:  branchName,
    base:  cfg.defaultBase,
    draft: false,
  });
}

// ── Commits (stub for scaffold — real impl would use git CLI or Octokit) ──────

export async function getLatestCommitSHA(branch: string): Promise<string> {
  const ref = await ghFetch<{ object: { sha: string } }>(
    `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${branch}`
  );
  return ref.object.sha;
}

// ── Bitbucket adapter (same interface, different API) ─────────────────────────

const { bitbucket: bbCfg } = integrations;

function bbAuth() {
  return "Basic " + Buffer.from(`${bbCfg.username}:${bbCfg.appPassword}`).toString("base64");
}

async function bbFetch<T>(endpoint: string, method = "GET", body?: unknown): Promise<T> {
  if (!bbCfg.appPassword) {
    console.log(`[Bitbucket stub] ${method} ${endpoint}`);
    return { id: 1, links: { html: { href: "https://bitbucket.org/stub" } } } as unknown as T;
  }

  const res = await fetch(`https://api.bitbucket.org/2.0${endpoint}`, {
    method,
    headers: {
      Authorization:  bbAuth(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw new Error(`Bitbucket ${method} ${endpoint} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function createBitbucketBranch(branchName: string, sourceBranch = "main"): Promise<void> {
  await bbFetch(`/repositories/${bbCfg.workspace}/${bbCfg.repoSlug}/refs/branches`, "POST", {
    name:   branchName,
    target: { hash: sourceBranch },
  });
}

export async function createBitbucketPR(params: {
  title:       string;
  description: string;
  source:      string;
  destination?: string;
}): Promise<{ id: number; links: { html: { href: string } } }> {
  return bbFetch(
    `/repositories/${bbCfg.workspace}/${bbCfg.repoSlug}/pullrequests`,
    "POST",
    {
      title:       params.title,
      description: params.description,
      source:      { branch: { name: params.source } },
      destination: { branch: { name: params.destination ?? "main" } },
      close_source_branch: true,
    }
  );
}
