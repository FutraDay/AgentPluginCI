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

export interface McpCapabilitySource {
  type: "mcp";
  server: string;
  operation: string;
}

export interface OpenApiCapabilitySource {
  type: "openapi";
  api: string;
  method: string;
  path: string;
  operationId?: string;
  baseUrl?: string;
}

export type CapabilitySource = McpCapabilitySource | OpenApiCapabilitySource;

export type CapabilityParameterLocation = "path" | "query" | "querystring" | "header" | "cookie";

export interface CapabilityParameterDefinition {
  name: string;
  in: CapabilityParameterLocation;
  required: boolean;
  description?: string;
  schema?: JsonObject;
}

export interface CapabilityRequestBodyContent {
  mediaType: string;
  schema?: JsonObject;
}

export interface CapabilityRequestBodyDefinition {
  required: boolean;
  description?: string;
  content: CapabilityRequestBodyContent[];
}

export interface CapabilityDefinition {
  id: string;
  kind: "tool" | "http-operation";
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  parameters?: CapabilityParameterDefinition[];
  requestBody?: CapabilityRequestBodyDefinition;
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
