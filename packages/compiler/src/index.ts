import type { PluginIR } from "@agent-plugin-ci/plugin-ir";
import { MCP_SCHEMA, PLUGIN_SCHEMA } from "@agent-plugin-ci/spec-agent-plugins-v1";

export interface CompiledPlugin {
  manifest: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  skills: Record<string, string>;
}

export function compilePlugin(ir: PluginIR): CompiledPlugin {
  const manifest: Record<string, unknown> = {
    $schema: PLUGIN_SCHEMA,
    name: ir.identity.name
  };
  for (const key of ["version", "description", "homepage", "repository", "license"] as const) {
    const value = ir.identity[key];
    if (value) manifest[key] = value;
  }
  if (ir.identity.keywords?.length) manifest.keywords = ir.identity.keywords;
  if (ir.identity.authorName) manifest.author = { name: ir.identity.authorName };
  if (ir.extensions) manifest.extensions = ir.extensions;

  const skills = Object.fromEntries(ir.skills.map((skill) => [skill.name, `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.instructions.trim()}\n`]));

  const mcpServers = Object.fromEntries(ir.mcpServers.map((server) => {
    if (server.transport === "stdio") {
      return [server.name, {
        type: "stdio",
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {})
      }];
    }
    return [server.name, { type: server.transport, url: server.url }];
  }));

  const mcp = ir.mcpServers.length ? { $schema: MCP_SCHEMA, mcpServers } : undefined;
  return { manifest, mcp, skills };
}
