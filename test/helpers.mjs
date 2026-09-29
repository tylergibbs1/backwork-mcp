import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Starts the built stdio server with the given environment and returns a connected client. */
export async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["build/src/index.js"],
    env: { PATH: process.env.PATH ?? "", BACKWORK_API_KEY: "bwk_test_dummy", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "backwork-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
