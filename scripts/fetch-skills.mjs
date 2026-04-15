// scripts/fetch-skills.mjs
// Run once: node scripts/fetch-skills.mjs
// Fetches all SKILL.md files from pm-skills GitHub repo and stores them locally.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = join(__dirname, "..", "agents", "pm-brainstorm", "skills");

const CATEGORIES = [
  { dir: "pm-product-discovery/skills", local: "pm-product-discovery/skills" },
  { dir: "pm-market-research/skills",   local: "pm-market-research/skills"   },
];

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function main() {
  let total = 0;
  for (const cat of CATEGORIES) {
    const apiUrl = `https://api.github.com/repos/bukkasreenivas/pm-skills/contents/${cat.dir}`;
    console.log(`\nFetching ${cat.dir}...`);
    const dirs = await fetchJSON(apiUrl);
    const skillDirs = dirs.filter(e => e.type === "dir");

    for (const skillDir of skillDirs) {
      const skillMdApiUrl = `https://api.github.com/repos/bukkasreenivas/pm-skills/contents/${cat.dir}/${skillDir.name}/SKILL.md`;
      let content;
      try {
        const meta = await fetchJSON(skillMdApiUrl);
        // GitHub API returns base64 content for files
        content = Buffer.from(meta.content, "base64").toString("utf8");
      } catch (e) {
        console.warn(`  ⚠ Could not fetch ${skillDir.name}/SKILL.md: ${e.message}`);
        continue;
      }

      const localDir = join(SKILLS_ROOT, cat.local, skillDir.name);
      mkdirSync(localDir, { recursive: true });
      const localPath = join(localDir, "SKILL.md");
      writeFileSync(localPath, content, "utf8");
      console.log(`  ✓ ${skillDir.name}/SKILL.md`);
      total++;
    }
  }

  // Also create the custom/ directory with a README
  const customDir = join(SKILLS_ROOT, "custom");
  mkdirSync(customDir, { recursive: true });
  const readmePath = join(customDir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, [
      "# Custom PM Skills",
      "",
      "Drop your own skills here. Each skill needs its own subdirectory with a `SKILL.md` file.",
      "",
      "## Format",
      "",
      "```",
      "custom/",
      "  my-skill-name/",
      "    SKILL.md",
      "```",
      "",
      "## SKILL.md frontmatter",
      "",
      "```markdown",
      "---",
      "name: my-skill-name",
      "description: One-line description of what this skill does",
      "path: discovery  # discovery | competitor | synthesis | all",
      "---",
      "",
      "You are a PM expert in...",
      "",
      "$ARGUMENTS",
      "```",
      "",
      "The skill auto-appears in the UI and CLI next time the server starts.",
    ].join("\n"), "utf8");
  }

  console.log(`\n✓ Done. Fetched ${total} SKILL.md files.`);
  console.log(`  Location: agents/pm-brainstorm/skills/`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
