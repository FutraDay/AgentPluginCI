import { describe, expect, it } from "vitest";
import { compilePlugin } from "@agent-plugin-ci/compiler";
import { validateCompiledPlugin } from "@agent-plugin-ci/validator";
import { ingestMcpConfig } from "./index.js";
import type { McpToolDiscoverer } from "./types.js";

describe("MCP ingestion end to end", () => {
  it("flows MCP config and discovered tools through PluginIR, compiler, and validator", async () => {
    const discoverer: McpToolDiscoverer = {
      async discover(server) {
        return [{
          name: "lookup_customer",
          description: `Look up a customer through ${server.name}`,
          inputSchema: { type: "object", required: ["email"], properties: { email: { type: "string" } } }
        }];
      }
    };

    const { ir, warnings } = await ingestMcpConfig(
      { mcpServers: { crm: { type: "streamable-http", url: "https://example.com/mcp" } } },
      { pluginName: "crm-plugin", pluginVersion: "0.1.0", discoverer }
    );
    const compiled = compilePlugin(ir);
    const validation = validateCompiledPlugin(compiled.manifest, compiled.mcp);

    expect(warnings).toEqual([]);
    expect(ir.capabilities).toHaveLength(1);
    expect(compiled.skills["lookup-customer"]).toContain("crm.lookup_customer");
    expect(compiled.mcp).toMatchObject({ mcpServers: { crm: { type: "streamable-http", url: "https://example.com/mcp" } } });
    expect(validation).toEqual({ ok: true, errors: [], warnings: [] });
  });
});
