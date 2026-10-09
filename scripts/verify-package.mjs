import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "backwork-package-"));
const packageName = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
const runtimeVersions = process.argv.slice(2);
const npmEnvironment = { ...process.env };
// An outer npm exec must not supply the call/packages for these child commands.
for (const key of Object.keys(npmEnvironment)) {
  if (/^npm_config_(call|package)$/i.test(key)) delete npmEnvironment[key];
}
for (const version of runtimeVersions) {
  assert.match(version, /^\d+\.\d+\.\d+$/, "runtime versions must be exact Node releases");
}

function npm(args, cwd, inherit = false) {
  const executable = process.env.npm_execpath;
  return execFileSync(executable ? process.execPath : "npm", executable ? [executable, ...args] : args, {
    cwd,
    env: npmEnvironment,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    timeout: 180_000,
  });
}

function packageFor(entry) {
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (pkg.name) return pkg;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  throw new Error(`No package metadata for ${entry}`);
}

try {
  const npmMajor = Number(npm(["--version"], root).trim().split(".")[0]);
  const packResult = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root));
  // npm 12 keys pack metadata by package name; npm 10/11 return an array.
  const packed = Array.isArray(packResult) ? packResult[0] : packResult[packageName];
  assert.ok(packed?.filename, "npm pack must return the package tarball metadata");
  const tarball = join(temporary, packed.filename);
  const consumer = join(temporary, "consumer");
  // This directory intentionally has no repository lockfile, overrides, or node_modules.
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "backwork-package-verification",
    private: true,
    type: "module",
    dependencies: { [packageName]: `file:${tarball}` },
  }) + "\n");
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer, true);

  const serverEntry = resolve(consumer, "node_modules", packageName, "build/src/index.js");
  const serverRequire = createRequire(serverEntry);
  const sdkEntry = serverRequire.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const sdk = packageFor(sdkEntry);
  const adapter = packageFor(createRequire(sdkEntry).resolve("@hono/node-server"));
  console.log(`Clean consumer installed SDK ${sdk.version}, Hono adapter ${adapter.version}.`);

  for (const smoke of ["mcp-smoke.mjs", "mcp-http-auth-smoke.mjs"]) {
    const script = join(root, "scripts", smoke);
    execFileSync(process.execPath, [script, serverEntry], { cwd: consumer, stdio: "inherit", timeout: 60_000 });
    for (const version of runtimeVersions) {
      if (process.version === `v${version}`) continue;
      const scriptApproval = npmMajor >= 12 ? ["--allow-scripts=node"] : [];
      npm(["exec", "--yes", ...scriptApproval, `--package=node@${version}`, "--", "node", script, serverEntry], consumer, true);
    }
  }

  assert.ok(packed.bundled?.length > 0, "the runtime dependencies must ship in the tarball");
  const locked = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  for (const [path, metadata] of Object.entries(locked.packages)) {
    if (!metadata.dev) continue;
    const name = path.split("node_modules/").at(-1);
    assert.equal(packed.bundled.includes(name), false, `dev-only ${name} must not ship`);
    assert.equal(packed.files.some((file) => file.path.startsWith(`${path}/`)), false, `dev-only ${path} must not ship`);
  }
  console.log(`Package verified: ${packed.bundled.length} bundled production packages, ${packed.size} bytes compressed.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
