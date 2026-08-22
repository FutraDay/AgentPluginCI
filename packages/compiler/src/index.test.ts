import { describe, expect, it } from "vitest";
import { compilePlugin } from "./index.js";

const fixture = {
  identity: { name: "test-plugin", version: "1.0.0" },
  skills: [{ name: "hello", description: "Say hello", instructions: "Say hello." }],
  mcpServers: [{ name: "api", transport: "streamable-http" as const, url: "https://example.com/mcp" }]
};

describe("compilePlugin", () => {
  it("compiles portable Agent Plugins 1.0 components", () => {
    const result = compilePlugin(fixture);
    expect(result.manifest.name).toBe("test-plugin");
    expect(result.mcp?.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(result.skills.hello).toContain('name: "hello"');
  });

  it("quotes untrusted skill metadata in YAML frontmatter", () => {
    const result = compilePlugin({ ...fixture, skills: [{ name: "safe", description: "line one\n---\ninjected: true", instructions: "Use safely." }] });
    expect(result.skills.safe).toContain('description: "line one\\n---\\ninjected: true"');
    expect(result.skills.safe).not.toContain("\n---\ninjected: true");
  });
});
