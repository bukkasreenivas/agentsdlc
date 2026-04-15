// agents/pm-brainstorm/skill-registry.ts
// Auto-discovers SKILL.md files from the local skills directory tree.
// PMs add custom skills by dropping a SKILL.md into skills/custom/<name>/.
// No code changes needed — the registry re-scans on every load.

import * as fs   from "fs";
import * as path from "path";

export interface PMSkill {
  id:          string;   // folder name, e.g. "brainstorm-ideas-existing"
  name:        string;   // from frontmatter
  description: string;  // from frontmatter
  category:    string;  // "pm-product-discovery" | "pm-market-research" | "custom"
  path_hint?:  string;  // optional: "discovery" | "competitor" | "synthesis" | "all"
  body:        string;  // everything after the closing --- fence
  source_path: string;  // absolute path to SKILL.md
}

// Default skill sets per discovery path
export const PATH_DEFAULT_SKILLS: Record<"discovery" | "competitor" | "synthesis", string[]> = {
  discovery:  [
    "brainstorm-ideas-existing",
    "identify-assumptions-existing",
    "opportunity-solution-tree",
    "prioritize-features",
  ],
  competitor: [
    "competitor-analysis",
    "market-segments",
    "user-personas",
    "sentiment-analysis",
    "market-sizing",
  ],
  synthesis: [
    "sentiment-analysis",
    "analyze-feature-requests",
    "identify-assumptions-existing",
    "summarize-interview",
  ],
};

const SKILLS_ROOT = path.join(__dirname, "skills");

// ── Frontmatter parser ────────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!raw.startsWith("---")) return { meta, body: raw };

  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta, body: raw };

  const fmBlock = raw.slice(3, end).trim();
  const body    = raw.slice(end + 4).trim();

  for (const line of fmBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    meta[key] = val;
  }

  return { meta, body };
}

// ── Directory walker ──────────────────────────────────────────────────────────

function walkSkillDirs(root: string, category: string): PMSkill[] {
  const skills: PMSkill[] = [];
  if (!fs.existsSync(root)) return skills;

  for (const name of fs.readdirSync(root)) {
    const skillDir  = path.join(root, name);
    const skillFile = path.join(skillDir, "SKILL.md");
    if (!fs.statSync(skillDir).isDirectory()) continue;
    if (!fs.existsSync(skillFile)) continue;

    try {
      const raw = fs.readFileSync(skillFile, "utf8");
      const { meta, body } = parseFrontmatter(raw);

      skills.push({
        id:          name,
        name:        meta.name        || name,
        description: meta.description || "",
        category,
        path_hint:   meta.path        || undefined,
        body,
        source_path: skillFile,
      });
    } catch {
      // skip malformed files
    }
  }

  return skills;
}

// ── Public API ────────────────────────────────────────────────────────────────

let _cache: PMSkill[] | null = null;

/** Load all skills from the local skills directory (cached per process). */
export function loadAllSkills(): PMSkill[] {
  if (_cache) return _cache;

  const discovery    = walkSkillDirs(path.join(SKILLS_ROOT, "pm-product-discovery", "skills"), "pm-product-discovery");
  const marketResearch = walkSkillDirs(path.join(SKILLS_ROOT, "pm-market-research",   "skills"), "pm-market-research");
  const custom       = walkSkillDirs(path.join(SKILLS_ROOT, "custom"),                "custom");

  _cache = [...discovery, ...marketResearch, ...custom];
  return _cache;
}

/** Force reload (used after a new custom skill is added at runtime). */
export function reloadSkills(): PMSkill[] {
  _cache = null;
  return loadAllSkills();
}

/** Return the ordered default skills for a given discovery path. */
export function loadSkillsForPath(pathName: "discovery" | "competitor" | "synthesis"): PMSkill[] {
  const all = loadAllSkills();
  const ids = PATH_DEFAULT_SKILLS[pathName];
  const ordered: PMSkill[] = [];
  for (const id of ids) {
    const skill = all.find(s => s.id === id);
    if (skill) ordered.push(skill);
  }
  // Append any custom skills tagged for this path or "all"
  for (const s of all) {
    if (s.category === "custom" && (!s.path_hint || s.path_hint === pathName || s.path_hint === "all")) {
      if (!ordered.find(o => o.id === s.id)) ordered.push(s);
    }
  }
  return ordered;
}

/** Look up a single skill by id. */
export function findSkill(id: string): PMSkill | undefined {
  return loadAllSkills().find(s => s.id === id);
}
