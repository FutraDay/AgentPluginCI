import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { ingestOpenApiDocument, ingestOpenApiSource, loadOpenApiSource, parseOpenApiText } from "./index.js";

const supportFixture = fileURLToPath(new URL("../../../fixtures/openapi/support.yaml", import.meta.url));
const searchFixture = fileURLToPath(new URL("../../../fixtures/openapi/search.json", import.meta.url));

function minimalDocument(version = "3.1.2") {
  return {
    openapi: version,
    info: { title: "Example API", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          responses: { "200": { description: "ok" } }
        }
      }
    }
  };
}

describe("OpenAPI source loading", () => {
  it("loads JSON files explicitly", async () => {
    const loaded = await loadOpenApiSource(searchFixture);
    expect(loaded.sourceType).toBe("file");
    expect((loaded.document as Record<string, unknown>).openapi).toBe("3.2.0");
  });

  it("loads YAML files explicitly", async () => {
    const loaded = await loadOpenApiSource(supportFixture);
    expect(loaded.sourceType).toBe("file");
    expect((loaded.document as Record<string, unknown>).openapi).toBe("3.1.2");
  });

  it("rejects unsafe parsed object keys", () => {
    expect(() => parseOpenApiText('{"__proto__":{"polluted":true}}')).toThrow(/unsafe key/i);
  });

  it("enforces the configured document byte limit", async () => {
    await expect(loadOpenApiSource(supportFixture, { maxDocumentBytes: 20 })).rejects.toThrow(/exceeds 20 bytes/i);
  });
});

describe("OpenAPI normalization", () => {
  it("normalizes internal refs, parameters, request bodies, identity, and skills", async () => {
    const { ir, warnings } = await ingestOpenApiSource(supportFixture);
    expect(warnings).toEqual([]);
    expect(ir.identity).toMatchObject({
      name: "support-api",
      version: "1.2.3",
      authorName: "Support Platform",
      license: "MIT"
    });
    expect(ir.capabilities).toHaveLength(2);

    const getTicket = ir.capabilities?.find((capability) => capability.name === "getTicket");
    expect(getTicket?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "X-Trace-Id", in: "header", required: false, schema: { type: "string" } }
    ]);

    const createTicket = ir.capabilities?.find((capability) => capability.name === "createTicket");
    expect(createTicket?.requestBody).toMatchObject({
      required: true,
      content: [{ mediaType: "application/json", schema: { type: "object" } }]
    });
    expect(ir.skills.map((skill) => skill.name)).toEqual(["getticket", "createticket"]);
  });

  it("supports OpenAPI 3.2 QUERY and querystring parameters", async () => {
    const { ir } = await ingestOpenApiSource(searchFixture);
    const query = ir.capabilities?.find((capability) => capability.name === "queryItems");
    expect(query?.source).toMatchObject({ type: "openapi", method: "QUERY", path: "/items" });
    expect(query?.parameters).toEqual([
      { name: "selector", in: "querystring", required: false, schema: { type: "object" } }
    ]);
  });

  it("preserves additionalOperations HTTP method capitalization", async () => {
    const document = minimalDocument("3.2.0");
    (document.paths["/items"] as Record<string, unknown>).additionalOperations = {
      PuRgE: {
        operationId: "purgeItems",
        responses: { "204": { description: "done" } }
      }
    };
    const { ir } = await ingestOpenApiDocument(document);
    const custom = ir.capabilities?.find((capability) => capability.name === "purgeItems");
    expect(custom?.id).toBe("openapi:PuRgE:/items");
    expect(custom?.source).toMatchObject({ type: "openapi", method: "PuRgE", path: "/items" });
  });

  it("rejects querystring parameters before OpenAPI 3.2", async () => {
    const document = minimalDocument("3.1.2");
    (document.paths["/items"] as any).get.parameters = [{
      name: "all",
      in: "querystring",
      content: { "text/plain": { schema: { type: "string" } } }
    }];
    await expect(ingestOpenApiDocument(document)).rejects.toThrow(/require OpenAPI 3\.2/i);
  });

  it("rejects mixing query and querystring parameters", async () => {
    const document = minimalDocument("3.2.0");
    (document.paths["/items"] as any).get.parameters = [
      { name: "q", in: "query", schema: { type: "string" } },
      { name: "all", in: "querystring", content: { "text/plain": { schema: { type: "string" } } } }
    ];
    await expect(ingestOpenApiDocument(document)).rejects.toThrow(/cannot mix query and querystring/i);
  });

  it("requires querystring parameters to use content", async () => {
    const document = minimalDocument("3.2.0");
    (document.paths["/items"] as any).get.parameters = [
      { name: "all", in: "querystring", schema: { type: "string" } }
    ];
    await expect(ingestOpenApiDocument(document)).rejects.toThrow(/must use content, not schema/i);
  });

  it("rejects parameter content with multiple media types", async () => {
    const document = minimalDocument("3.2.0");
    (document.paths["/items"] as any).get.parameters = [{
      name: "all",
      in: "querystring",
      content: {
        "application/json": { schema: { type: "object" } },
        "text/plain": { schema: { type: "string" } }
      }
    }];
    await expect(ingestOpenApiDocument(document)).rejects.toThrow(/exactly one media type/i);
  });
});

describe("OpenAPI external refs and trust boundaries", () => {
  it("resolves external file refs inside the root directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-plugin-ci-openapi-"));
    try {
      await writeFile(join(dir, "components.yaml"), [
        "parameters:",
        "  Limit:",
        "    name: limit",
        "    in: query",
        "    schema:",
        "      type: integer"
      ].join("\n"));
      await writeFile(join(dir, "root.yaml"), [
        "openapi: 3.1.2",
        "info:",
        "  title: External Ref API",
        "  version: 1.0.0",
        "paths:",
        "  /items:",
        "    get:",
        "      operationId: listItems",
        "      parameters:",
        "        - $ref: './components.yaml#/parameters/Limit'",
        "      responses:",
        "        '200':",
        "          description: ok"
      ].join("\n"));

      const { ir } = await ingestOpenApiSource(join(dir, "root.yaml"));
      expect(ir.capabilities?.[0]?.parameters).toEqual([
        { name: "limit", in: "query", required: false, schema: { type: "integer" } }
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("denies external file refs outside the root directory by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-plugin-ci-openapi-"));
    const rootDir = join(dir, "root");
    try {
      await mkdir(rootDir);
      await writeFile(join(dir, "outside.yaml"), [
        "parameters:",
        "  Limit:",
        "    name: limit",
        "    in: query",
        "    schema:",
        "      type: integer"
      ].join("\n"));
      await writeFile(join(rootDir, "root.yaml"), [
        "openapi: 3.1.2",
        "info:",
        "  title: Boundary API",
        "  version: 1.0.0",
        "paths:",
        "  /items:",
        "    get:",
        "      operationId: listItems",
        "      parameters:",
        "        - $ref: '../outside.yaml#/parameters/Limit'",
        "      responses:",
        "        '200':",
        "          description: ok"
      ].join("\n"));

      await expect(ingestOpenApiSource(join(rootDir, "root.yaml"))).rejects.toThrow(/outside root directory/i);
      const { ir } = await ingestOpenApiSource(join(rootDir, "root.yaml"), { allowExternalFileRefsOutsideRoot: true });
      expect(ir.capabilities?.[0]?.parameters?.[0]?.name).toBe("limit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("denies refs that escape the root through a symlink or junction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-plugin-ci-openapi-"));
    const rootDir = join(dir, "root");
    const outsideDir = join(dir, "outside");
    try {
      await mkdir(rootDir);
      await mkdir(outsideDir);
      await writeFile(join(outsideDir, "components.yaml"), [
        "parameters:", "  Limit:", "    name: limit", "    in: query", "    schema:", "      type: integer"
      ].join("\n"));
      await symlink(outsideDir, join(rootDir, "linked"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(join(rootDir, "root.yaml"), [
        "openapi: 3.1.2", "info:", "  title: Symlink Boundary API", "  version: 1.0.0",
        "paths:", "  /items:", "    get:", "      parameters:",
        "        - $ref: './linked/components.yaml#/parameters/Limit'",
        "      responses:", "        '200':", "          description: ok"
      ].join("\n"));
      await expect(ingestOpenApiSource(join(rootDir, "root.yaml"))).rejects.toThrow(/outside root directory/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces the configured ref depth limit", async () => {
    const document = {
      openapi: "3.1.2",
      info: { title: "Ref Depth API", version: "1.0.0" },
      components: {
        parameters: {
          A: { $ref: "#/components/parameters/B" },
          B: { name: "limit", in: "query", schema: { type: "integer" } }
        }
      },
      paths: {
        "/items": {
          get: {
            parameters: [{ $ref: "#/components/parameters/A" }],
            responses: { "200": { description: "ok" } }
          }
        }
      }
    };
    await expect(ingestOpenApiDocument(document, { maxRefDepth: 1 })).rejects.toThrow(/maximum depth 1/i);
  });
});

describe("remote OpenAPI loading", () => {
  it("loads a local HTTP spec only with explicit insecure/private-network opt-ins", async () => {
    const document = JSON.stringify(minimalDocument());
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      if (request.url !== "/openapi.json") {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(document);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP test server did not expose a TCP address");
      const url = `http://127.0.0.1:${address.port}/openapi.json`;

      await expect(ingestOpenApiSource(url)).rejects.toThrow(/insecure HTTP/i);
      expect(requests).toBe(0);

      await expect(ingestOpenApiSource(url, { allowInsecureHttp: true })).rejects.toThrow(/private-network/i);
      expect(requests).toBe(0);

      const { ir } = await ingestOpenApiSource(url, {
        allowInsecureHttp: true,
        allowPrivateNetwork: true
      });
      expect(ir.identity.name).toBe("example-api");
      expect(ir.capabilities).toHaveLength(1);
      expect(requests).toBe(1);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
