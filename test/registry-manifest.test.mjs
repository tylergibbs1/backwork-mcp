import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import Ajv from "ajv";
import addFormats from "ajv-formats";

import { SERVER_VERSION } from "../build/src/index.js";

const read = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const manifest = await read("server.json");
const pkg = await read("package.json");
// Vendored copy of the schema named by manifest.$schema.
const registrySchema = await read("schemas/server.schema.json");

test("server.json is valid against the MCP registry schema", () => {
  assert.equal(manifest.$schema, registrySchema.$id);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(registrySchema);
  assert.ok(validate(manifest), JSON.stringify(validate.errors, null, 2));
});

test("server.json agrees with the npm package and the running server", () => {
  assert.equal(manifest.name, pkg.mcpName, "npm ownership verification requires mcpName to equal the server name");
  assert.equal(manifest.version, pkg.version);
  assert.equal(SERVER_VERSION, pkg.version);
  const [npmPackage] = manifest.packages;
  assert.equal(npmPackage.identifier, pkg.name);
  assert.equal(npmPackage.version, pkg.version);
});

test("the remote is the hosted OAuth endpoint documented in the README", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.deepEqual(manifest.remotes, [{ type: "streamable-http", url: "https://backworkhealth.com/mcp" }]);
  assert.ok(readme.includes("BACKWORK_MCP_OAUTH_RESOURCE=https://backworkhealth.com/mcp"));
});
