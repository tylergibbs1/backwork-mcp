import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Skills shipped in the Claude Code plugin; the same folders are zipped for claude.ai upload. */
export const SKILLS_DIR = new URL("../plugins/backwork/skills/", import.meta.url).pathname;

// The strictest of the documented limits, so one SKILL.md is valid in Claude Code, the API, and claude.ai upload:
// https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview (name, description <= 1024)
// https://support.claude.com/en/articles/12512198-creating-custom-skills (claude.ai description <= 200)
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;
const RESERVED_WORDS = ["anthropic", "claude"];
const ALLOWED_KEYS = new Set(["name", "description"]);

/**
 * Parses and validates one skill folder. Frontmatter is limited to plain `key: value`
 * lines with the keys every surface accepts, so no YAML parser is needed and a value
 * can't be misread as YAML syntax. Throws with every problem found.
 */
export function readSkill(dir) {
  const folder = dir.split("/").filter(Boolean).at(-1);
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${folder}/SKILL.md: missing --- frontmatter block at the top of the file`);

  const errors = [];
  const fields = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([a-z-]+): (.+)$/.exec(line);
    if (!pair) {
      errors.push(`frontmatter line is not a plain "key: value": ${JSON.stringify(line)}`);
      continue;
    }
    const [, key, value] = pair;
    if (!ALLOWED_KEYS.has(key)) errors.push(`frontmatter key "${key}" is not portable; allowed: ${[...ALLOWED_KEYS].join(", ")}`);
    if (/: | #|^["'&*!|>%@`{[]/.test(value)) errors.push(`${key} value would be parsed as YAML syntax, rephrase it: ${JSON.stringify(value)}`);
    fields[key] = value;
  }

  const { name, description } = fields;
  if (!name) errors.push("name is required");
  else {
    if (!NAME_PATTERN.test(name)) errors.push(`name "${name}" must be lowercase letters, digits, and single hyphens`);
    if (name.length > NAME_MAX) errors.push(`name is ${name.length} characters; max ${NAME_MAX}`);
    if (RESERVED_WORDS.some((word) => name.includes(word))) errors.push(`name must not contain ${RESERVED_WORDS.join(" or ")}`);
    if (name !== folder) errors.push(`name "${name}" must match its folder "${folder}" (claude.ai requires it)`);
  }
  if (!description) errors.push("description is required");
  else {
    if (description.length > DESCRIPTION_MAX) errors.push(`description is ${description.length} characters; max ${DESCRIPTION_MAX}`);
    if (/<[a-z/!]/i.test(description)) errors.push("description must not contain XML tags");
  }

  if (errors.length) throw new Error(`${folder}/SKILL.md:\n  - ${errors.join("\n  - ")}`);
  return { name, description, body: match[2], dir };
}

export function readAllSkills() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkill(join(SKILLS_DIR, entry.name)));
}
