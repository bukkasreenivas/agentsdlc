// config/agents.ts — model routing. Change model names here only.
export interface AgentConfig { model: string; maxTokens: number; temperature: number; }

export const AGENT_MODELS: Record<string, AgentConfig> = {
  pm_brainstorm:  { model: "claude-opus-4-20250514",   maxTokens: 8192, temperature: 0.4 },
  pm_critic:      { model: "claude-sonnet-4-20250514", maxTokens: 4096, temperature: 0.3 },
  pm_synthesizer: { model: "claude-opus-4-20250514",   maxTokens: 8192, temperature: 0.2 },
  po:             { model: "claude-sonnet-4-20250514", maxTokens: 8192, temperature: 0.2 },
  design:         { model: "claude-sonnet-4-20250514", maxTokens: 3000, temperature: 0.4 },
  architect:      { model: "claude-opus-4-20250514",   maxTokens: 8192, temperature: 0.1 },
  frontend_dev:   { model: "claude-sonnet-4-20250514", maxTokens: 4096, temperature: 0.2 },
  backend_dev:    { model: "claude-sonnet-4-20250514", maxTokens: 4096, temperature: 0.1 },
  nfr:            { model: "claude-haiku-4-5",         maxTokens: 2048, temperature: 0.0 },
  reviewer:       { model: "claude-opus-4-20250514",   maxTokens: 8192, temperature: 0.1 },
  cicd:           { model: "claude-haiku-4-5",         maxTokens: 1024, temperature: 0.0 },
  qa:             { model: "claude-sonnet-4-20250514", maxTokens: 4096, temperature: 0.2 },
};
