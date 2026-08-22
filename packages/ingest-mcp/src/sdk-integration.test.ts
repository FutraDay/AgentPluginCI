import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSdkMcpToolDiscoverer, ingestMcpConfig } from "./index.js";

const fixtureServer = fileURLToPath(new URL("../test-fixtures/stdio-server.mjs", import.meta.url));

describe("SDK-backed MCP discovery", () => {
  it("performs a real stdio MCP handshake and tools/list discovery", async () => {
    const discoverer = createSdkMcpToolDiscoverer({ allowStdio: true, timeoutMs: 5_000 });
    const result = await ingestMcpConfig(
      { mcpServers: { fixture: { command: process.execPath, args: [fixtureServer] } } },
      { pluginName: "sdk-fixture-plugin", discoverer }
    );

    expect(result.warnings).toEqual([]);
    expect(result.ir.capabilities?.[0]).toMatchObject({ name: "echo_message", source: { type: "mcp", server: "fixture" } });
    expect(result.ir.skills[0]?.name).toBe("echo-message");
    expect(result.ir.skills[0]?.description).toBe("Echo a message");
  }, 10_000);
});
