import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const workflow = readFileSync(new URL(".github/workflows/release.yml", root), "utf8");

test("the release workflow publishes through npm Trusted Publishing, not a token", () => {
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./, "trusted publishing needs no stored secret");
  assert.match(workflow, /id-token: write/);
  // npmjs.com trusts this exact environment name; renaming it breaks publishing.
  assert.match(workflow, /environment: npm\n/);
  assert.match(workflow, /npm publish --provenance --access public/);
  assert.match(workflow, /mcp-publisher login github-oidc/);
});

test("npm version syncs server.json and SERVER_VERSION", () => {
  const dir = mkdtempSync(join(tmpdir(), "backwork-version-"));
  try {
    for (const path of ["package.json", "server.json", "src/index.ts", "scripts/sync-version.mjs"]) {
      cpSync(new URL(path, root), join(dir, path));
    }
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.version = "9.8.7";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    execFileSync("node", ["scripts/sync-version.mjs"], { cwd: dir, stdio: "ignore" });

    const manifest = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
    assert.equal(manifest.version, "9.8.7");
    assert.deepEqual(manifest.packages.map((p) => p.version), ["9.8.7"]);
    assert.match(readFileSync(join(dir, "src/index.ts"), "utf8"), /export const SERVER_VERSION = "9\.8\.7";/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
