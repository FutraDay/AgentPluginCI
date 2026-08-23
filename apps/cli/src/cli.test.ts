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
    expect(buildResult.compatibility.mode).toBe("report-only");
    expect(buildResult.compatibility.staticEligibility).toBe("eligible");
    expect(buildResult.compatibility.runtimeEvidence.clientInstall).toBe("not-assessed");
    expect(buildResult.compatibility.runtimeEvidence.runtimeVerified).toBe(false);
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

  it("reports text and deterministic JSON static compatibility evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-compat-cli-"));
    const out = join(cwd, "out");
    expect(await runCli(["build", "--ir", join(repoRoot, "fixtures/hello/plugin-ir.json"), "--out", out], { cwd, ...capture().io })).toBe(0);

    const textResult = capture();
    expect(await runCli(["compat", out], { cwd, ...textResult.io })).toBe(0);
    expect(textResult.stdout).toContain(`PROFILE agent-plugins-1.0-portable-core@1.0.0 status=warn static-eligibility=eligible`);
    expect(textResult.stdout).toContain("RUNTIME_EVIDENCE verified=false client-install=not-assessed mcp-handshake=not-assessed");

    const first = capture();
    const second = capture();
    expect(await runCli(["compat", join(out, "plugin.json"), "--json"], { cwd, ...first.io })).toBe(0);
    expect(await runCli(["compat", join(out, "plugin.json"), "--json"], { cwd, ...second.io })).toBe(0);
    expect(first.stdout[0]).toBe(second.stdout[0]);
    const payload = JSON.parse(first.stdout[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.evidenceLevel).toBe("static-inspection");
    expect(payload.runtimeEvidence.runtimeVerified).toBe(false);
    expect(payload.runtimeEvidence.mcpHandshake).toBe("not-assessed");
  });

  it("selects one compatibility profile or all built-in profiles", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-compat-profiles-"));
    const out = join(cwd, "out");
    expect(await runCli(["build", "--openapi", join(repoRoot, "fixtures/openapi/search.json"), "--out", out], { cwd, ...capture().io })).toBe(0);

    const selected = capture();
    expect(await runCli(["compat", out, "--profile", "cursor-agent-plugins-1.0", "--json"], { cwd, ...selected.io })).toBe(0);
    expect(JSON.parse(selected.stdout[0]!).profiles.map((profile: { profile: { id: string } }) => profile.profile.id)).toEqual(["cursor-agent-plugins-1.0"]);

    const all = capture();
    expect(await runCli(["compat", out, "--all", "--json"], { cwd, ...all.io })).toBe(0);
    expect(JSON.parse(all.stdout[0]!).profiles.map((profile: { profile: { id: string } }) => profile.profile.id)).toEqual([
      "agent-plugins-1.0-portable-core",
      "cursor-agent-plugins-1.0",
      "vscode-github-copilot-agent-plugins-1.0"
    ]);
  });

  it("uses exit code 2 for invalid compatibility invocation and unknown profiles", async () => {
    const unknown = capture();
    expect(await runCli(["compat", ".", "--profile", "unknown", "--json"], unknown.io)).toBe(2);
    expect(JSON.parse(unknown.stdout[0]!).error.code).toBe("USAGE_ERROR");

    const conflicting = capture();
    expect(await runCli(["compat", ".", "--all", "--profile", "cursor-agent-plugins-1.0", "--json"], conflicting.io)).toBe(2);
    expect(JSON.parse(conflicting.stdout[0]!).exitCode).toBe(2);

    const missingProfile = capture();
    expect(await runCli(["compat", ".", "--profile", "--json"], missingProfile.io)).toBe(2);
    expect(JSON.parse(missingProfile.stdout[0]!).error.code).toBe("USAGE_ERROR");
  });

  it("uses exit code 1 for an invalid compatibility package", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-compat-invalid-"));
    await writeFile(join(cwd, "plugin.json"), "{invalid", "utf8");
    const cap = capture();
    expect(await runCli(["compat", cwd, "--json"], { cwd, ...cap.io })).toBe(1);
    const payload = JSON.parse(cap.stdout[0]!);
    expect(payload.ok).toBe(false);
    expect(payload.staticEligibility).toBe("ineligible");
    expect(cap.stdout[0]).not.toContain("Unexpected token");
  });

  it("uses exit code 1 for incomplete compatibility inspection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-compat-incomplete-"));
    await writeFile(join(cwd, "plugin.json"), "x".repeat(1_000_001), "utf8");
    const cap = capture();
    expect(await runCli(["compat", cwd, "--json"], { cwd, ...cap.io })).toBe(1);
    expect(JSON.parse(cap.stdout[0]!)).toMatchObject({
      ok: false,
      complete: false,
      status: "unknown",
      staticEligibility: "unknown"
    });
  });

  it("escapes control characters in compatibility input errors", async () => {
    const cap = capture();
    expect(await runCli(["compat", "missing\nINJECTED"], cap.io)).toBe(1);
    expect(cap.stderr.some((message) => message.includes("\\u000aINJECTED"))).toBe(true);
    expect(cap.stderr.every((message) => !message.includes("\n"))).toBe(true);
  });

  it("runs MCP, OpenAPI, and PluginIR through validation, security, compatibility, and certification", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-compat-e2e-"));
    const builds = [
      ["build", "--mcp", join(repoRoot, "fixtures/mcp/stdio.json"), "--no-discover", "--name", "e2e-mcp"],
      ["build", "--openapi", join(repoRoot, "fixtures/openapi/support.yaml"), "--name", "e2e-openapi"],
      ["build", "--ir", join(repoRoot, "fixtures/hello/plugin-ir.json")]
    ];
    for (const [index, buildArgs] of builds.entries()) {
      const out = join(cwd, `out-${index}`);
      expect(await runCli([...buildArgs, "--out", out], { cwd, ...capture().io })).toBe(0);
      expect(await runCli(["validate", out], { cwd, ...capture().io })).toBe(0);
      expect(await runCli(["scan", out], { cwd, ...capture().io })).toBe(0);
      expect(await runCli(["compat", out, "--all"], { cwd, ...capture().io })).toBe(0);
      const certification = capture();
      expect(await runCli(["certify", out, "--json"], { cwd, ...certification.io })).toBe(0);
      expect(JSON.parse(certification.stdout[0]!)).toMatchObject({
        ok: true,
        command: "certify",
        status: "certified",
        runtimeEvidence: { runtimeVerified: false, clientInstall: "not-assessed", mcpHandshake: "not-assessed" }
      });
    }
  });

  it("certifies package directories and plugin.json deterministically with pinned profiles", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-certify-"));
    const out = join(cwd, "out");
    expect(await runCli(["build", "--ir", join(repoRoot, "fixtures/hello/plugin-ir.json"), "--out", out], { cwd, ...capture().io })).toBe(0);
    const first = capture();
    const second = capture();
    expect(await runCli(["certify", out, "--json"], { cwd, ...first.io })).toBe(0);
    expect(await runCli(["certify", join(out, "plugin.json"), "--json"], { cwd, ...second.io })).toBe(0);
    expect(first.stdout[0]).toBe(second.stdout[0]);
    expect(JSON.parse(first.stdout[0]!).policy.compatibility.requiredProfiles).toEqual([
      { id: "agent-plugins-1.0-portable-core", version: "1.0.0" },
      { id: "cursor-agent-plugins-1.0", version: "1.0.0" },
      { id: "vscode-github-copilot-agent-plugins-1.0", version: "1.0.0" }
    ]);
  });

  it("returns non-certified for validation errors and high security findings", async () => {
    const invalid = await mkdtemp(join(tmpdir(), "agentplugin-cert-invalid-"));
    await writeFile(join(invalid, "plugin.json"), JSON.stringify({ name: "missing-schema" }), "utf8");
    const invalidCap = capture();
    expect(await runCli(["certify", invalid, "--json"], { cwd: invalid, ...invalidCap.io })).toBe(1);
    expect(JSON.parse(invalidCap.stdout[0]!)).toMatchObject({ status: "not-certified" });

    const unsafe = await mkdtemp(join(tmpdir(), "agentplugin-cert-high-"));
    await writeFile(join(unsafe, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "unsafe" }), "utf8");
    await writeFile(join(unsafe, ".env"), "TOKEN=not-a-real-secret", "utf8");
    const unsafeCap = capture();
    expect(await runCli(["certify", unsafe, "--json"], { cwd: unsafe, ...unsafeCap.io })).toBe(1);
    expect(JSON.parse(unsafeCap.stdout[0]!)).toMatchObject({ status: "not-certified" });
  });

  it("keeps medium findings non-blocking and gives definite high limit findings precedence over incompleteness", async () => {
    const medium = await mkdtemp(join(tmpdir(), "agentplugin-cert-medium-"));
    await writeFile(join(medium, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "medium" }), "utf8");
    await writeFile(join(medium, "tool.sh"), "echo safe", "utf8");
    expect(await runCli(["certify", medium, "--json"], { cwd: medium, ...capture().io })).toBe(0);

    const incomplete = await mkdtemp(join(tmpdir(), "agentplugin-cert-incomplete-"));
    await writeFile(join(incomplete, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "incomplete" }), "utf8");
    await writeFile(join(incomplete, "large.txt"), "x".repeat(5_000_001), "utf8");
    const cap = capture();
    expect(await runCli(["certify", incomplete, "--json"], { cwd: incomplete, ...cap.io })).toBe(1);
    expect(JSON.parse(cap.stdout[0]!)).toMatchObject({ status: "not-certified" });
  });

  it("uses exit code 2 for invalid certify usage", async () => {
    const extra = capture();
    expect(await runCli(["certify", ".", "extra", "--json"], extra.io)).toBe(2);
    expect(JSON.parse(extra.stdout[0]!).error.code).toBe("USAGE_ERROR");
    const option = capture();
    expect(await runCli(["certify", "--profile", "x", "--json"], option.io)).toBe(2);
    expect(JSON.parse(option.stdout[0]!).exitCode).toBe(2);
  });

  it("escapes control characters in human-readable certification evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-cert-console-"));
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "console-safe"
    }), "utf8");
    await writeFile(join(cwd, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { "bad\nINJECTED": { type: "stdio", command: "node", env: { API_KEY: "literal-secret" } } }
    }), "utf8");
    const cap = capture();
    expect(await runCli(["certify", cwd], { cwd, ...cap.io })).toBe(1);
    expect(cap.stderr.some((message) => message.includes("\\u000aINJECTED"))).toBe(true);
    expect(cap.stderr.every((message) => !message.includes("\n"))).toBe(true);
    expect(cap.stderr.join(" ")).not.toContain("literal-secret");
  });

  it("does not expose raw parser exceptions or invalid package content during certification", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-cert-parser-"));
    const secret = "literal-sensitive-parser-content";
    await writeFile(join(cwd, "plugin.json"), `{\"token\":\"${secret}\",`, "utf8");
    const cap = capture();
    expect(await runCli(["certify", cwd, "--json"], { cwd, ...cap.io })).toBe(1);
    expect(cap.stdout[0]).not.toContain(secret);
    expect(cap.stdout[0]).not.toContain("Unexpected token");
  });

  it("runs explicit MCP runtime compatibility with stdio opt-in", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-runtime-cli-"));
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "runtime-cli"
    }), "utf8");
    await writeFile(join(cwd, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { fixture: { type: "stdio", command: "node", args: [join(repoRoot, "packages/ingest-mcp/test-fixtures/stdio-server.mjs")] } }
    }), "utf8");

    const jsonCap = capture();
    expect(await runCli(["compat-runtime", cwd, "--allow-stdio-runtime", "--timeout-ms", "5000", "--json"], { cwd, ...jsonCap.io })).toBe(0);
    expect(JSON.parse(jsonCap.stdout[0]!)).toMatchObject({
      ok: true, command: "compat-runtime", status: "pass", complete: true,
      interoperability: "not-established", clientInstall: "not-assessed", clientLoad: "not-assessed", mcpHandshake: "verified"
    });

    const textCap = capture();
    expect(await runCli(["compat-runtime", cwd, "--allow-stdio-runtime"], { cwd, ...textCap.io })).toBe(0);
    expect(textCap.stdout.some((line) => line.startsWith("RUNTIME_COMPATIBILITY_PASS"))).toBe(true);
    expect(textCap.stdout).toContain("RUNTIME_CLIENT install=not-assessed load=not-assessed mcp-handshake=verified");
  }, 15_000);

  it("runs the explicitly enabled synthetic client fixture in JSON and text modes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-client-fixture-cli-"));
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "client-fixture-cli"
    }), "utf8");
    const fixtureArgs = [
      "compat-runtime", cwd,
      "--client-adapter", "synthetic-fixture",
      "--allow-client-runtime",
      "--allow-synthetic-fixture"
    ];

    const jsonCap = capture();
    expect(await runCli([...fixtureArgs, "--json"], { cwd, ...jsonCap.io })).toBe(0);
    expect(JSON.parse(jsonCap.stdout[0]!)).toMatchObject({
      ok: true,
      command: "compat-runtime",
      scope: "client-adapter-harness",
      synthetic: true,
      adapter: { id: "synthetic-fixture", version: "1.0.0-fixture" },
      targetClient: { id: "synthetic-fixture-client", version: "0.0.0-fixture" },
      execution: { status: "pass", complete: true, finalize: "complete" },
      packageInstall: "observed",
      clientLoad: "observed",
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    expect(jsonCap.stdout[0]).toContain("does not establish interoperability with any real client");

    const textCap = capture();
    expect(await runCli(fixtureArgs, { cwd, ...textCap.io })).toBe(0);
    expect(textCap.stdout.some((line) => line.startsWith("CLIENT_RUNTIME_PASS"))).toBe(true);
    expect(textCap.stdout).toContain(
      "CLIENT_RUNTIME_SCOPE client-adapter-harness complete=true synthetic=true interoperability=not-established interoperability-scope=none"
    );
    expect(textCap.stdout).toContain(
      "CLIENT_OBSERVATIONS install=observed load=observed mcp-startup=not-assessed mcp-handshake=not-assessed tool-exposure=not-assessed tool-invocation=not-assessed finalize=complete"
    );
  });

  it("lists the real VS Code adapter and its explicit executable/capability gates in help", async () => {
    const cap = capture();
    expect(await runCli(["--help"], cap.io)).toBe(0);
    const help = cap.stdout.join("\n");
    expect(help).toContain("vscode-github-copilot");
    expect(help).toContain("--client-executable <path>");
    expect(help).toContain("--allow-client-package-read");
    expect(help).toContain("--allow-client-process");
    expect(help).toContain("--allow-client-filesystem");
    expect(help).toContain("--allow-client-network");
    expect(help).toContain("--allow-client-mcp-runtime");
    expect(help).toContain("MCP disabled");
  });

  it("requires a separate VS Code-only opt-in for client-mediated MCP execution", async () => {
    const withoutLifecycle = capture();
    expect(await runCli([
      "compat-runtime", ".",
      "--client-adapter", "vscode-github-copilot",
      "--client-executable", process.execPath,
      "--allow-client-mcp-runtime",
      "--json"
    ], withoutLifecycle.io)).toBe(2);
    expect(JSON.parse(withoutLifecycle.stdout[0]!).error.message).toContain("also requires --allow-client-runtime");

    const synthetic = capture();
    expect(await runCli([
      "compat-runtime", ".",
      "--client-adapter", "synthetic-fixture",
      "--allow-client-runtime",
      "--allow-synthetic-fixture",
      "--allow-client-mcp-runtime",
      "--json"
    ], synthetic.io)).toBe(2);
    expect(JSON.parse(synthetic.stdout[0]!).error.message).toContain("accepts no executable path or client capability grants");

    const withoutAdapter = capture();
    expect(await runCli([
      "compat-runtime", ".", "--allow-client-mcp-runtime", "--json"
    ], withoutAdapter.io)).toBe(2);
    expect(JSON.parse(withoutAdapter.stdout[0]!).error.message).toContain("require --client-adapter");
  });

  it("requires a bounded absolute executable path for the VS Code adapter", async () => {
    const missing = capture();
    expect(await runCli([
      "compat-runtime", ".", "--client-adapter", "vscode-github-copilot", "--json"
    ], missing.io)).toBe(2);
    expect(JSON.parse(missing.stdout[0]!)).toMatchObject({
      error: { code: "USAGE_ERROR", message: expect.stringContaining("--client-executable") },
      exitCode: 2
    });

    const relative = capture();
    expect(await runCli([
      "compat-runtime", ".", "--client-adapter", "vscode-github-copilot",
      "--client-executable", "relative-code.exe", "--json"
    ], relative.io)).toBe(2);
    expect(JSON.parse(relative.stdout[0]!).error.message).toContain("absolute executable path");
  });

  it("denies the real adapter unless every declared capability is explicitly granted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-client-vscode-denied-cli-"));
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "client-vscode-denied-cli"
    }), "utf8");
    const cap = capture();
    expect(await runCli([
      "compat-runtime", cwd,
      "--client-adapter", "vscode-github-copilot",
      "--client-executable", process.execPath,
      "--allow-client-runtime",
      "--allow-client-package-read",
      "--allow-client-process",
      "--allow-client-filesystem",
      "--json"
    ], { cwd, ...cap.io })).toBe(1);
    expect(JSON.parse(cap.stdout[0]!)).toMatchObject({
      ok: false,
      synthetic: false,
      adapter: { id: "vscode-github-copilot" },
      requestedCapabilities: ["client-filesystem", "client-process", "network", "package-read"],
      grantedCapabilities: ["client-filesystem", "client-process", "package-read"],
      execution: { status: "denied", complete: false, finalize: "not-run" },
      packageInstall: "not-assessed",
      clientLoad: "not-assessed",
      mcpStartup: "not-assessed",
      mcpHandshake: "not-assessed",
      toolExposure: "not-assessed",
      toolInvocation: "not-assessed",
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
  });

  it("keeps the synthetic fixture at zero capabilities and rejects stray client opt-ins", async () => {
    const synthetic = capture();
    expect(await runCli([
      "compat-runtime", ".", "--client-adapter", "synthetic-fixture",
      "--allow-client-runtime", "--allow-synthetic-fixture", "--allow-client-process", "--json"
    ], synthetic.io)).toBe(2);
    expect(JSON.parse(synthetic.stdout[0]!).error.message).toContain("accepts no executable path or client capability grants");

    const noAdapter = capture();
    expect(await runCli([
      "compat-runtime", ".", "--client-executable", process.execPath, "--json"
    ], noAdapter.io)).toBe(2);
    expect(JSON.parse(noAdapter.stdout[0]!).error.message).toContain("require --client-adapter");
  });

  it("keeps client adapter execution and the synthetic fixture deny-by-default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-client-denied-cli-"));
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "client-denied-cli"
    }), "utf8");

    const denied = capture();
    expect(await runCli([
      "compat-runtime", cwd, "--client-adapter", "synthetic-fixture", "--allow-synthetic-fixture", "--json"
    ], { cwd, ...denied.io })).toBe(1);
    expect(JSON.parse(denied.stdout[0]!)).toMatchObject({
      ok: false,
      synthetic: true,
      execution: { status: "denied", complete: false, finalize: "not-run" },
      packageInstall: "not-assessed",
      clientLoad: "not-assessed",
      interoperability: "not-established"
    });

    const fixtureNotAllowed = capture();
    expect(await runCli([
      "compat-runtime", cwd, "--client-adapter", "synthetic-fixture", "--allow-client-runtime", "--json"
    ], { cwd, ...fixtureNotAllowed.io })).toBe(2);
    expect(JSON.parse(fixtureNotAllowed.stdout[0]!)).toMatchObject({ error: { code: "USAGE_ERROR" }, exitCode: 2 });
  });

  it("rejects unknown client adapters and mixed MCP/client runtime permissions", async () => {
    const unknown = capture();
    expect(await runCli(["compat-runtime", ".", "--client-adapter", "cursor", "--json"], unknown.io)).toBe(2);
    expect(JSON.parse(unknown.stdout[0]!)).toMatchObject({ error: { code: "USAGE_ERROR" }, exitCode: 2 });
    expect(unknown.stdout[0]).not.toContain("Cursor Agent Plugins");

    const mixed = capture();
    expect(await runCli([
      "compat-runtime", ".", "--client-adapter", "synthetic-fixture", "--allow-stdio-runtime", "--json"
    ], mixed.io)).toBe(2);
    expect(JSON.parse(mixed.stdout[0]!)).toMatchObject({ error: { code: "USAGE_ERROR" }, exitCode: 2 });
  });

  it("denies stdio runtime execution by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-runtime-denied-cli-"));
    const markerPath = join(cwd, "executed.txt");
    await writeFile(join(cwd, "marker.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');`, "utf8");
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "runtime-denied"
    }), "utf8");
    await writeFile(join(cwd, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["marker.mjs"] } }
    }), "utf8");
    const cap = capture();
    expect(await runCli(["compat-runtime", cwd, "--json"], { cwd, ...cap.io })).toBe(1);
    expect(JSON.parse(cap.stdout[0]!)).toMatchObject({ ok: false, status: "not-assessed", mcpHandshake: "not-assessed" });
    expect(await stat(markerPath).catch(() => undefined)).toBeUndefined();
  });

  it("keeps static compat and certification non-executing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-static-noexec-"));
    const markerPath = join(cwd, "static-executed.txt");
    await writeFile(join(cwd, "marker.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');`, "utf8");
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "static-noexec"
    }), "utf8");
    await writeFile(join(cwd, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["marker.mjs"] } }
    }), "utf8");
    expect(await runCli(["compat", cwd, "--all", "--json"], { cwd, ...capture().io })).toBe(0);
    expect(await runCli(["certify", cwd, "--json"], { cwd, ...capture().io })).toBe(0);
    expect(await stat(markerPath).catch(() => undefined)).toBeUndefined();
  });

  it("does not treat a no-MCP package as runtime verified", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agentplugin-runtime-none-cli-"));
    await writeFile(join(cwd, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "runtime-none"
    }), "utf8");
    const cap = capture();
    expect(await runCli(["compat-runtime", cwd, "--json"], { cwd, ...cap.io })).toBe(1);
    expect(JSON.parse(cap.stdout[0]!)).toMatchObject({
      ok: false, status: "not-assessed", complete: false, interoperability: "not-established", mcpHandshake: "not-assessed"
    });
  });

  it("rejects invalid runtime compatibility options with usage exit code", async () => {
    const cap = capture();
    expect(await runCli(["compat-runtime", ".", "--timeout-ms", "99", "--json"], cap.io)).toBe(2);
    expect(JSON.parse(cap.stdout[0]!)).toMatchObject({ error: { code: "USAGE_ERROR" }, exitCode: 2 });
  });
});
