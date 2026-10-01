// Zips each plugin skill for upload to claude.ai (Customize > Skills > Add).
// Each zip holds the skill folder at its root: <name>.zip -> <name>/SKILL.md.
// Usage: node scripts/build-claude-skills.mjs [outDir]   (default: dist/claude-skills)
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { SKILLS_DIR, readAllSkills } from "./claude-skills.mjs";

const outDir = resolve(process.argv[2] ?? "dist/claude-skills");
const skills = readAllSkills();

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const { name } of skills) {
  const zipPath = resolve(outDir, `${name}.zip`);
  // -X drops extra file attributes; cwd keeps <name>/ as the top-level folder.
  execFileSync("zip", ["-r", "-X", "-q", zipPath, name, "-x", "*.DS_Store"], { cwd: SKILLS_DIR, stdio: "inherit" });
  console.log(zipPath);
}
