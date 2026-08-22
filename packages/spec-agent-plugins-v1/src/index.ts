import pluginJsonSchema from "./schemas/1.0.0/plugin.schema.json" with { type: "json" };
import mcpJsonSchema from "./schemas/1.0.0/mcp.schema.json" with { type: "json" };

export const AGENT_PLUGINS_V1_SCHEMA_SOURCE = {
  repository: "https://github.com/agentplugins/agent-plugins-spec",
  revision: "ff8ab5e392cc87bd88d87c060815a87490e51003",
  pluginSha256: "0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883",
  mcpSha256: "6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb"
} as const;

export const PLUGIN_JSON_SCHEMA = pluginJsonSchema;
export const MCP_JSON_SCHEMA = mcpJsonSchema;

export const PLUGIN_SCHEMA = PLUGIN_JSON_SCHEMA.$id;
export const MCP_SCHEMA = MCP_JSON_SCHEMA.$id;
export const PLUGIN_NAME_RE = new RegExp(PLUGIN_JSON_SCHEMA.properties.name.pattern);
export const PLUGIN_FIELDS = new Set(Object.keys(PLUGIN_JSON_SCHEMA.properties));
export const MCP_FIELDS = new Set(Object.keys(MCP_JSON_SCHEMA.properties));
