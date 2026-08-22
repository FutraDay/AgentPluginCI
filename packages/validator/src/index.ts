import { MCP_FIELDS, MCP_SCHEMA, PLUGIN_FIELDS, PLUGIN_NAME_RE, PLUGIN_SCHEMA } from "@agent-plugin-ci/spec-agent-plugins-v1";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateCompiledPlugin(manifest: Record<string, unknown>, mcp?: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (manifest.$schema !== PLUGIN_SCHEMA) errors.push("plugin.json has an unsupported $schema");
  if (typeof manifest.name !== "string" || !PLUGIN_NAME_RE.test(manifest.name)) errors.push("plugin.json name is invalid");
  for (const key of Object.keys(manifest)) {
    if (!PLUGIN_FIELDS.has(key)) warnings.push(`plugin.json unknown top-level field: ${key}`);
  }

  if (mcp) {
    if (mcp.$schema !== MCP_SCHEMA) errors.push("mcp.json has an unsupported $schema");
    for (const key of Object.keys(mcp)) if (!MCP_FIELDS.has(key)) errors.push(`mcp.json unknown top-level field: ${key}`);
    const servers = mcp.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) errors.push("mcp.json mcpServers must be an object");
    else validateServers(servers as Record<string, unknown>, errors);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateServers(servers: Record<string, unknown>, errors: string[]): void {
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`MCP server ${name} must be an object`);
      continue;
    }
    const server = raw as Record<string, unknown>;
    const type = server.type;
    if (type === "stdio") {
      if (typeof server.command !== "string" || !server.command) errors.push(`MCP stdio server ${name} requires command`);
    } else if (type === "streamable-http" || type === "sse") {
      if (typeof server.url !== "string" || !/^https?:\/\//.test(server.url)) errors.push(`MCP remote server ${name} requires absolute HTTP(S) url`);
      if (typeof server.url === "string" && server.url.includes("#")) errors.push(`MCP remote server ${name} url must not contain a fragment`);
    } else {
      errors.push(`MCP server ${name} has unsupported type`);
    }
  }
}
