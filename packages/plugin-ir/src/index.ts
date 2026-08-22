export type McpTransport = "stdio" | "streamable-http" | "sse";

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
  extensions?: Record<string, Record<string, unknown>>;
}

