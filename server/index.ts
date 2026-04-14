// server/index.ts
// AgentSDLC Web UI — Human approval gate server
// Built on Node.js built-in http module (no Express needed).
//
// Routes:
//   GET  /                          → serve approval SPA
//   GET  /api/health                → {ok:true}
//   GET  /api/features              → list all features with manifests
//   GET  /api/features/:id          → feature manifest + all stage data
//   GET  /api/features/:id/:stage   → single stage data
//   GET  /api/pending               → all pending gates (active human gates)
//   POST /api/approve               → body: {featureId, stage, approved, comment, approvedBy?}
//
// The server is a singleton — startServer() is idempotent.

import * as http  from "http";
import * as fs    from "fs";
import * as path  from "path";
import * as url   from "url";
import { spawn }  from "child_process";

import {
  listFeatures,
  readManifest,
  readStageData,
  listAllPending,
  writeApproval,
  deletePending,
  commitToGit,
  ApprovalRecord,
  featureDir,
} from "../orchestrator/feature-store";

// ── Singleton server state ───────────────────────────────────────────────────

let server: http.Server | null = null;
let currentPort = 0;

export const DEFAULT_PORT = 7842;

// ── Path to UI HTML ──────────────────────────────────────────────────────────

const UI_HTML = path.join(__dirname, "ui", "index.html");

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control":               "no-cache",
  });
  res.end(body);
}

function html(res: http.ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function notFound(res: http.ServerResponse, msg = "Not found"): void {
  json(res, { error: msg }, 404);
}

function badRequest(res: http.ServerResponse, msg: string): void {
  json(res, { error: msg }, 400);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── Request handler ──────────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const parsed   = url.parse(req.url ?? "/", true);
  const pathname = parsed.pathname ?? "/";
  const method   = req.method ?? "GET";

  // CORS pre-flight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // ── GET / ───────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/") {
    if (fs.existsSync(UI_HTML)) {
      html(res, fs.readFileSync(UI_HTML, "utf8"));
    } else {
      html(res, "<h1>AgentSDLC UI</h1><p>UI file not found. Run from inside .agentsdlc/</p>", 503);
    }
    return;
  }

  // ── GET /api/health ─────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/health") {
    json(res, { ok: true, port: currentPort, time: new Date().toISOString() });
    return;
  }

  // ── GET /api/features ───────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/features") {
    json(res, listFeatures("features"));
    return;
  }

  // ── GET /api/ideas ──────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/ideas") {
    json(res, listFeatures("ideas"));
    return;
  }

  // ── GET /api/pending ────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/pending") {
    const pendingF = listAllPending("features");
    const pendingI = listAllPending("ideas");
    json(res, [...pendingF, ...pendingI].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
    return;
  }

  // ── GET /api/features/:id (or /api/ideas/:id) ───────────────────────────────
  const itemMatch = pathname.match(/^\/api\/(features|ideas)\/([^/]+)$/);
  if (method === "GET" && itemMatch) {
    const type     = itemMatch[1] as "features" | "ideas";
    const itemId   = itemMatch[2];
    const manifest = readManifest(itemId, type);
    if (!manifest) { notFound(res, `Item ${itemId} not found`); return; }

    // Read all stage files for this feature/idea
    const stagesData: Record<string, unknown> = {};
    const dir = featureDir(itemId, type);
    if (fs.existsSync(dir)) {
      for (const fname of fs.readdirSync(dir)) {
        const m = fname.match(/^([a-z_]+)\.json$/);
        if (m && !fname.includes(".approval") && !fname.includes(".pending")) {
          try {
            stagesData[m[1]] = JSON.parse(fs.readFileSync(path.join(dir, fname), "utf8"));
          } catch { /* skip */ }
        }
      }
    }

    json(res, { manifest, stages: stagesData });
    return;
  }

  // ── GET /api/features/:id/:stage (or /api/ideas/:id/:stage) ─────────────────
  const stageMatch = pathname.match(/^\/api\/(features|ideas)\/([^/]+)\/([^/]+)$/);
  if (method === "GET" && stageMatch) {
    const type      = stageMatch[1] as "features" | "ideas";
    const featureId = stageMatch[2];
    const stage     = stageMatch[3];
    const data      = readStageData(featureId, stage, type);
    if (!data) { notFound(res, `Stage ${stage} not found for item ${featureId}`); return; }
    json(res, data);
    return;
  }

  // ── GET /api/settings ───────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/settings") {
    const envPath = path.resolve(__dirname, "../.env");
    let envContent = "";
    if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, "utf8");

    // Prefer explicit PROJECT_GIT_URL; fall back to constructing from GITHUB_OWNER + GITHUB_REPO
    let gitUrl = envContent.match(/^PROJECT_GIT_URL=(.*)$/m)?.[1] ?? "";
    if (!gitUrl) {
      const owner = envContent.match(/^GITHUB_OWNER=(.*)$/m)?.[1] ?? "";
      const repo  = envContent.match(/^GITHUB_REPO=(.*)$/m)?.[1] ?? "";
      if (owner && repo) gitUrl = `https://github.com/${owner}/${repo}.git`;
    }

    const settings = {
      project_git_url:   gitUrl,
      host_project_path: envContent.match(/^HOST_PROJECT_PATH=(.*)$/m)?.[1] ?? "",
      llm_provider:      envContent.match(/^LLM_PROVIDER=(.*)$/m)?.[1] ?? "",
      jira_project_key:  envContent.match(/^JIRA_PROJECT_KEY=(.*)$/m)?.[1] ?? "",
    };
    json(res, settings);
    return;
  }

  // ── POST /api/approve ───────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/approve") {
    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      badRequest(res, "Invalid JSON body"); return;
    }

    const { featureId, stage, approved, comment, approvedBy, type = "features" } = body;
    if (!featureId || !stage || approved === undefined) {
      badRequest(res, "Required: featureId, stage, approved"); return;
    }

    const rec: ApprovalRecord = {
      featureId,
      stage,
      approved:   Boolean(approved),
      comment:    comment ?? "",
      approvedBy: approvedBy ?? "human",
      approvedAt: new Date().toISOString(),
    };

    writeApproval(featureId, stage, rec, type as "features" | "ideas");
    deletePending(featureId, stage, type as "features" | "ideas");

    // Commit approval to git
    const verb = approved ? "approved" : "rejected";
    commitToGit(featureId, `${stage} ${verb} by ${rec.approvedBy}`, type as "features" | "ideas");

    console.log(`\n  [UI] ${stage} ${verb} for ${featureId.slice(0, 8)} — "${comment ?? ""}"`);
    json(res, { ok: true, record: rec });
    return;
  }

  // ── POST /api/trigger ───────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/trigger") {
    let body: any;
    try { body = JSON.parse(await readBody(req)); } catch { badRequest(res, "Invalid JSON body"); return; }

    const { title, description } = body;
    if (!title && !description) {
      badRequest(res, "Required: title or description"); return;
    }

    // Join with plain ASCII separator; strip any double-quotes to avoid shell breakage
    const featureText = [title, description].filter(Boolean).join(" - ").replace(/"/g, "'");
    const agentsdlcDir = path.resolve(__dirname, "..");

    // Log file — written next to the existing pipeline log
    const logDir  = path.join(agentsdlcDir, "memory", "runtime");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `pipeline-${Date.now()}.log`);
    const logFd   = fs.openSync(logFile, "a");

    // Build a single command string so Windows cmd.exe quotes the feature text correctly
    const cmd = `npx ts-node orchestrator/run.ts --feature "${featureText}"`;
    const child = spawn(cmd, [], {
      cwd:      agentsdlcDir,
      detached: true,
      stdio:    ["ignore", logFd, logFd],
      env:      { ...process.env },
      shell:    true,
    });
    child.unref();
    fs.closeSync(logFd);

    console.log(`\n  [UI] Pipeline triggered: "${featureText.slice(0, 60)}..."`);
    console.log(`  [UI] Log: ${logFile}`);
    json(res, { ok: true, message: "Pipeline started. Refresh the sidebar in a few seconds.", logFile });
    return;
  }

  // ── GET /api/logs/:filename ─────────────────────────────────────────────────
  const logMatch = pathname.match(/^\/api\/logs\/([^/]+\.log)$/);
  if (method === "GET" && logMatch) {
    const logPath = path.join(path.resolve(__dirname, ".."), "memory", "runtime", logMatch[1]);
    if (!fs.existsSync(logPath)) { notFound(res, "Log file not found"); return; }
    const content = fs.readFileSync(logPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(content);
    return;
  }

  // ── POST /api/settings ──────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/settings") {
    let body: any;
    try { body = JSON.parse(await readBody(req)); } catch { badRequest(res, "Invalid JSON body"); return; }
    
    const envPath = path.resolve(__dirname, "../.env");
    let envContent = "";
    if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, "utf8");

    // If project_git_url is a GitHub HTTPS URL, also keep GITHUB_OWNER/REPO/BASE_BRANCH in sync
    const gitUrl = (body.project_git_url as string | undefined)?.trim() ?? "";
    if (gitUrl) {
      const ghMatch = gitUrl.match(/github\.com[/:]([\/\w.-]+?)\/([\/\w.-]+?)(\.git)?$/);
      if (ghMatch) {
        body.github_owner = ghMatch[1];
        body.github_repo  = ghMatch[2];
        // Preserve existing base branch or default to main
        if (!body.github_base_branch) {
          body.github_base_branch = envContent.match(/^GITHUB_BASE_BRANCH=(.*)$/m)?.[1] ?? "main";
        }
      }
    }
    
    // Update or append each setting key in the .env file
    for (const [k, v] of Object.entries(body)) {
      const key = k.toUpperCase();
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${v}`);
      } else {
        envContent += `\n${key}=${v}`;
      }
    }
    
    fs.writeFileSync(envPath, envContent, "utf8");
    console.log(`  [UI] Updated settings: ${Object.keys(body).join(", ")}`);
    json(res, { ok: true });
    return;
  }

  notFound(res);
}

// ── Start/stop ───────────────────────────────────────────────────────────────

export function startServer(port = DEFAULT_PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) { resolve(currentPort); return; }

    server = http.createServer((req, res) => {
      handleRequest(req, res).catch(err => {
        console.error("[server] request error:", err.message);
        json(res, { error: "Internal server error" }, 500);
      });
    });

    server.listen(port, "0.0.0.0", () => {
      currentPort = port;
      console.log(`\n  🌐 AgentSDLC UI: http://localhost:${port}\n`);
      resolve(port);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Port already in use — another instance may be running; that's fine
        console.log(`  [server] Port ${port} in use — assuming UI already running`);
        currentPort = port;
        server = null;  // don't hold the failed server reference
        resolve(port);
      } else {
        reject(err);
      }
    });
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => { server = null; currentPort = 0; resolve(); });
  });
}

export function getPort(): number { return currentPort; }
