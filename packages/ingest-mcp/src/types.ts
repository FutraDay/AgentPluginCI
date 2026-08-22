import type { JsonObject, McpServerDefinition, PluginIR } from "@agent-plugin-ci/plugin-ir";

export interface IngestionWarning {
  code: string;
  message: string;
  server?: string;
}

export interface NormalizedMcpConfig {
  servers: McpServerDefinition[];
  warnings: IngestionWarning[];
}

export interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface McpToolDiscoverer {
  discover(server: McpServerDefinition): Promise<DiscoveredMcpTool[]>;
}

export interface IngestMcpOptions {
  pluginName?: string;
  pluginVersion?: string;
  description?: string;
  discoverer?: McpToolDiscoverer;
}

export interface IngestMcpResult {
  ir: PluginIR;
  warnings: IngestionWarning[];
}
