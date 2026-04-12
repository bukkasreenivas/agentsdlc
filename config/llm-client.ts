// config/llm-client.ts
// Priority 1: Bedrock (bearer token OR access keys OR SSO)
// Priority 2: GitHub Copilot (copilot-api proxy)
// Priority 3: Anthropic direct key
// Set LLM_PROVIDER=bedrock|copilot|anthropic to force. Leave unset for auto+failover.

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import * as path   from "path";

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
      if (bearer) {
        // Bearer token path — proxy via standard Anthropic client with Bedrock endpoint
        client = new Anthropic({
          apiKey:  bearer,
          baseURL: `https://bedrock-runtime.${region}.amazonaws.com`,
          defaultHeaders: {
            "Authorization": `Bearer ${bearer}`,
            "Content-Type":  "application/json",
          },
        });
        console.log(`[LLM] Bedrock — bearer token (region: ${region})`);
      } else {
        // SigV4 path — access keys or SSO
        const opts: any = { awsRegion: region };
        if (process.env.AWS_ACCESS_KEY_ID) {
          opts.awsAccessKey    = process.env.AWS_ACCESS_KEY_ID;
          opts.awsSecretKey    = process.env.AWS_SECRET_ACCESS_KEY;
          opts.awsSessionToken = process.env.AWS_SESSION_TOKEN;
        }
        client = new (Anthropic as any).AnthropicBedrock(opts);
        console.log(`[LLM] Bedrock — SigV4 (region: ${region})`);
      }
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
        "  Priority 2 — Copilot: set GITHUB_TOKEN and run copilot-api proxy\n" +
        "  Priority 3 — Anthropic: set ANTHROPIC_API_KEY"
      );
      client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      console.log("[LLM] Anthropic direct");
    }
  }

  _client   = client;
  _provider = provider;
  return client;
}

export function resolveModel(model: string): string {
  const p = _provider ?? detectProvider();
  if (p === "bedrock") return BEDROCK_MODEL_MAP[model] ?? model;
  if (p === "copilot") return COPILOT_MODEL_MAP[model] ?? model;
  return model;
}

export async function withFailover<T>(fn: (c: Anthropic) => Promise<T>, label = "call"): Promise<T> {
  if (process.env.LLM_PROVIDER) return fn(createClient());
  const order: Provider[] = ["bedrock", "copilot", "anthropic"];
  const errors: string[]  = [];

  for (const p of order) {
    if (p === "bedrock"   && !hasBedrockCredentials()) continue;
    if (p === "copilot"   && !hasCopilotProxy())       continue;
    if (p === "anthropic" && !hasAnthropicKey())        continue;
    try {
      _client = null; _provider = null;
      return await fn(createClient(p));
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.warn(`[LLM] ${p} failed (${label}): ${msg.slice(0, 100)}`);
      errors.push(`${p}: ${msg.slice(0, 80)}`);
    }
  }
  throw new Error(`[LLM] All providers failed for "${label}":\n${errors.map(e => "  " + e).join("\n")}`);
}

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
