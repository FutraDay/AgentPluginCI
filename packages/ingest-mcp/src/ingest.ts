import type { CapabilityDefinition, JsonObject, SkillDefinition } from "@agent-plugin-ci/plugin-ir";
import { normalizeMcpConfig } from "./config.js";
import type { DiscoveredMcpTool, IngestMcpOptions, IngestMcpResult, IngestionWarning } from "./types.js";

const MAX_TOOLS_PER_SERVER = 200;
const MAX_SCHEMA_BYTES = 100_000;

export async function ingestMcpConfig(input: unknown, options: IngestMcpOptions = {}): Promise<IngestMcpResult> {
  const normalized = normalizeMcpConfig(input);
  const warnings = [...normalized.warnings];
  const capabilities: CapabilityDefinition[] = [];
  const skills: SkillDefinition[] = [];
  const skillNames = new Set<string>();

  if (options.discoverer) {
    for (const server of normalized.servers) {
      try {
        const tools = await options.discoverer.discover(server);
        if (tools.length > MAX_TOOLS_PER_SERVER) throw new Error(`server exposed more than ${MAX_TOOLS_PER_SERVER} tools`);
        for (const tool of tools) {
          const normalizedTool = normalizeTool(server.name, tool);
          capabilities.push(normalizedTool.capability);
          skills.push(makeSkill(server.name, normalizedTool.name, normalizedTool.description, skillNames));
        }
      } catch (error) {
        warnings.push({ code: "DISCOVERY_FAILED", message: errorMessage(error), server: server.name });
      }
    }
  }

  const pluginName = normalizePluginName(options.pluginName ?? `${normalized.servers[0]!.name}-plugin`);
  return {
    ir: {
      identity: {
        name: pluginName,
        ...(options.pluginVersion ? { version: cleanText(options.pluginVersion, 128) } : {}),
        ...(options.description ? { description: cleanText(options.description, 1000) } : {})
      },
      skills,
      mcpServers: normalized.servers,
      ...(capabilities.length ? { capabilities } : {})
    },
    warnings
  };
}

function normalizeTool(server: string, tool: DiscoveredMcpTool): { name: string; description: string; capability: CapabilityDefinition } {
  const name = cleanText(tool.name, 128);
  if (!name) throw new Error(`MCP server ${server} returned a tool with an empty name`);
  const description = cleanText(tool.description ?? `MCP tool ${name}`, 500);
  const inputSchema = tool.inputSchema ? sanitizeSchema(tool.inputSchema) : undefined;
  return {
    name,
    description,
    capability: {
      id: `mcp:${server}:${name}`,
      kind: "tool",
      name,
      description,
      ...(inputSchema ? { inputSchema } : {}),
      source: { type: "mcp", server, operation: name }
    }
  };
}

function makeSkill(server: string, toolName: string, description: string, used: Set<string>): SkillDefinition {
  const base = skillSlug(toolName) || "tool";
  let name = base;
  if (used.has(name)) name = `${skillSlug(server) || "mcp"}-${base}`;
  let suffix = 2;
  while (used.has(name)) name = `${skillSlug(server) || "mcp"}-${base}-${suffix++}`;
  used.add(name);
  return {
    name,
    description,
    instructions: `Use the MCP tool ${server}.${toolName} when it matches the user's request. Validate required arguments against the discovered input schema and do not invent missing values.`
  };
}

function sanitizeSchema(schema: JsonObject): JsonObject {
  let json: string;
  try { json = JSON.stringify(schema); } catch { throw new Error("MCP tool input schema is not JSON-serializable"); }
  if (json.length > MAX_SCHEMA_BYTES) throw new Error(`MCP tool input schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP tool input schema must be an object");
  rejectUnsafeKeys(parsed, 0);
  return parsed as JsonObject;
}

function rejectUnsafeKeys(value: unknown, depth: number): void {
  if (depth > 16) throw new Error("MCP tool input schema exceeds maximum nesting depth");
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectUnsafeKeys(item, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`MCP tool input schema contains unsafe key: ${key}`);
    rejectUnsafeKeys(child, depth + 1);
  }
}

function normalizePluginName(value: string): string {
  const result = slug(value).replace(/-{2,}/g, "-").slice(0, 100).replace(/^-+|-+$/g, "");
  if (!result) throw new Error("Unable to derive a valid plugin name from MCP configuration");
  return result;
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9.-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^-+|-+$/g, "");
}

function skillSlug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
