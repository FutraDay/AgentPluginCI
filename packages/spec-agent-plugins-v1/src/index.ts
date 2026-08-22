export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const PLUGIN_NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const PLUGIN_FIELDS = new Set([
  "$schema", "name", "version", "description", "author",
  "homepage", "repository", "license", "keywords", "extensions"
]);
export const MCP_FIELDS = new Set(["$schema", "mcpServers"]);
