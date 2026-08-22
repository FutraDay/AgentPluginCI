import { describe, expect, it } from "vitest";
import { MCP_SCHEMA, PLUGIN_SCHEMA } from "@agent-plugin-ci/spec-agent-plugins-v1";
import { validateCompiledPlugin } from "./index.js";

const validManifest = () => ({ $schema: PLUGIN_SCHEMA, name: "example-plugin" });

function mcpWith(server: Record<string, unknown>) {
  return { $schema: MCP_SCHEMA, mcpServers: { example: server } };
}

describe("official Agent Plugins 1.0 schema validation", () => {
  it("accepts a manifest using every schema-defined metadata field", () => {
    const result = validateCompiledPlugin({
      $schema: PLUGIN_SCHEMA,
      name: "example.plugin",
      version: "1.2.3",
      description: "Example plugin",
      author: { name: "Example", email: "dev@example.com", url: "https://example.com" },
      homepage: "https://example.com/plugin",
      repository: "https://github.com/example/plugin",
      license: "MIT",
      keywords: ["example", "agent"],
      extensions: { "com.example.client": { enabled: true } }
    });

    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("rejects missing required manifest fields and schema-invalid names", () => {
    const missing = validateCompiledPlugin({ name: "example-plugin" });
    expect(missing.ok).toBe(false);
    expect(missing.errors).toContain("plugin.json missing required field: $schema");

    const invalidName = validateCompiledPlugin({ $schema: PLUGIN_SCHEMA, name: "Invalid--Name" });
    expect(invalidName.ok).toBe(false);
    expect(invalidName.errors.some((error) => error.includes("plugin.json/name"))).toBe(true);
  });

  it("enforces manifest field types, nested closed objects, and the 64-character name limit", () => {
    const result = validateCompiledPlugin({
      $schema: PLUGIN_SCHEMA,
      name: "a".repeat(65),
      version: 1,
      author: { name: "Example", unexpected: true },
      keywords: ["valid", 42]
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("at most 64 characters"))).toBe(true);
    expect(result.errors.some((error) => error.includes("plugin.json/version must be string"))).toBe(true);
    expect(result.errors.some((error) => error.includes("plugin.json/author unknown field: unexpected"))).toBe(true);
    expect(result.errors.some((error) => error.includes("plugin.json/keywords/1 must be string"))).toBe(true);
  });

  it("reports unknown top-level manifest fields without making them fatal", () => {
    const result = validateCompiledPlugin({ ...validManifest(), unexpected: true });

    expect(result).toEqual({
      ok: true,
      errors: [],
      warnings: ["plugin.json unknown top-level field: unexpected"]
    });
  });

  it("reports a non-object extensions field without making the manifest fatal", () => {
    const result = validateCompiledPlugin({ ...validManifest(), extensions: "ignored" });

    expect(result).toEqual({
      ok: true,
      errors: [],
      warnings: ["plugin.json extensions must be an object and will be ignored"]
    });
  });

  it("accepts all three official MCP server variants", () => {
    const result = validateCompiledPlugin(validManifest(), {
      $schema: MCP_SCHEMA,
      mcpServers: {
        local: {
          type: "stdio",
          command: "node",
          args: ["./server.js"],
          env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
          cwd: "${PLUGIN_ROOT}"
        },
        remote: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: { "X-Tenant": "public" }
        },
        legacy: { type: "sse", url: "https://example.com/sse" }
      }
    });

    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("enforces the closed MCP schema and server variant field types", () => {
    const result = validateCompiledPlugin(validManifest(), {
      $schema: MCP_SCHEMA,
      unexpected: true,
      mcpServers: {
        bad: {
          type: "stdio",
          command: "node",
          url: "https://example.com/mcp",
          args: ["ok", 42],
          env: { PORT: 3000 }
        }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("mcp.json unknown field: unexpected"))).toBe(true);
    expect(result.errors.some((error) => error.includes("mcp.json/mcpServers/bad"))).toBe(true);
  });

  it("rejects reserved Agent Plugins environment variables and invalid cwd forms", () => {
    const result = validateCompiledPlugin(validManifest(), mcpWith({
      type: "stdio",
      command: "node",
      env: { PLUGIN_ROOT: "/tmp/plugin" },
      cwd: "relative-without-dot-slash"
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("mcp.json/mcpServers/example"))).toBe(true);
  });

  it("rejects stdio commands that are neither bare nor safely plugin-relative", () => {
    const absolute = validateCompiledPlugin(validManifest(), mcpWith({ type: "stdio", command: "C:\\tools\\server.exe" }));
    const escaping = validateCompiledPlugin(validManifest(), mcpWith({ type: "stdio", command: "./../server" }));
    const windowsEscaping = validateCompiledPlugin(validManifest(), mcpWith({ type: "stdio", command: "./..\\server" }));

    expect(absolute.errors).toContain("MCP stdio server example command must be a bare executable name or plugin-relative path beginning with ./");
    expect(escaping.errors).toContain("MCP stdio server example command must be a bare executable name or plugin-relative path beginning with ./");
    expect(windowsEscaping.errors).toContain("MCP stdio server example command must be a bare executable name or plugin-relative path beginning with ./");
  });

  it("rejects lexical cwd escapes from plugin and plugin-data roots", () => {
    for (const cwd of ["./../escape", "${PLUGIN_ROOT}/../escape", "${PLUGIN_DATA}/../escape", "./..\\escape"]) {
      const result = validateCompiledPlugin(validManifest(), mcpWith({ type: "stdio", command: "node", cwd }));
      expect(result.errors).toContain("MCP stdio server example cwd must remain within its declared plugin or plugin-data root");
    }
  });
  it("enforces the normative remote MCP URL rules", () => {
    expect(validateCompiledPlugin(validManifest(), mcpWith({ type: "streamable-http", url: "http://127.0.0.1:3000/mcp" })).ok).toBe(true);
    expect(validateCompiledPlugin(validManifest(), mcpWith({ type: "streamable-http", url: "http://localhost:3000/mcp" })).ok).toBe(true);

    const insecure = validateCompiledPlugin(validManifest(), mcpWith({ type: "streamable-http", url: "http://example.com/mcp" }));
    const credentials = validateCompiledPlugin(validManifest(), mcpWith({ type: "streamable-http", url: "https://user:pass@example.com/mcp" }));
    const fragment = validateCompiledPlugin(validManifest(), mcpWith({ type: "streamable-http", url: "https://example.com/mcp#fragment" }));

    expect(insecure.errors).toContain("MCP remote server example must use HTTPS unless the endpoint is loopback");
    expect(credentials.errors).toContain("MCP remote server example url must not contain user information");
    expect(fragment.errors).toContain("MCP remote server example url must not contain a fragment");
  });

  it("validates HTTP header syntax and rejects case-insensitive duplicates", () => {
    const result = validateCompiledPlugin(validManifest(), mcpWith({
      type: "streamable-http",
      url: "https://example.com/mcp",
      headers: {
        "X-Test": "one",
        "x-test": "two",
        "Bad Header": "value",
        "X-Control": "bad\r\nvalue"
      }
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("duplicate header name"))).toBe(true);
    expect(result.errors.some((error) => error.includes("invalid HTTP header name"))).toBe(true);
    expect(result.errors.some((error) => error.includes("invalid HTTP header value"))).toBe(true);
  });

  it("rejects untrusted object graphs that exceed validation safety limits", () => {
    const extensions: Record<string, unknown> = {};
    let cursor = extensions;
    for (let index = 0; index < 70; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    const result = validateCompiledPlugin({ ...validManifest(), extensions: { "com.example.client": extensions } });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("plugin.json exceeds the validation depth limit");
  });
});
