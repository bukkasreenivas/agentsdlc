// orchestrator/feature-doc.ts
// Manages the docs/features/<id>.md file in the host project.
// This file is the "Single Source of Truth" for the feature lifecycle.

import * as fs from "fs";
import * as path from "path";
import { integrations } from "../config/integrations";

export interface FeatureDocMetadata {
  featureId: string;
  featureTitle: string;
  status: string;
  startedAt: string;
}

/**
 * Updates or creates the feature markdown file in the host project.
 */
export function updateFeatureDoc(
  hostPath: string,
  meta: FeatureDocMetadata,
  stages: Record<string, any>
): string {
  if (!hostPath || hostPath === ".") return "";

  const docsDir = path.join(hostPath, "docs", "features");
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const filePath = path.join(docsDir, `${meta.featureId.slice(0, 8)}.md`);

  let content = `# Feature: ${meta.featureTitle}\n\n`;
  content += `**ID**: \`${meta.featureId}\`  |  **Status**: \`${meta.status}\`  |  **Started**: ${meta.startedAt}\n\n`;
  content += `--- \n\n`;

  // PM Section
  if (stages.pm_brainstorm) {
    const pm = stages.pm_brainstorm.data?.content ?? stages.pm_brainstorm.data;
    content += `## ✅ PM Analysis\n\n`;
    content += `### PM Memo / PRD\n${pm.pm_memo || "No memo available."}\n\n`;
    if (pm.consensus?.agreed_scope) {
        content += `### Agreed Scope\n${pm.consensus.agreed_scope}\n\n`;
    }
    content += `--- \n\n`;
  }

  // PO Section
  if (stages.po) {
    const po = stages.po.data?.content ?? stages.po.data;
    const stories = po.user_stories || [];
    content += `## ✅ User Stories & Epic\n\n`;
    content += `**Epic**: [${po.epic_key}](${po.story_map_url})\n\n`;
    
    content += `| Story | Points | Status | Jira |\n`;
    content += `| :--- | :--- | :--- | :--- |\n`;
    stories.forEach((s: any) => {
      content += `| ${s.summary} | ${s.story_points || "-"} | Ready | [${s.key}](${integrations.jira.baseUrl}/browse/${s.key}) |\n`;
    });
    content += `\n\n`;

    content += `### Acceptance Criteria (GWT)\n\n`;
      stories.forEach((s: any, idx: number) => {
          content += `#### Story ${idx + 1}: ${s.summary}\n`;
          content += `*${s.user_story || s.job_story}*\n\n`;
          
          const acs = s.acceptance_criteria_gwt || [];
          if (acs.length > 0) {
              content += `| Given | When | Then |\n`;
              content += `| :--- | :--- | :--- |\n`;
              acs.forEach((ac: any) => {
                  content += `| ${ac.given} | ${ac.when} | ${ac.then} |\n`;
              });
          } else {
              (s.acceptance_criteria || []).forEach((ac: string) => content += `- ${ac}\n`);
          }
          content += `\n`;
      });
    content += `--- \n\n`;
  }

  // Design Section
  if (stages.design) {
      const design = stages.design.data?.content ?? stages.design.data;
      content += `## ✅ Design Artifacts\n\n`;
      if (design.figma_file_url) content += `**Figma**: [View File](${design.figma_file_url})\n\n`;
      if (design.style_guide) content += `### Style Guide\n${design.style_guide}\n\n`;
      content += `--- \n\n`;
  }

  fs.writeFileSync(filePath, content);
  return filePath;
}
