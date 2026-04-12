// tools/file-writer.ts
// Applies dev agent generated code to actual project files.
// Handles: new file creation, surgical patch into existing files,
// conflict detection, backup, and rollback on failure.
//
// This is what makes the dev swarm write into YOUR existing project
// rather than just producing code as text.

import * as fs   from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface FileWriteOperation {
  filePath:    string;        // relative to repoPath e.g. "src/components/Search.tsx"
  content:     string;        // full file content OR patch
  mode:        WriteMode;
  description: string;        // what this change does (written to git commit msg)
}

export type WriteMode =
  | "create"          // create new file, fail if exists
  | "overwrite"       // replace entire file content
  | "patch"           // insert/replace a named block within existing file
  | "append"          // append to end of file
  | "create_or_patch" // create if not exists, patch if exists

export interface PatchBlock {
  marker:      string;   // unique string that identifies the insertion point
  content:     string;   // content to insert after the marker line
  replaceUntil?: string; // if set, replace lines between marker and replaceUntil
}

export interface WriteResult {
  filePath:   string;
  mode:       WriteMode;
  success:    boolean;
  backupPath?: string;
  error?:     string;
  linesAdded:   number;
  linesRemoved: number;
}

export interface FileWriterReport {
  repoPath:     string;
  featureId:    string;
  operations:   WriteResult[];
  totalAdded:   number;
  totalRemoved: number;
  failed:       string[];
  backupDir:    string;
  rollbackAvailable: boolean;
}

// ── Backup ────────────────────────────────────────────────────────────────────

function ensureBackupDir(repoPath: string, featureId: string): string {
  const backupDir = path.join(repoPath, ".agentsdlc", "backups", featureId.slice(0, 8));
  fs.mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

function backupFile(filePath: string, backupDir: string): string {
  if (!fs.existsSync(filePath)) return "";
  const hash     = crypto.createHash("md5").update(filePath).digest("hex").slice(0, 6);
  const fileName = path.basename(filePath);
  const backupPath = path.join(backupDir, `${fileName}.${hash}.bak`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

// ── Conflict detection ────────────────────────────────────────────────────────

function detectConflicts(existingContent: string, newContent: string): string[] {
  const conflicts: string[] = [];

  // Check if file has git conflict markers already
  if (existingContent.includes("<<<<<<<") || existingContent.includes(">>>>>>>")) {
    conflicts.push("File already contains git conflict markers — resolve manually first");
  }

  // Check if critical exports would be removed
  const existingExports = (existingContent.match(/^export\s+(default\s+)?(function|class|const|interface|type)\s+(\w+)/gm) ?? [])
    .map(e => e.trim());
  const newExports = (newContent.match(/^export\s+(default\s+)?(function|class|const|interface|type)\s+(\w+)/gm) ?? [])
    .map(e => e.trim());

  for (const exp of existingExports) {
    const name = exp.split(/\s+/).pop();
    if (name && !newExports.some(e => e.includes(name))) {
      conflicts.push(`Export '${name}' exists in original but missing in new content — check for unintended removal`);
    }
  }

  return conflicts;
}

// ── Patch mode ────────────────────────────────────────────────────────────────
// Inserts content at a named marker, optionally replacing until another marker.
// Markers are comments the architect places in the task description:
//   // AGENT:INSERT:search-handler
//   // AGENT:END:search-handler

function applyPatch(existingContent: string, patch: PatchBlock): string {
  const startMarker = `// AGENT:INSERT:${patch.marker}`;
  const endMarker   = patch.replaceUntil ? `// AGENT:END:${patch.marker}` : null;

  const lines = existingContent.split("\n");
  const startIdx = lines.findIndex(l => l.includes(startMarker));

  if (startIdx === -1) {
    // Marker not found — append to end of file with a comment
    return existingContent + `\n\n// ${startMarker}\n${patch.content}\n`;
  }

  if (endMarker) {
    const endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(endMarker));
    if (endIdx !== -1) {
      // Replace block between markers
      return [
        ...lines.slice(0, startIdx + 1),
        patch.content,
        ...lines.slice(endIdx),
      ].join("\n");
    }
  }

  // Insert after start marker
  return [
    ...lines.slice(0, startIdx + 1),
    patch.content,
    ...lines.slice(startIdx + 1),
  ].join("\n");
}

// ── Import merger ─────────────────────────────────────────────────────────────
// When patching a TS/JS file, merge new imports rather than duplicating.

function mergeImports(existingContent: string, newContent: string): string {
  const importRegex = /^import\s+.+from\s+['"].+['"];?$/gm;

  const existingImports = new Set(existingContent.match(importRegex) ?? []);
  const newImports      = newContent.match(importRegex) ?? [];

  const importsToAdd = newImports.filter(imp => !existingImports.has(imp));
  if (importsToAdd.length === 0) return existingContent;

  // Insert after the last existing import line
  const lines    = existingContent.split("\n");
  let lastImport = -1;
  lines.forEach((line, i) => { if (importRegex.test(line)) lastImport = i; });

  if (lastImport === -1) {
    return importsToAdd.join("\n") + "\n\n" + existingContent;
  }

  return [
    ...lines.slice(0, lastImport + 1),
    ...importsToAdd,
    ...lines.slice(lastImport + 1),
  ].join("\n");
}

// ── Single file write ─────────────────────────────────────────────────────────

async function writeFile(
  op:        FileWriteOperation,
  repoPath:  string,
  backupDir: string
): Promise<WriteResult> {
  const absolutePath = path.isAbsolute(op.filePath)
    ? op.filePath
    : path.join(repoPath, op.filePath);

  const dir = path.dirname(absolutePath);

  let linesAdded   = 0;
  let linesRemoved = 0;
  let backupPath   = "";

  try {
    // Create directory if needed
    fs.mkdirSync(dir, { recursive: true });

    const exists = fs.existsSync(absolutePath);

    // Backup existing file before any write
    if (exists) {
      backupPath = backupFile(absolutePath, backupDir);
    }

    if (op.mode === "create" && exists) {
      return {
        filePath: op.filePath, mode: op.mode, success: false,
        error: `File already exists — use 'overwrite' or 'patch' mode`,
        linesAdded: 0, linesRemoved: 0,
      };
    }

    if ((op.mode === "patch" || op.mode === "create_or_patch") && exists) {
      const existingContent = fs.readFileSync(absolutePath, "utf8");

      // Conflict check
      const conflicts = detectConflicts(existingContent, op.content);
      if (conflicts.length > 0) {
        console.warn(`[FileWriter] Conflicts in ${op.filePath}:\n  ${conflicts.join("\n  ")}`);
      }

      // Merge imports for TS/JS files
      const isTS = absolutePath.match(/\.(ts|tsx|js|jsx)$/);
      let merged = isTS ? mergeImports(existingContent, op.content) : existingContent;

      // Apply patch blocks from content (look for AGENT:INSERT markers in op.content)
      const patchBlocks = extractPatchBlocks(op.content);
      if (patchBlocks.length > 0) {
        for (const block of patchBlocks) {
          merged = applyPatch(merged, block);
        }
      } else {
        // No markers — treat whole content as a patch append
        merged = applyPatch(merged, { marker: op.description.replace(/\s+/g, "-"), content: op.content });
      }

      const existingLines = existingContent.split("\n").length;
      const newLines      = merged.split("\n").length;
      linesAdded   = Math.max(0, newLines - existingLines);
      linesRemoved = Math.max(0, existingLines - newLines);

      fs.writeFileSync(absolutePath, merged, "utf8");

    } else if (op.mode === "append") {
      const existing = exists ? fs.readFileSync(absolutePath, "utf8") : "";
      const appended = existing + "\n" + op.content;
      linesAdded = op.content.split("\n").length;
      fs.writeFileSync(absolutePath, appended, "utf8");

    } else {
      // create / overwrite / create_or_patch (not exists)
      const existing = exists ? fs.readFileSync(absolutePath, "utf8") : "";
      linesAdded   = op.content.split("\n").length;
      linesRemoved = existing.split("\n").length;
      fs.writeFileSync(absolutePath, op.content, "utf8");
    }

    return {
      filePath: op.filePath,
      mode:     op.mode,
      success:  true,
      backupPath,
      linesAdded,
      linesRemoved,
    };

  } catch (err) {
    // Restore backup on failure
    if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, absolutePath);
    }
    return {
      filePath: op.filePath, mode: op.mode, success: false,
      error: (err as Error).message,
      linesAdded: 0, linesRemoved: 0,
    };
  }
}

// ── Extract patch blocks from generated code ──────────────────────────────────
// The dev agent wraps sections with:
//   // AGENT:INSERT:marker-name
//   ... code ...
//   // AGENT:END:marker-name

function extractPatchBlocks(content: string): PatchBlock[] {
  const blocks: PatchBlock[]  = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const insertMatch = lines[i].match(/\/\/\s*AGENT:INSERT:(.+)/);
    if (insertMatch) {
      const marker    = insertMatch[1].trim();
      const blockLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].includes(`AGENT:END:${marker}`)) {
        blockLines.push(lines[i]);
        i++;
      }
      blocks.push({ marker, content: blockLines.join("\n") });
    }
    i++;
  }

  return blocks;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function applyDevAgentOutput(params: {
  repoPath:   string;
  featureId:  string;
  operations: FileWriteOperation[];
  dryRun?:    boolean;        // if true: report what would change, write nothing
}): Promise<FileWriterReport> {
  const { repoPath, featureId, operations, dryRun = false } = params;

  const backupDir = ensureBackupDir(repoPath, featureId);
  const results:  WriteResult[] = [];

  console.log(`\n[FileWriter] ${dryRun ? "DRY RUN — " : ""}Applying ${operations.length} file operations`);
  console.log(`[FileWriter] Backup dir: ${backupDir}\n`);

  for (const op of operations) {
    if (dryRun) {
      const exists = fs.existsSync(path.join(repoPath, op.filePath));
      console.log(`  [DRY RUN] ${op.mode.padEnd(14)} ${op.filePath} ${exists ? "(exists)" : "(new file)"}`);
      results.push({
        filePath: op.filePath, mode: op.mode, success: true,
        linesAdded: op.content.split("\n").length, linesRemoved: 0,
      });
      continue;
    }

    const result = await writeFile(op, repoPath, backupDir);
    results.push(result);

    const icon = result.success ? "✓" : "✗";
    console.log(`  ${icon} ${op.mode.padEnd(14)} ${op.filePath}  +${result.linesAdded}/-${result.linesRemoved}`);
    if (result.error) console.log(`      Error: ${result.error}`);
  }

  const totalAdded   = results.reduce((s, r) => s + r.linesAdded,   0);
  const totalRemoved = results.reduce((s, r) => s + r.linesRemoved, 0);
  const failed       = results.filter(r => !r.success).map(r => r.filePath);

  const report: FileWriterReport = {
    repoPath,
    featureId,
    operations: results,
    totalAdded,
    totalRemoved,
    failed,
    backupDir,
    rollbackAvailable: results.some(r => r.backupPath),
  };

  // Write report to memory
  const reportPath = path.join(repoPath, ".agentsdlc", "backups", featureId.slice(0, 8), "write-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n[FileWriter] Done. +${totalAdded}/-${totalRemoved} lines across ${operations.length} files`);
  if (failed.length > 0) console.log(`[FileWriter] Failed: ${failed.join(", ")}`);

  return report;
}

// ── Rollback ──────────────────────────────────────────────────────────────────

export async function rollbackWrites(repoPath: string, featureId: string): Promise<void> {
  const backupDir    = path.join(repoPath, ".agentsdlc", "backups", featureId.slice(0, 8));
  const reportPath   = path.join(backupDir, "write-report.json");

  if (!fs.existsSync(reportPath)) {
    throw new Error(`No write report found for feature ${featureId}. Cannot rollback.`);
  }

  const report: FileWriterReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  for (const op of report.operations) {
    if (op.backupPath && fs.existsSync(op.backupPath)) {
      const originalPath = path.join(repoPath, op.filePath);
      fs.copyFileSync(op.backupPath, originalPath);
      console.log(`  ↩ Rolled back: ${op.filePath}`);
    }
  }

  console.log(`\n[FileWriter] Rollback complete for feature ${featureId}`);
}

// ── Parse dev agent response into FileWriteOperations ─────────────────────────
// The dev agent returns code blocks tagged with file paths.
// This parser extracts them into structured operations.

export function parseDevAgentOutput(
  agentOutput: string,
  archTasks: Array<{ file_paths: string[]; id: string }>
): FileWriteOperation[] {
  const operations: FileWriteOperation[] = [];

  // Match: ```typescript:src/components/MyComponent.tsx  (with file path after colon)
  const fileBlockRegex = /```(?:typescript|javascript|tsx|jsx|python|sql|css|scss|json|yaml|sh)(?::([^\n]+))?\n([\s\S]*?)```/g;

  let match: RegExpExecArray | null;
  while ((match = fileBlockRegex.exec(agentOutput)) !== null) {
    const rawPath = match[1]?.trim();
    const content = match[2]?.trim() ?? "";

    if (!rawPath || !content) continue;

    // Determine mode: if path contains "test" or "__tests__" → create or patch test file
    const isTestFile = rawPath.includes(".test.") || rawPath.includes(".spec.") || rawPath.includes("__tests__");
    const exists     = false; // will be checked at write time

    const mode: WriteMode = isTestFile ? "create_or_patch" : "create_or_patch";

    // Find which arch task this file belongs to
    const task = archTasks.find(t => t.file_paths.some(fp => rawPath.includes(fp) || fp.includes(rawPath)));

    operations.push({
      filePath:    rawPath,
      content,
      mode,
      description: task ? `Task ${task.id}` : `Agent generated: ${path.basename(rawPath)}`,
    });
  }

  // If agent did not use tagged code blocks, fall back to arch task file_paths
  if (operations.length === 0) {
    for (const task of archTasks) {
      for (const fp of task.file_paths) {
        operations.push({
          filePath:    fp,
          content:     `// TODO: ${task.id} — ${fp}\n// Agent output did not include a tagged code block for this file.\n`,
          mode:        "create",
          description: task.id,
        });
      }
    }
  }

  return operations;
}
