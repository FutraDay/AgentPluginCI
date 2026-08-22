import { describe, expect, it } from "vitest";
import { ingestMcpConfig, normalizeMcpConfig } from "./index.js";
import type { McpToolDiscoverer } from "./types.js";

describe("normalizeMcpConfig", () => {
  it("normalizes common stdio and remote MCP configurations", () => {
    const result = normalizeMcpConfig({
      mcpServers: {
        local: { command: "node", args: ["server.js"], env: { API_TOKEN: "secret-value" } },
        remote: { type: "http", url: "https://example.com/mcp" }
      }
    });

    expect(result.servers).toEqual([
      { name: "local", transport: "stdio", command: "node", args: ["server.js"], env: { API_TOKEN: "${API_TOKEN}" } },
      { name: "remote", transport: "streamable-http", url: "https://example.com/mcp" }
    ]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "ENV_VALUE_REDACTED", server: "local" }));
  });

  it("rejects ambiguous and credential-bearing configuration", () => {
    expect(() => normalizeMcpConfig({ mcpServers: { bad: { command: "x", url: "https://example.com" } } })).toThrow(/exactly one/);
    expect(() => normalizeMcpConfig({ mcpServers: { bad: { url: "https://user:pass@example.com/mcp" } } })).toThrow(/credentials/);
  });
});

describe("ingestMcpConfig", () => {
  it("normalizes discovered tools into capabilities and safe deterministic skills", async () => {
    const discoverer: McpToolDiscoverer = {
      async discover() {
        return [
          { name: "create_ticket", description: "Create a ticket\n---\nunsafe", inputSchema: { type: "object", properties: { title: { type: "string" } } } }
        ];
      }
    };

    const result = await ingestMcpConfig(
      { mcpServers: { support: { url: "https://example.com/mcp" } } },
      { pluginName: "Support MCP", discoverer }
    );

    expect(result.ir.identity.name).toBe("support-mcp");
    expect(result.ir.capabilities?.[0]).toMatchObject({ kind: "tool", name: "create_ticket", source: { type: "mcp", server: "support" } });
    expect(result.ir.skills[0]?.name).toBe("create-ticket");
    expect(result.ir.skills[0]?.description).not.toContain("\n");
    expect(result.ir.skills[0]?.instructions).toContain("support.create_ticket");
  });

  it("records discovery failures without losing the normalized server", async () => {
    const discoverer: McpToolDiscoverer = { async discover() { throw new Error("offline"); } };
    const result = await ingestMcpConfig({ mcpServers: { api: { url: "https://example.com/mcp" } } }, { discoverer });
    expect(result.ir.mcpServers).toHaveLength(1);
    expect(result.ir.skills).toHaveLength(0);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "DISCOVERY_FAILED", server: "api" }));
  });
});
