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
    json(res, listFeatures());
    return;
  }

  // ── GET /api/pending ────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/pending") {
    json(res, listAllPending());
    return;
  }

  // ── GET /api/features/:id ───────────────────────────────────────────────────
  const featureMatch = pathname.match(/^\/api\/features\/([^/]+)$/);
  if (method === "GET" && featureMatch) {
    const featureId = featureMatch[1];
    const manifest  = readManifest(featureId);
    if (!manifest) { notFound(res, `Feature ${featureId} not found`); return; }

    // Read all stage files for this feature
    const stagesData: Record<string, unknown> = {};
    const dir = featureDir(featureId);
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

  // ── GET /api/features/:id/:stage ────────────────────────────────────────────
  const stageMatch = pathname.match(/^\/api\/features\/([^/]+)\/([^/]+)$/);
  if (method === "GET" && stageMatch) {
    const featureId = stageMatch[1];
    const stage     = stageMatch[2];
    const data      = readStageData(featureId, stage);
    if (!data) { notFound(res, `Stage ${stage} not found for feature ${featureId}`); return; }
    json(res, data);
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

    const { featureId, stage, approved, comment, approvedBy } = body;
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

    writeApproval(featureId, stage, rec);
    deletePending(featureId, stage);

    // Commit approval to git
    const verb = approved ? "approved" : "rejected";
    commitToGit(featureId, `${stage} ${verb} by ${rec.approvedBy}`);

    console.log(`\n  [UI] ${stage} ${verb} for ${featureId.slice(0, 8)} — "${comment ?? ""}"`);
    json(res, { ok: true, record: rec });
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
