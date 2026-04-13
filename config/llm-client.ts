// config/llm-client.ts
// Priority 1: Bedrock (bearer token OR access keys OR SSO)
// Priority 2: GitHub Copilot (copilot-api proxy — auto-started as background process)
// Priority 3: Anthropic direct key
// Set LLM_PROVIDER=bedrock|copilot|anthropic to force. Leave unset for auto+failover.

import Anthropic                   from "@anthropic-ai/sdk";
import { AnthropicBedrock }        from "@anthropic-ai/bedrock-sdk";
import * as net                    from "net";
import * as path                   from "path";
import * as dotenv                 from "dotenv";
import { spawn, ChildProcess }     from "child_process";

// Load .agentsdlc/.env — NOT the host project .env
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export type Provider = "bedrock" | "copilot" | "anthropic";

const BEDROCK_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-20250514":    "us.anthropic.claude-opus-4-5-20251101-v1:0",
  "claude-sonnet-4-20250514":  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "claude-haiku-4-5":          "us.anthropic.claude-haiku-4-5-20250929-v1:0",
  "claude-haiku-4-5-20251001": "us.anthropic.claude-haiku-4-5-20250929-v1:0",
};

const COPILOT_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-20250514":    "claude-sonnet-4-5",
  "claude-sonnet-4-20250514":  "claude-sonnet-4-5",
  "claude-haiku-4-5":          "claude-haiku-4-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
};

// ── Credential detection ──────────────────────────────────────────────────────

function hasBedrockCredentials(): boolean {
  return !!(
    process.env.AWS_BEARER_TOKEN_BEDROCK        ||
    process.env.BEDROCK_BEARER_TOKEN            ||
    process.env.AWS_ACCESS_KEY_ID               ||
    process.env.AWS_PROFILE                     ||
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE
  );
}

function hasCopilotProxy(): boolean {
  return !!process.env.GITHUB_TOKEN;
}

function hasAnthropicKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function detectProvider(): Provider {
  const forced = process.env.LLM_PROVIDER as Provider | undefined;
  if (forced) return forced;
  if (hasBedrockCredentials()) return "bedrock";
  if (hasCopilotProxy())       return "copilot";
  if (hasAnthropicKey())       return "anthropic";
  return "anthropic";
}

// ── Copilot proxy auto-start ──────────────────────────────────────────────────
// Lazy: only started the first time copilot is actually needed in failover.
// This avoids EINVAL / deprecation noise when Bedrock is healthy.

let _copilotProc: ChildProcess | null = null;
let _copilotReadyPromise: Promise<void> | null = null;
let _copilotProxyFailed  = false;

function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection({ port, host });
    s.once("connect", () => { s.destroy(); resolve(true);  });
    s.once("error",   () => { s.destroy(); resolve(false); });
  });
}

async function ensureCopilotProxy(): Promise<void> {
  const proxyUrl = process.env.COPILOT_PROXY_URL ?? "http://localhost:4141";
  const port     = parseInt(new URL(proxyUrl).port || "4141", 10);

  if (await isPortOpen(port)) {
    console.log(`[LLM] Copilot proxy already running on :${port}`);
    return;
  }

  console.log(`[LLM] Auto-starting copilot-api proxy on :${port} ...`);

  // On Windows, .cmd/.bat files cannot be spawned directly — they require
  // a shell. Use shell:true on Windows only. The DEP0190 warning is cosmetic.
  const isWin   = process.platform === "win32";
  const binPath = path.resolve(__dirname, "../node_modules/.bin/copilot-api");

  _copilotProc = spawn(binPath, ["start", "--port", String(port)], {
    env:      { ...process.env },
    stdio:    ["ignore", "pipe", "pipe"],
    shell:    isWin,
    detached: false,
  });

  _copilotProc.stdout?.on("data", (d: Buffer) => {
    if (process.env.LLM_DEBUG) process.stdout.write(`[copilot-proxy] ${d}`);
  });
  _copilotProc.stderr?.on("data", (d: Buffer) => {
    if (process.env.LLM_DEBUG) process.stderr.write(`[copilot-proxy] ${d}`);
  });
  _copilotProc.on("error", (err) => {
    console.warn(`[LLM] copilot-api process error: ${err.message}`);
  });

  const kill = () => { try { _copilotProc?.kill(); } catch {} _copilotProc = null; };
  process.once("exit",    kill);
  process.once("SIGINT",  () => { kill(); process.exit(0); });
  process.once("SIGTERM", () => { kill(); process.exit(0); });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortOpen(port)) {
      console.log(`[LLM] Copilot proxy ready on :${port}`);
      return;
    }
  }
  throw new Error(`[LLM] copilot-api proxy did not start within 15s on :${port}`);
}

/** Call once before using copilot. Idempotent — safe to call multiple times. */
function startCopilotProxyOnce(): void {
  if (_copilotReadyPromise || _copilotProxyFailed) return;
  _copilotReadyPromise = ensureCopilotProxy().catch(err => {
    _copilotProxyFailed = true;
    console.warn(`[LLM] Copilot proxy unavailable (skipping): ${(err as Error).message}`);
  });
}

// ── Client factory ────────────────────────────────────────────────────────────

let _client:   Anthropic | null = null;
let _provider: Provider  | null = null;

export function createClient(force?: Provider): Anthropic {
  const provider = force ?? detectProvider();
  if (_client && _provider === provider) return _client;

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const bearer  = process.env.AWS_BEARER_TOKEN_BEDROCK ?? process.env.BEDROCK_BEARER_TOKEN;

  let client: Anthropic;

  switch (provider) {
    case "bedrock": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = { awsRegion: region };

      if (bearer) {
        opts.awsBearerToken = bearer;
        console.log(`[LLM] Bedrock — bearer token (region: ${region})`);
      } else if (process.env.AWS_ACCESS_KEY_ID) {
        opts.awsAccessKey    = process.env.AWS_ACCESS_KEY_ID;
        opts.awsSecretKey    = process.env.AWS_SECRET_ACCESS_KEY;
        opts.awsSessionToken = process.env.AWS_SESSION_TOKEN;
        console.log(`[LLM] Bedrock — SigV4 access keys (region: ${region})`);
      } else if (process.env.AWS_PROFILE) {
        opts.awsProfile = process.env.AWS_PROFILE;
        console.log(`[LLM] Bedrock — SigV4 profile "${process.env.AWS_PROFILE}" (region: ${region})`);
      } else {
        console.log(`[LLM] Bedrock — SigV4 default credential chain (region: ${region})`);
      }

      client = new AnthropicBedrock(opts) as unknown as Anthropic;
      break;
    }

    case "copilot": {
      const proxyUrl = process.env.COPILOT_PROXY_URL ?? "http://localhost:4141";
      client = new Anthropic({ baseURL: proxyUrl, apiKey: process.env.GITHUB_TOKEN ?? "dummy" });
      console.log(`[LLM] Copilot proxy (${proxyUrl})`);
      break;
    }

    default: {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error(
        "[LLM] No credentials found.\n" +
        "  Priority 1 — Bedrock: set AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID in .agentsdlc/.env\n" +
        "  Priority 2 — Copilot: set GITHUB_TOKEN (proxy auto-starts, no manual step needed)\n" +
        "  Priority 3 — Anthropic: set ANTHROPIC_API_KEY"
      );
      client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      console.log("[LLM] Anthropic direct");
      break;
    }
  }

  _client   = client;
  _provider = provider;
  return client;
}

// ── Model resolution ──────────────────────────────────────────────────────────

export function resolveModel(model: string): string {
  const p = _provider ?? detectProvider();
  if (p === "bedrock") return BEDROCK_MODEL_MAP[model] ?? model;
  if (p === "copilot") return COPILOT_MODEL_MAP[model] ?? model;
  return model;
}

// ── Failover orchestration ────────────────────────────────────────────────────

export async function withFailover<T>(fn: (c: Anthropic) => Promise<T>, label = "call"): Promise<T> {
  if (process.env.LLM_PROVIDER) {
    if (process.env.LLM_PROVIDER === "copilot" && hasCopilotProxy()) {
      startCopilotProxyOnce();
      await _copilotReadyPromise;
    }
    return fn(createClient());
  }

  const order: Provider[] = ["bedrock", "copilot", "anthropic"];
  const errors: string[]  = [];

  for (const p of order) {
    if (p === "bedrock"   && !hasBedrockCredentials()) continue;
    if (p === "copilot"   && !hasCopilotProxy())       continue;
    if (p === "copilot"   && _copilotProxyFailed)      continue;
    if (p === "anthropic" && !hasAnthropicKey())        continue;
    try {
      if (p === "copilot") {
        // Start proxy lazily — only when Bedrock has already failed
        startCopilotProxyOnce();
        await _copilotReadyPromise;
        if (_copilotProxyFailed) continue;  // proxy failed during this await
      }
      return await fn(createClient(p));
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.warn(`[LLM] ${p} failed (${label}): ${msg.slice(0, 120)}`);
      errors.push(`${p}: ${msg.slice(0, 100)}`);
    }
  }
  throw new Error(`[LLM] All providers failed for "${label}":\n${errors.map(e => "  " + e).join("\n")}`);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function providerSummary(): string {
  const p = _provider ?? detectProvider();
  return [
    `Active provider: ${p.toUpperCase()}`,
    `  ${hasBedrockCredentials() ? "✓" : "✗"} Bedrock credentials found`,
    `  ${hasCopilotProxy()       ? "✓" : "✗"} GitHub Copilot proxy available`,
    `  ${hasAnthropicKey()       ? "✓" : "✗"} Anthropic API key set`,
  ].join("\n");
}

export function getHostProjectPath(): string {
  return path.resolve(__dirname, "..", process.env.HOST_PROJECT_PATH ?? "..");
}
