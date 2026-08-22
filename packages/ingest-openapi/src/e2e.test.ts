import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compilePlugin } from "@agent-plugin-ci/compiler";
import { validateCompiledPlugin } from "@agent-plugin-ci/validator";
import { ingestOpenApiSource } from "./index.js";

const supportFixture = fileURLToPath(new URL("../../../fixtures/openapi/support.yaml", import.meta.url));

describe("OpenAPI ingestion end to end", () => {
  it("flows OpenAPI through PluginIR, compiler, and validator", async () => {
    const { ir, warnings } = await ingestOpenApiSource(supportFixture, { pluginName: "support-openapi" });
    const compiled = compilePlugin(ir);
    const validation = validateCompiledPlugin(compiled.manifest, compiled.mcp);

    expect(warnings).toEqual([]);
    expect(ir.capabilities).toHaveLength(2);
    expect(compiled.manifest.name).toBe("support-openapi");
    expect(Object.keys(compiled.skills)).toEqual(["getticket", "createticket"]);
    expect(compiled.skills.getticket).toContain('GET "/tickets/{id}"');
    expect(compiled.skills.createticket).toContain('"application/json"');
    expect(compiled.mcp).toBeUndefined();
    expect(validation).toEqual({ ok: true, errors: [], warnings: [] });
  });
});
