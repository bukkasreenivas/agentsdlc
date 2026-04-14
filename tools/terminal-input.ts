// tools/terminal-input.ts
// Helper to read human approval from the console as a fallback.

import * as readline from "readline";

/**
 * Prompts the user in the terminal for approval.
 * Returns { approved: boolean, comment: string }
 */
export async function askTerminalApproval(prompt: string): Promise<{ approved: boolean, comment: string }> {
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const clean = answer.toLowerCase().trim();
      if (clean === "y" || clean === "yes" || clean === "") {
        resolve({ approved: true, comment: "Approved via terminal." });
      } else if (clean === "n" || clean === "no") {
        resolve({ approved: false, comment: "Rejected via terminal." });
      } else {
        // Assume anything else is a rejection comment
        resolve({ approved: false, comment: answer });
      }
    });
  });
}
