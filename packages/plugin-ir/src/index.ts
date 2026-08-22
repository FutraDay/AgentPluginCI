export type McpTransport = "stdio" | "streamable-http" | "sse";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface PluginIdentity {
  name: string;
  version?: string;
  description?: string;
  authorName?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

export interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
}

export interface CapabilitySource {
  type: "mcp";
  server: string;
  operation: string;
}

export interface CapabilityDefinition {
  id: string;
  kind: "tool";
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  source: CapabilitySource;
}

export interface McpServerDefinition {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface PluginIR {
  identity: PluginIdentity;
  skills: SkillDefinition[];
  mcpServers: McpServerDefinition[];
  capabilities?: CapabilityDefinition[];
  extensions?: Record<string, Record<string, unknown>>;
}
