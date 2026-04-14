import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const WORKSPACES_DIR = path.resolve(__dirname, "../memory/workspaces");

/**
 * Ensures the workspace directory exists, clones the repository if it doesn't,
 * or pulls the latest changes if it does. Returns the local path to the workspace.
 */
export function syncWorkspace(gitUrl?: string): string {
  const urlToUse = gitUrl ?? process.env.PROJECT_GIT_URL ?? "";

  if (!urlToUse) {
    // Fall back to local HOST_PROJECT_PATH logic if no remote URL is provided
    return path.resolve(__dirname, "..", process.env.HOST_PROJECT_PATH || "..");
  }

  // Generate a project folder name from the Git URL, e.g., "my-org-my-repo"
  const repoNameMatch = urlToUse.match(/([^/]+)\.git$/) || urlToUse.match(/([^/]+)$/);
  const repoName = repoNameMatch ? repoNameMatch[1] : "default-workspace";
  
  const workspacePath = path.join(WORKSPACES_DIR, repoName);

  if (!fs.existsSync(WORKSPACES_DIR)) {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  }

  try {
    if (fs.existsSync(path.join(workspacePath, ".git"))) {
      console.log(`  [workspace] Pulling latest from ${urlToUse}...`);
      execSync(`git pull`, { cwd: workspacePath, stdio: "pipe" });
    } else {
      console.log(`  [workspace] Cloning ${urlToUse}...`);
      execSync(`git clone "${urlToUse}" "${workspacePath}"`, { stdio: "pipe" });
    }
    return workspacePath;
  } catch (err: any) {
    const msg = err?.stderr?.toString() ?? err?.message ?? "unknown error";
    console.warn(`  [workspace] Failed to sync workspace: ${msg.split("\n")[0]}`);
    // If it fails, return the path anyway (it might be partially cloned or offline)
    return workspacePath;
  }
}
