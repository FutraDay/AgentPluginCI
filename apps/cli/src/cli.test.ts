import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (m: string) => stdout.push(m), stderr: (m: string) => stderr.push(m) } };
}

describe("Agent Plugin CI CLI", () => {
  it("builds and validates an OpenAPI package with JSON output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-openapi-"));
    const out = join(cwd, "out");
    const cap = capture();
    const code = await runCli(["build", "--openapi", join(repoRoot, "fixtures/openapi/support.yaml"), "--out", out, "--json"], { cwd, ...cap.io });
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout[0]!).ok).toBe(true);
    expect(JSON.parse(await readFile(join(out, "plugin.json"), "utf8")).name).toBeTruthy();
    const validation = capture();
    expect(await runCli(["validate", out, "--json"], { cwd, ...validation.io })).toBe(0);
    expect(JSON.parse(validation.stdout[0]!).ok).toBe(true);
  });

  it("builds MCP configuration without executing stdio discovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-mcp-"));
    const out = join(cwd, "out");
    const cap = capture();
    const code = await runCli([
      "build", "--mcp", join(repoRoot, "fixtures/mcp/stdio.json"),
      "--no-discover", "--out", out
    ], { cwd, ...cap.io });
    expect(code).toBe(0);
    expect(cap.stdout.some((line) => line.startsWith("BUILD_OK"))).toBe(true);
    expect(JSON.parse(await readFile(join(out, "mcp.json"), "utf8")).mcpServers.fixture.type).toBe("stdio");
  });

  it("uses exit code 2 for invalid CLI usage", async () => {
    const cap = capture();
    const code = await runCli(["build", "--openapi", "x.yaml", "--no-discover", "--json"], cap.io);
    expect(code).toBe(2);
    const result = JSON.parse(cap.stdout[0]!);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("USAGE_ERROR");
  });

  it("refuses to replace non-empty output without --force", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-force-"));
    const out = join(cwd, "out");
    const source = join(repoRoot, "fixtures/openapi/search.json");
    expect(await runCli(["build", "--openapi", source, "--out", out], { cwd, ...capture().io })).toBe(0);
    const cap = capture();
    expect(await runCli(["build", "--openapi", source, "--out", out, "--json"], { cwd, ...cap.io })).toBe(1);
    expect(JSON.parse(cap.stdout[0]!).error.code).toBe("OUTPUT_EXISTS");
    expect(await runCli(["build", "--openapi", source, "--out", out, "--force"], { cwd, ...capture().io })).toBe(0);
  });

  it("refuses force output at the invocation directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-root-"));
    const cap = capture();
    const code = await runCli(["build", "--openapi", join(repoRoot, "fixtures/openapi/search.json"), "--out", ".", "--force", "--json"], { cwd, ...cap.io });
    expect(code).toBe(1);
    expect(JSON.parse(cap.stdout[0]!).error.code).toBe("OUTPUT_UNSAFE");
    expect((await stat(cwd)).isDirectory()).toBe(true);
  });

  it("refuses to force-replace a non-generated directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-owned-"));
    const out = join(cwd, "out");
    await mkdir(out);
    await writeFile(join(out, "keep.txt"), "do not delete", "utf8");
    const cap = capture();
    const code = await runCli(["build", "--openapi", join(repoRoot, "fixtures/openapi/search.json"), "--out", out, "--force", "--json"], { cwd, ...cap.io });
    expect(code).toBe(1);
    expect(JSON.parse(cap.stdout[0]!).error.code).toBe("OUTPUT_UNSAFE");
    expect(await readFile(join(out, "keep.txt"), "utf8")).toBe("do not delete");
  });

  it("blocks PluginIR skill path traversal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-skill-path-"));
    const input = join(cwd, "malicious.json");
    const ir = { identity: { name: "safe-plugin" }, skills: [{ name: "../escape", description: "bad", instructions: "bad" }], mcpServers: [] };
    await writeFile(input, JSON.stringify(ir), "utf8");
    const cap = capture();
    const code = await runCli(["build", "--ir", input, "--out", join(cwd, "out"), "--json"], { cwd, ...cap.io });
    expect(code).toBe(1);
    expect(JSON.parse(cap.stdout[0]!).error.code).toBe("OUTPUT_UNSAFE");
    expect(await stat(join(cwd, "escape")).catch(() => undefined)).toBeUndefined();
  });

});
