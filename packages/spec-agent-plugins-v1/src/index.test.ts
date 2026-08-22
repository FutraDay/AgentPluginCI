import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_V1_SCHEMA_SOURCE,
  MCP_FIELDS,
  MCP_JSON_SCHEMA,
  MCP_SCHEMA,
  PLUGIN_FIELDS,
  PLUGIN_JSON_SCHEMA,
  PLUGIN_NAME_RE,
  PLUGIN_SCHEMA
} from "./index.js";

async function sha256(url: URL): Promise<string> {
  const bytes = await readFile(url);
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Agent Plugins 1.0 schema snapshot", () => {
  it("exports canonical draft 2020-12 schemas and derives compatibility constants from them", () => {
    expect(PLUGIN_JSON_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(MCP_JSON_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(PLUGIN_SCHEMA).toBe(PLUGIN_JSON_SCHEMA.$id);
    expect(MCP_SCHEMA).toBe(MCP_JSON_SCHEMA.$id);
    expect([...PLUGIN_FIELDS]).toEqual(Object.keys(PLUGIN_JSON_SCHEMA.properties));
    expect([...MCP_FIELDS]).toEqual(Object.keys(MCP_JSON_SCHEMA.properties));
    expect(PLUGIN_NAME_RE.test("valid-plugin")).toBe(true);
    expect(PLUGIN_NAME_RE.test("Invalid--Plugin")).toBe(false);
  });

  it("matches the pinned authoritative schema byte hashes", async () => {
    expect(await sha256(new URL("./schemas/1.0.0/plugin.schema.json", import.meta.url)))
      .toBe(AGENT_PLUGINS_V1_SCHEMA_SOURCE.pluginSha256);
    expect(await sha256(new URL("./schemas/1.0.0/mcp.schema.json", import.meta.url)))
      .toBe(AGENT_PLUGINS_V1_SCHEMA_SOURCE.mcpSha256);
  });
});
