// Runs from the npm `version` lifecycle: `npm version minor` bumps package.json,
// then this copies the new version to every other place that must agree with it.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

const manifestUrl = new URL("server.json", root);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
manifest.version = version;
for (const pkg of manifest.packages) pkg.version = version;
writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");

const indexUrl = new URL("src/index.ts", root);
const source = readFileSync(indexUrl, "utf8");
const pattern = /export const SERVER_VERSION = "[^"]+";/;
if (!pattern.test(source)) throw new Error("SERVER_VERSION declaration not found in src/index.ts");
writeFileSync(indexUrl, source.replace(pattern, `export const SERVER_VERSION = "${version}";`));

console.log(`Synced server.json and SERVER_VERSION to ${version}`);
