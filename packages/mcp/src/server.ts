import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthService } from "./auth/auth-service.js";
import { KaneoClient } from "./kaneo/client.js";
import { registerTools } from "./tools/register.js";
import { normalizeBaseUrl } from "./utils/normalize-base-url.js";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json") as {
  version: string;
};

export function createMcpServer(): McpServer {
  const local = process.env.KANEO_TRANSPORT === "local";
  const endpoint = local
    ? process.env.KANEO_LOCAL_API_ENDPOINT || "http://127.0.0.1:5180/kaneo/api"
    : process.env.KANEO_API_URL || "http://localhost:1337";
  if (local) {
    const target = new URL(endpoint);
    if (
      target.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      target.username ||
      target.password
    ) {
      throw new Error("Local Kaneo endpoint must be an HTTP loopback URL");
    }
  }
  const baseUrl = normalizeBaseUrl(endpoint);
  const clientId = process.env.KANEO_MCP_CLIENT_ID || "kaneo-mcp";
  const apiKey = process.env.KANEO_API_KEY || undefined;
  const auth = new AuthService({ baseUrl, clientId, apiKey });
  const client = new KaneoClient({ baseUrl, auth });
  const server = new McpServer({
    name: "kaneo-mcp",
    version: packageVersion,
  });
  registerTools(server, { client });
  return server;
}
