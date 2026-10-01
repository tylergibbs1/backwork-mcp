import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TOOL_OPERATIONS } from "../build/src/tool-operations.js";
import { readAllSkills, readSkill } from "../scripts/claude-skills.mjs";

const root = new URL("../", import.meta.url).pathname;
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const marketplace = readJson(".claude-plugin/marketplace.json");
const pluginDir = "plugins/backwork";
const plugin = readJson(`${pluginDir}/.claude-plugin/plugin.json`);
const skills = readAllSkills();

const EXPECTED_SKILLS = ["claim-denial-appeal-prep", "coverage-check", "policy-change-review", "prior-auth-research"];
// The hosted OAuth grant is read-only; skills must not steer Claude to write actions.
const WRITE_ACTIONS = new Set(["acknowledge", "bulk_acknowledge", "create", "update", "delete", "test"]);

test("marketplace.json lists the backwork plugin from a path inside the repo", () => {
  assert.equal(marketplace.name, "backwork");
  assert.ok(marketplace.owner?.name);
  assert.ok(marketplace.description);
  const [entry] = marketplace.plugins;
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(entry.name, "backwork");
  assert.equal(entry.source, `./${pluginDir}`);
  assert.ok(existsSync(join(root, pluginDir, ".claude-plugin/plugin.json")));
  // The install id uses the entry name and skills are namespaced by the manifest name; they must agree.
  assert.equal(plugin.name, entry.name);
});

test("plugin.json declares metadata and keeps components in their default folders", () => {
  for (const field of ["name", "version", "description", "homepage", "license"]) assert.ok(plugin[field], field);
  assert.ok(plugin.author?.name);
  for (const field of ["skills", "commands", "agents", "mcpServers"]) assert.equal(plugin[field], undefined, field);
});

test("the plugin's MCP server is the hosted OAuth endpoint with no credentials", () => {
  const { mcpServers } = readJson(`${pluginDir}/.mcp.json`);
  const server = readJson("server.json");
  assert.deepEqual(Object.keys(mcpServers), ["backwork"]);
  assert.deepEqual(mcpServers.backwork, { type: "http", url: server.remotes[0].url });
});

test("every SKILL.md has portable frontmatter, and the expected skills ship", () => {
  assert.deepEqual(skills.map((skill) => skill.name).sort(), EXPECTED_SKILLS);
});

test("every skill carries the citation, inferred-code, PHI, and confirm-with-payer rules", () => {
  for (const { name, body } of skills) {
    assert.match(body, /inferred_title_match/, `${name}: inferred codes`);
    assert.match(body, /\*\*No PHI\.\*\*/, `${name}: PHI rule`);
    assert.match(body, /policy number \(`policy_id`\).*effective date.*source URL/, `${name}: citation fields`);
    assert.match(body, /Confirm\b.*\bwith the payer/, `${name}: confirm with payer`);
    assert.match(body, /Say when you don't know/, `${name}: unknowns`);
    assert.match(body, /## Examples/, `${name}: worked examples`);
  }
});

test("skills name only tools and read actions the server registers", () => {
  const allActions = new Set(Object.values(TOOL_OPERATIONS).flatMap((actions) => Object.keys(actions)));
  for (const { name, body } of skills) {
    for (const [, tool] of body.matchAll(/`(?:mcp__plugin_backwork_backwork__)?backwork_([a-z_]+)`/g)) {
      assert.ok(tool in TOOL_OPERATIONS, `${name}: unknown tool backwork_${tool}`);
    }
    for (const [, action] of body.matchAll(/action: "([a-z_]+)"/g)) {
      assert.ok(allActions.has(action), `${name}: unknown action ${action}`);
      assert.ok(!WRITE_ACTIONS.has(action), `${name}: write action ${action} is unavailable on the hosted server`);
    }
  }
});

test("slash commands invoke skills that exist", () => {
  const commands = readdirSync(join(root, pluginDir, "commands"));
  assert.deepEqual(commands.sort(), ["coverage.md", "pa.md"]);
  for (const file of commands) {
    const text = readFileSync(join(root, pluginDir, "commands", file), "utf8");
    assert.match(text, /^---\ndescription: .+\nargument-hint: .+\n---\n/);
    const [, skill] = /`backwork:([a-z-]+)`/.exec(text) ?? [];
    assert.ok(EXPECTED_SKILLS.includes(skill), `${file} names skill ${skill}`);
  }
});

test("readSkill rejects frontmatter that some surface would refuse", () => {
  const make = (folder, frontmatter) => {
    const dir = join(mkdtempSync(join(tmpdir(), "skill-")), folder);
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nBody\n`);
    return dir;
  };
  assert.equal(readSkill(make("ok-skill", "name: ok-skill\ndescription: Does a thing. Use when asked.")).name, "ok-skill");
  const cases = [
    ["a", "description: missing name", /name is required/],
    ["Bad", "name: Bad\ndescription: x", /lowercase/],
    ["claude-helper", "name: claude-helper\ndescription: x", /must not contain/],
    ["other", "name: mismatch\ndescription: x", /must match its folder/],
    ["long", `name: long\ndescription: ${"x".repeat(201)}`, /max 200/],
    ["colon", "name: colon\ndescription: Checks codes: fast", /YAML syntax/],
    ["xml", "name: xml\ndescription: Uses <tag> text", /XML/],
    ["extra", "name: extra\ndescription: x\nallowed-tools: Read", /not portable/],
  ];
  for (const [folder, frontmatter, error] of cases) assert.throws(() => readSkill(make(folder, frontmatter)), error, folder);
});

test("the claude.ai build zips each skill with its folder at the archive root", () => {
  const out = mkdtempSync(join(tmpdir(), "skill-zips-"));
  execFileSync("node", [join(root, "scripts/build-claude-skills.mjs"), out], { stdio: "ignore" });
  assert.deepEqual(readdirSync(out).sort(), EXPECTED_SKILLS.map((name) => `${name}.zip`));
  for (const name of EXPECTED_SKILLS) {
    const entries = execFileSync("unzip", ["-Z1", join(out, `${name}.zip`)], { encoding: "utf8" }).trim().split("\n");
    assert.ok(entries.includes(`${name}/SKILL.md`), `${name}.zip entries: ${entries.join(", ")}`);
    assert.ok(entries.every((entry) => entry.startsWith(`${name}/`)), `${name}.zip has files outside ${name}/`);
  }
});
