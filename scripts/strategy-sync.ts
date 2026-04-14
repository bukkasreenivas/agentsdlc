import * as fs from "fs";
import * as path from "path";
import { syncWorkspace } from "../orchestrator/workspace";
import { scanCodebase }  from "../tools/codebase-scanner";
import { withFailover }  from "../config/llm-client";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const STRATEGY_DIR = path.join(PROJECT_ROOT, "memory", "strategy");

export async function runStrategySync() {
  console.log("\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  🔄  STRATEGY SYNC — Updating Global Context");
  console.log("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (!fs.existsSync(STRATEGY_DIR)) {
    fs.mkdirSync(STRATEGY_DIR, { recursive: true });
  }

  // 1. Sync workspace (GitHub/Bitbucket -> local caching)
  const workspacePath = syncWorkspace();

  // 2. Scan Codebase
  console.log("  [strategy] Scanning codebase...");
  const overviewObj = await scanCodebase(workspacePath);
  const overview = JSON.stringify({
    identity: overviewObj.projectIdentity,
    stack: overviewObj.techStack,
    tree: overviewObj.fileTree
  }, null, 2);
  fs.writeFileSync(path.join(STRATEGY_DIR, "project_context.md"), overview, "utf8");
  console.log("  [strategy] project_context.md generated");

  // 3. Competitor Analysis via LLM
  console.log("  [strategy] Running Macro-market & Competitor Analysis via LLM...");
  
  const systemPrompt = `You are a visionary Strategy Agent. 
Input: A high-level technical overview of a local codebase.
Task: Synthesize a "Competitor Analysis & Product Strategy" memo (markdown).
1. Deduce what the product is and who the target audience is.
2. Identify 3 potential market competitors.
3. Perform a quick SWOT analysis for the product.
Output only the markdown document.`;

  try {
    const analysis = await withFailover(async (client) => {
      const msg = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: `Codebase Overview:\n${overview}` }]
      });
      return (msg.content[0] as any).text as string;
    }, "strategy_sync");

    fs.writeFileSync(path.join(STRATEGY_DIR, "competitor_analysis.md"), analysis, "utf8");
    console.log("  [strategy] competitor_analysis.md generated");
  } catch (err: any) {
    console.error("  [strategy] Warning: Competitor analysis failed", err.message);
  }

  console.log("\n  ✓ Strategy Sync Complete\n");
}

// Support running directly via CLI
if (require.main === module) {
  runStrategySync().catch(console.error);
}
