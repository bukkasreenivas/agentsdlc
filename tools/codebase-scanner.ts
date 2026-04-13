// tools/codebase-scanner.ts
// v3 — Reads actual file contents so agents understand the real product,
// not just the file tree. Prevents hallucination of wrong product context.

import * as fs   from "fs";
import * as path from "path";

export interface CodebaseContext {
  fileTree:      string;          // Indented tree string
  techStack:     string[];        // Detected frameworks and languages
  entryPoints:   string[];        // Main app entry files
  relevantFiles: RelevantFile[];  // Top-N files scored for feature relevance
  dbSchema:      string[];        // Detected schema files / migration files
  apiRoutes:     string[];        // Detected API route files
  testPatterns:  string[];        // Detected test file patterns
  ciFiles:       string[];        // CI/CD config files found
  summary:       string;          // One-paragraph codebase description
  keyFileExcerpts: KeyFileExcerpt[]; // Actual content from README + entry points + key routes
  projectIdentity: string;        // What this product actually does (from README + entry points)
}

export interface KeyFileExcerpt {
  path:    string;
  content: string;  // Up to 600 chars
  reason:  string;  // Why this file was chosen
}

export interface RelevantFile {
  path:    string;
  score:   number;        // 0-1 relevance score
  reason:  string;        // Why this file is relevant
  excerpt: string;        // First 300 chars of the file
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".turbo", "coverage", ".nyc_output", "vendor", ".venv", "venv",
]);

const IGNORE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp4", ".mp3", ".wav", ".zip", ".tar", ".gz",
  ".lock", ".map",
]);

// ── File tree builder ─────────────────────────────────────────────────────────

function buildFileTree(dir: string, depth: number, prefix = ""): string {
  if (depth === 0 || !fs.existsSync(dir)) return "";

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !IGNORE_DIRS.has(e.name));
  } catch {
    return "";
  }

  return entries.map((e, i) => {
    const isLast      = i === entries.length - 1;
    const connector   = isLast ? "└── " : "├── ";
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    const line        = prefix + connector + e.name;

    if (e.isDirectory()) {
      const children = buildFileTree(path.join(dir, e.name), depth - 1, childPrefix);
      return children ? `${line}\n${children}` : line;
    }

    return line;
  }).join("\n");
}

// ── Tech stack detection ──────────────────────────────────────────────────────

function detectTechStack(repoPath: string): string[] {
  const stack: string[] = [];

  // Node / JS ecosystem
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg  = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps["react"])         stack.push("React");
      if (deps["next"])          stack.push("Next.js");
      if (deps["vue"])           stack.push("Vue");
      if (deps["nuxt"])          stack.push("Nuxt");
      if (deps["svelte"])        stack.push("Svelte");
      if (deps["angular"])       stack.push("Angular");
      if (deps["express"])       stack.push("Express");
      if (deps["fastify"])       stack.push("Fastify");
      if (deps["nestjs"])        stack.push("NestJS");
      if (deps["@nestjs/core"])  stack.push("NestJS");
      if (deps["prisma"])        stack.push("Prisma ORM");
      if (deps["typeorm"])       stack.push("TypeORM");
      if (deps["sequelize"])     stack.push("Sequelize");
      if (deps["drizzle-orm"])   stack.push("Drizzle ORM");
      if (deps["trpc"])          stack.push("tRPC");
      if (deps["@trpc/server"])  stack.push("tRPC");
      if (deps["graphql"])       stack.push("GraphQL");
      if (deps["typescript"])    stack.push("TypeScript");
      if (deps["jest"])          stack.push("Jest");
      if (deps["vitest"])        stack.push("Vitest");
      if (deps["playwright"])    stack.push("Playwright");
      if (deps["tailwindcss"])   stack.push("Tailwind CSS");
      if (deps["redis"])         stack.push("Redis");
      if (deps["mongoose"])      stack.push("MongoDB/Mongoose");
    } catch {}
  }

  // Python
  if (fs.existsSync(path.join(repoPath, "requirements.txt"))) stack.push("Python");
  if (fs.existsSync(path.join(repoPath, "pyproject.toml")))   stack.push("Python");
  if (fs.existsSync(path.join(repoPath, "Pipfile")))          stack.push("Python/Pipenv");

  // Java / JVM
  if (fs.existsSync(path.join(repoPath, "pom.xml")))     stack.push("Java/Maven");
  if (fs.existsSync(path.join(repoPath, "build.gradle"))) stack.push("Java/Gradle");

  // Go
  if (fs.existsSync(path.join(repoPath, "go.mod"))) stack.push("Go");

  // Rust
  if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) stack.push("Rust");

  // Docker
  if (fs.existsSync(path.join(repoPath, "Dockerfile")))          stack.push("Docker");
  if (fs.existsSync(path.join(repoPath, "docker-compose.yml")))   stack.push("Docker Compose");
  if (fs.existsSync(path.join(repoPath, "docker-compose.yaml")))  stack.push("Docker Compose");

  return stack.length ? stack : ["Unknown — no package manifest found"];
}

// ── Entry point detection ─────────────────────────────────────────────────────

function detectEntryPoints(repoPath: string): string[] {
  const candidates = [
    "src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx",
    "src/app.ts",   "src/app.tsx",   "src/server.ts",
    "pages/_app.tsx", "pages/_app.ts",
    "app/page.tsx",   "app/layout.tsx",
    "index.ts",       "index.js",
    "server.ts",      "server.js",
    "main.py",        "app.py",       "manage.py",
    "cmd/main.go",    "main.go",
  ];
  return candidates.filter(f => fs.existsSync(path.join(repoPath, f)));
}

// ── Schema / migration detection ──────────────────────────────────────────────

function detectDBSchema(repoPath: string): string[] {
  const found: string[] = [];
  const searchDirs = ["prisma", "migrations", "db", "database", "schema", "src/db"];

  for (const dir of searchDirs) {
    const dirPath = path.join(repoPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    try {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        if (file.endsWith(".sql") || file.endsWith(".prisma") || file.includes("migration") || file.includes("schema")) {
          found.push(path.join(dir, file));
        }
      }
    } catch {}
  }
  return found;
}

// ── API route detection ───────────────────────────────────────────────────────

function detectAPIRoutes(repoPath: string): string[] {
  const found: string[] = [];
  const routeDirs = ["src/routes", "src/api", "pages/api", "app/api", "routes", "controllers"];

  for (const dir of routeDirs) {
    const dirPath = path.join(repoPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    try {
      walkDir(dirPath, (filePath) => {
        if (!IGNORE_EXTS.has(path.extname(filePath))) {
          found.push(filePath.replace(repoPath + path.sep, ""));
        }
      }, 3);
    } catch {}
  }
  return found.slice(0, 20); // top 20
}

// ── CI/CD config detection ────────────────────────────────────────────────────

function detectCIFiles(repoPath: string): string[] {
  const ciPaths = [
    ".github/workflows",
    "bitbucket-pipelines.yml",
    ".circleci/config.yml",
    "Jenkinsfile",
    ".gitlab-ci.yml",
    ".travis.yml",
  ];
  const found: string[] = [];
  for (const p of ciPaths) {
    const full = path.join(repoPath, p);
    if (fs.existsSync(full)) {
      if (fs.statSync(full).isDirectory()) {
        found.push(...fs.readdirSync(full).map(f => path.join(p, f)));
      } else {
        found.push(p);
      }
    }
  }
  return found;
}

// ── File relevance scoring ────────────────────────────────────────────────────

function scoreFileRelevance(filePath: string, content: string, featureKeywords: string[]): number {
  let score = 0;
  const lower = content.toLowerCase();
  const pathLower = filePath.toLowerCase();

  // Keyword matches in content
  for (const kw of featureKeywords) {
    const kwLower = kw.toLowerCase();
    const matches = (lower.match(new RegExp(kwLower, "g")) ?? []).length;
    score += Math.min(matches * 0.1, 0.3);
  }

  // Keyword matches in path
  for (const kw of featureKeywords) {
    if (pathLower.includes(kw.toLowerCase())) score += 0.2;
  }

  // Penalise test files slightly (they are less primary)
  if (pathLower.includes(".test.") || pathLower.includes(".spec.")) score *= 0.8;

  // Boost core files
  if (pathLower.includes("service") || pathLower.includes("controller") || pathLower.includes("route")) score += 0.1;

  return Math.min(score, 1.0);
}

function walkDir(dir: string, callback: (filePath: string) => void, maxDepth: number, depth = 0): void {
  if (depth > maxDepth || !fs.existsSync(dir)) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !IGNORE_DIRS.has(e.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walkDir(full, callback, maxDepth, depth + 1);
      } else if (!IGNORE_EXTS.has(path.extname(e.name))) {
        callback(full);
      }
    }
  } catch {}
}

// ── Project overview reader ───────────────────────────────────────────────────
// project-overview.md is generated once on install (scripts/init-project.ts)
// and acts as the canonical "what this product is" for all agents.
// Using this file avoids re-scanning the codebase on every pipeline run.

function readProjectOverview(): string | null {
  // Check memory/project-overview.md relative to THIS file's location (.agentsdlc/tools/)
  const candidates = [
    path.resolve(__dirname, "../memory/project-overview.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf8")
          .replace(/^<!--.*?-->\s*/s, "")   // strip auto-generated comment header
          .trim();
        if (content.length > 50) {          // ignore empty/stub files
          return content.slice(0, 4000);
        }
      } catch {}
    }
  }
  return null;
}

// ── Key file reader ───────────────────────────────────────────────────────────
// Reads actual file contents so agents understand the REAL product, not just
// its file tree. This is the primary defence against hallucination.

function safeReadExcerpt(filePath: string, maxChars = 600): string {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.slice(0, maxChars).replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

function readKeyFiles(
  repoPath:    string,
  entryPoints: string[],
  apiRoutes:   string[],
): KeyFileExcerpt[] {
  const excerpts: KeyFileExcerpt[] = [];

  // 1. README — the most direct description of what the product is
  for (const readme of ["README.md", "readme.md", "README.txt", "README"]) {
    const full = path.join(repoPath, readme);
    if (fs.existsSync(full)) {
      const content = safeReadExcerpt(full, 1500);
      if (content) excerpts.push({ path: readme, content, reason: "Project README — describes what this product is" });
      break;
    }
  }

  // 2. CLAUDE.md / docs — may have product context
  for (const doc of ["CLAUDE.md", "docs/overview.md", "docs/README.md", "PROGRESS.md"]) {
    const full = path.join(repoPath, doc);
    if (fs.existsSync(full)) {
      const content = safeReadExcerpt(full, 800);
      if (content) excerpts.push({ path: doc, content, reason: "Project documentation / context file" });
    }
  }

  // 3. Entry points — main.py, app.py, index.ts etc show app bootstrap & purpose
  for (const ep of entryPoints.slice(0, 3)) {
    const full = path.join(repoPath, ep);
    const content = safeReadExcerpt(full, 600);
    if (content) excerpts.push({ path: ep, content, reason: "Application entry point — shows bootstrapped modules and purpose" });
  }

  // 4. First few API route/router files — show what endpoints exist
  for (const route of apiRoutes.slice(0, 4)) {
    const full = fs.existsSync(route) ? route : path.join(repoPath, route);
    const content = safeReadExcerpt(full, 400);
    if (content) excerpts.push({ path: route, content, reason: "API route file — shows existing endpoints" });
  }

  // 5. Models / schema — what data this product manages
  for (const modelFile of ["models.py", "src/models/index.ts", "prisma/schema.prisma", "database.py"]) {
    const full = path.join(repoPath, modelFile);
    if (fs.existsSync(full)) {
      const content = safeReadExcerpt(full, 600);
      if (content) excerpts.push({ path: modelFile, content, reason: "Data model — shows what entities this product manages" });
      break;
    }
  }

  // 6. package.json / pyproject.toml description field
  const pkgPath = path.join(repoPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.description) {
        excerpts.push({ path: "package.json", content: `name: ${pkg.name}\ndescription: ${pkg.description}`, reason: "Package description" });
      }
    } catch {}
  }

  return excerpts;
}

function buildProjectIdentity(excerpts: KeyFileExcerpt[], techStack: string[]): string {
  // Prefer the pre-generated overview if it exists — it's richer and saves scanning time
  const overview = readProjectOverview();
  if (overview) {
    return `[From memory/project-overview.md]\n${overview}`;
  }

  const parts: string[] = [`Tech stack: ${techStack.join(", ")}.`];
  for (const e of excerpts.slice(0, 4)) {
    // Take only first 300 chars per file to keep identity concise
    parts.push(`\n[${e.path}]\n${e.content.slice(0, 300)}`);
  }
  return parts.join("\n");
}

// ── Main scanner ──────────────────────────────────────────────────────────────

export async function scanCodebase(
  repoPath:        string,
  featureKeywords: string[] = []
): Promise<CodebaseContext> {
  const fileTree    = buildFileTree(repoPath, 5);
  const techStack   = detectTechStack(repoPath);
  const entryPoints = detectEntryPoints(repoPath);
  const dbSchema    = detectDBSchema(repoPath);
  const apiRoutes   = detectAPIRoutes(repoPath);
  const ciFiles     = detectCIFiles(repoPath);
  const testPattern = entryPoints.some(e => e.includes(".ts")) ? "**/*.test.ts" : "**/*.test.js";

  // Score files for relevance to the feature
  const relevantFiles: RelevantFile[] = [];

  if (featureKeywords.length > 0) {
    walkDir(repoPath, (filePath) => {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const score   = scoreFileRelevance(filePath, content, featureKeywords);
        if (score > 0.2) {
          relevantFiles.push({
            path:    filePath.replace(repoPath + path.sep, ""),
            score,
            reason:  `Keywords matched: ${featureKeywords.filter(kw => content.toLowerCase().includes(kw.toLowerCase())).join(", ")}`,
            excerpt: content.slice(0, 300).replace(/\n+/g, " "),
          });
        }
      } catch {}
    }, 5);

    relevantFiles.sort((a, b) => b.score - a.score);
    relevantFiles.splice(10); // Keep top 10
  }

  const keyFileExcerpts = readKeyFiles(repoPath, entryPoints, apiRoutes);
  const projectIdentity = buildProjectIdentity(keyFileExcerpts, techStack);

  const summary = [
    `${techStack.join(", ")} project.`,
    entryPoints.length > 0 ? `Entry points: ${entryPoints.join(", ")}.` : "",
    dbSchema.length > 0    ? `DB schema files: ${dbSchema.join(", ")}.` : "",
    apiRoutes.length > 0   ? `API routes in: ${apiRoutes.slice(0, 5).join(", ")}${apiRoutes.length > 5 ? "..." : ""}.` : "",
    ciFiles.length > 0     ? `CI/CD: ${ciFiles.join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  return {
    fileTree,
    techStack,
    entryPoints,
    relevantFiles,
    dbSchema,
    apiRoutes,
    testPatterns: [testPattern],
    ciFiles,
    summary,
    keyFileExcerpts,
    projectIdentity,
  };
}
