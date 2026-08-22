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
    const buildResult = JSON.parse(cap.stdout[0]!);
    expect(buildResult.ok).toBe(true);
    expect(buildResult.security.mode).toBe("report-only");
    expect(buildResult.security.complete).toBe(true);
    expect(buildResult.security.summary.total).toBe(0);
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

  it("refuses to force-replace generated output after unrelated content is added", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-force-extra-"));
    const out = join(cwd, "out");
    const source = join(repoRoot, "fixtures/openapi/search.json");
    expect(await runCli(["build", "--openapi", source, "--out", out], { cwd, ...capture().io })).toBe(0);
    await writeFile(join(out, "keep.txt"), "important", "utf8");

    const cap = capture();
    const code = await runCli(["build", "--openapi", source, "--out", out, "--force", "--json"], { cwd, ...cap.io });
    expect(code).toBe(1);
    expect(JSON.parse(cap.stdout[0]!).error.code).toBe("OUTPUT_UNSAFE");
    expect(await readFile(join(out, "keep.txt"), "utf8")).toBe("important");
  });

  it("refuses to force-replace generated output when a skill directory contains extra files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-force-skill-extra-"));
    const out = join(cwd, "out");
    const source = join(repoRoot, "fixtures/openapi/search.json");
    expect(await runCli(["build", "--openapi", source, "--out", out], { cwd, ...capture().io })).toBe(0);
    const extra = join(out, "skills", "queryitems", "notes.txt");
    await writeFile(extra, "important", "utf8");

    const cap = capture();
    const code = await runCli(["build", "--openapi", source, "--out", out, "--force", "--json"], { cwd, ...cap.io });
    expect(code).toBe(1);
    expect(JSON.parse(cap.stdout[0]!).error.code).toBe("OUTPUT_UNSAFE");
    expect(await readFile(extra, "utf8")).toBe("important");
  });

  it("blocks case-insensitive PluginIR skill directory collisions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-skill-case-"));
    const input = join(cwd, "collision.json");
    const ir = {
      identity: { name: "safe-plugin" },
      skills: [
        { name: "Alpha", description: "first", instructions: "first" },
        { name: "alpha", description: "second", instructions: "second" }
      ],
      mcpServers: []
    };
    await writeFile(input, JSON.stringify(ir), "utf8");
    const cap = capture();
    const out = join(cwd, "out");
    const code = await runCli(["build", "--ir", input, "--out", out, "--json"], { cwd, ...cap.io });
    expect(code).toBe(1);
    expect(JSON.parse(cap.stdout[0]!).error.code).toBe("OUTPUT_UNSAFE");
    expect(await stat(out).catch(() => undefined)).toBeUndefined();
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

  it("reports build-time security findings without changing build success policy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-security-build-"));
    const input = join(cwd, "security-ir.json");
    const secret = "literal-build-secret";
    const ir = {
      identity: { name: "security-build" },
      skills: [],
      mcpServers: [{ name: "local", transport: "stdio", command: "node", env: { API_KEY: secret } }]
    };
    await writeFile(input, JSON.stringify(ir), "utf8");
    const cap = capture();
    const code = await runCli(["build", "--ir", input, "--out", join(cwd, "out"), "--json"], { cwd, ...cap.io });
    expect(code).toBe(0);
    const result = JSON.parse(cap.stdout[0]!);
    expect(result.security.mode).toBe("report-only");
    expect(result.security.findings.some((finding: { id: string }) => finding.id === "APCI-SEC-001")).toBe(true);
    expect(cap.stdout[0]).not.toContain(secret);
  });

  it("fails the scan command on high-severity findings by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-security-cli-"));
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({ name: "unsafe" }), "utf8");
    await writeFile(join(cwd, "mcp.json"), JSON.stringify({
      mcpServers: { remote: { type: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer fixed-secret" } } }
    }), "utf8");
    const cap = capture();
    const code = await runCli(["scan", cwd, "--json"], { cwd, ...cap.io });
    expect(code).toBe(1);
    const result = JSON.parse(cap.stdout[0]!);
    expect(result.ok).toBe(false);
    expect(result.policy.failOn).toBe("high");
    expect(result.findings.some((finding: { id: string }) => finding.id === "APCI-SEC-008")).toBe(true);
    expect(cap.stdout[0]).not.toContain("fixed-secret");
  });

  it("supports report-only and custom severity policies for security scans", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-security-policy-"));
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({ name: "private" }), "utf8");
    await writeFile(join(cwd, "mcp.json"), JSON.stringify({
      mcpServers: { local: { type: "streamable-http", url: "https://127.0.0.1/mcp" } }
    }), "utf8");

    const critical = capture();
    expect(await runCli(["scan", cwd, "--fail-on", "critical", "--json"], { cwd, ...critical.io })).toBe(0);
    expect(JSON.parse(critical.stdout[0]!).summary.medium).toBeGreaterThan(0);

    const medium = capture();
    expect(await runCli(["scan", cwd, "--fail-on", "medium", "--json"], { cwd, ...medium.io })).toBe(1);

    const reportOnly = capture();
    expect(await runCli(["scan", cwd, "--fail-on", "none", "--json"], { cwd, ...reportOnly.io })).toBe(0);
  });

  it("fails closed on incomplete scans even above the finding severity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-security-incomplete-"));
    await writeFile(join(cwd, "plugin.json"), "{not-json", "utf8");
    const cap = capture();
    const code = await runCli(["scan", cwd, "--fail-on", "critical", "--json"], { cwd, ...cap.io });
    expect(code).toBe(1);
    const result = JSON.parse(cap.stdout[0]!);
    expect(result.complete).toBe(false);
    expect(result.blockingFindings).toBe(0);
    expect(result.incompleteScanBlocked).toBe(true);
  });

  it("escapes control characters in human-readable security findings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-security-console-"));
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({ name: "unsafe" }), "utf8");
    await writeFile(join(cwd, "mcp.json"), JSON.stringify({
      mcpServers: { local: { type: "stdio", command: "node", env: { "API_KEY\nINJECTED": "literal-value" } } }
    }), "utf8");
    const cap = capture();
    const code = await runCli(["scan", cwd], { cwd, ...cap.io });
    expect(code).toBe(1);
    expect(cap.stderr.some((message) => message.includes("\\u000a"))).toBe(true);
    expect(cap.stderr.every((message) => !message.includes("\n"))).toBe(true);
  });

  it("rejects invalid security scan severity usage", async () => {
    const cap = capture();
    const code = await runCli(["scan", ".", "--fail-on", "severe", "--json"], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout[0]!).error.code).toBe("USAGE_ERROR");
  });

});
