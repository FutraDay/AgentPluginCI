import { access, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_SCHEMA, PLUGIN_SCHEMA } from "@agent-plugin-ci/spec-agent-plugins-v1";
import { describe, expect, it } from "vitest";
import { assessPackageRuntimeCompatibility, preflightSingleClientMcpStdioTarget } from "./runtime.js";

const sdkFixture = fileURLToPath(new URL("../../ingest-mcp/test-fixtures/stdio-server.mjs", import.meta.url));

async function packageDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeJson(join(root, "plugin.json"), { $schema: PLUGIN_SCHEMA, name: "runtime-fixture" });
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeMcp(root: string, servers: Record<string, unknown>): Promise<void> {
  await writeJson(join(root, "mcp.json"), { $schema: MCP_SCHEMA, mcpServers: servers });
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}
async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("runtime compatibility evidence", () => {
  it("does not claim runtime interoperability when no MCP target exists", async () => {
    const root = await packageDir("agentplugin-runtime-none-");
    const report = await assessPackageRuntimeCompatibility(root);
    expect(report).toMatchObject({
      evidenceLevel: "runtime-observation",
      scope: "mcp-startup-handshake",
      status: "not-assessed",
      complete: false,
      interoperability: "not-established",
      clientInstall: "not-assessed",
      clientLoad: "not-assessed",
      mcpHandshake: "not-assessed"
    });
    expect(report.servers).toEqual([]);
    expect(JSON.stringify(report)).toContain("NO-TARGET");
  });

  it("denies stdio execution unless explicitly enabled", async () => {
    const root = await packageDir("agentplugin-runtime-denied-");
    const marker = join(root, "executed.txt");
    await writeMcp(root, {
      local: { type: "stdio", command: "node", args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`] }
    });
    const report = await assessPackageRuntimeCompatibility(root);
    expect(report).toMatchObject({ status: "not-assessed", complete: false, mcpHandshake: "not-assessed" });
    expect(report.servers[0]).toMatchObject({
      name: "local", transport: "stdio", status: "not-assessed", startup: "not-assessed", handshake: "not-assessed"
    });
    expect(await exists(marker)).toBe(false);
  });

  it("performs a real MCP stdio initialize handshake with explicit opt-in", async () => {
    const root = await packageDir("agentplugin-runtime-stdio-");
    await writeMcp(root, { fixture: { type: "stdio", command: "node", args: [sdkFixture] } });
    const report = await assessPackageRuntimeCompatibility(root, { allowStdioRuntime: true, timeoutMs: 5_000 });
    expect(report).toMatchObject({
      status: "pass", complete: true, interoperability: "not-established", mcpHandshake: "verified"
    });
    expect(report.servers[0]).toMatchObject({
      name: "fixture", transport: "stdio", status: "pass", startup: "pass", handshake: "pass", complete: true
    });
  }, 10_000);

  it("reports process-start failure without exposing the command", async () => {
    const root = await packageDir("agentplugin-runtime-start-fail-");
    const secretCommand = "missing-runtime-token-secret-value";
    await writeMcp(root, { broken: { type: "stdio", command: secretCommand } });
    const first = await assessPackageRuntimeCompatibility(root, { allowStdioRuntime: true, timeoutMs: 500 });
    const second = await assessPackageRuntimeCompatibility(root, { allowStdioRuntime: true, timeoutMs: 500 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.status).toBe("fail");
    expect(first.servers[0]).toMatchObject({ startup: "fail", handshake: "not-assessed", complete: true });
    expect(JSON.stringify(first)).not.toContain(secretCommand);
  });

  it("times out a non-MCP stdio process and cleans it up", async () => {
    const root = await packageDir("agentplugin-runtime-timeout-");
    const pidFile = join(root, "pid.txt");
    await writeFile(join(root, "hang.mjs"),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, "utf8");
    await writeMcp(root, { hanging: { type: "stdio", command: "node", args: ["hang.mjs"] } });
    const report = await assessPackageRuntimeCompatibility(root, { allowStdioRuntime: true, timeoutMs: 150 });
    expect(report.status).toBe("fail");
    expect(report.servers[0]?.handshake).toBe("fail");
    expect(JSON.stringify(report)).toContain("APCI-RUNTIME-MCP-003");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(await waitForExit(pid)).toBe(true);
  }, 10_000);
  it("fails closed for malformed, oversized, and symlinked runtime inputs", async () => {
    const malformed = await packageDir("agentplugin-runtime-malformed-");
    await writeFile(join(malformed, "mcp.json"), "{not-json", "utf8");
    const malformedReport = await assessPackageRuntimeCompatibility(malformed);
    expect(malformedReport.status).toBe("unknown");
    expect(JSON.stringify(malformedReport)).toContain("APCI-RUNTIME-INPUT-009");

    const oversized = await packageDir("agentplugin-runtime-oversized-");
    await writeFile(join(oversized, "mcp.json"), "x".repeat(1_000_001), "utf8");
    const oversizedReport = await assessPackageRuntimeCompatibility(oversized);
    expect(oversizedReport.status).toBe("unknown");
    expect(JSON.stringify(oversizedReport)).toContain("APCI-RUNTIME-INPUT-007");

    const target = await packageDir("agentplugin-runtime-symlink-target-");
    await writeMcp(target, {});
    const link = `${target}-link`;
    try { await symlink(target, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    const linkReport = await assessPackageRuntimeCompatibility(link);
    expect(linkReport.status).toBe("unknown");
    expect(JSON.stringify(linkReport)).toContain("APCI-RUNTIME-INPUT-001");
  });

  it("denies insecure and private remote MCP targets by default", async () => {
    const insecure = await packageDir("agentplugin-runtime-http-");
    await writeMcp(insecure, { remote: { type: "streamable-http", url: "http://127.0.0.1/mcp" } });
    const insecureReport = await assessPackageRuntimeCompatibility(insecure);
    expect(insecureReport.servers[0]).toMatchObject({ status: "not-assessed", handshake: "not-assessed" });
    expect(JSON.stringify(insecureReport)).toContain("APCI-RUNTIME-NET-004");

    const privateTarget = await packageDir("agentplugin-runtime-private-");
    await writeMcp(privateTarget, { remote: { type: "streamable-http", url: "https://127.0.0.1/mcp" } });
    const privateReport = await assessPackageRuntimeCompatibility(privateTarget);
    expect(privateReport.servers[0]).toMatchObject({ status: "not-assessed", handshake: "not-assessed" });
    expect(JSON.stringify(privateReport)).toContain("APCI-RUNTIME-NET-005");
  });

  it("never executes or reports literal stdio environment values", async () => {
    const root = await packageDir("agentplugin-runtime-env-");
    const literalSecret = "literal-runtime-secret-value";
    await writeMcp(root, {
      local: { type: "stdio", command: "node", env: { API_TOKEN: literalSecret } }
    });
    const report = await assessPackageRuntimeCompatibility(root, { allowStdioRuntime: true });
    expect(report.servers[0]).toMatchObject({ status: "not-assessed", startup: "not-assessed", handshake: "not-assessed" });
    expect(JSON.stringify(report)).toContain("APCI-RUNTIME-ENV-001");
    expect(JSON.stringify(report)).not.toContain(literalSecret);
  });

  it("rejects symlinked mcp.json without following it", async () => {
    const root = await packageDir("agentplugin-runtime-mcp-link-");
    const external = join(root, "external-mcp.json");
    await writeJson(external, { $schema: MCP_SCHEMA, mcpServers: {} });
    try { await symlink(external, join(root, "mcp.json"), "file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    const report = await assessPackageRuntimeCompatibility(root);
    expect(report.status).toBe("unknown");
    expect(JSON.stringify(report)).toContain("APCI-RUNTIME-INPUT-006");
  });

  it("does not send or expose credential-like URL query parameters", async () => {
    const root = await packageDir("agentplugin-runtime-url-secret-");
    const secret = "literal-runtime-query-secret";
    await writeMcp(root, {
      remote: { type: "streamable-http", url: `https://example.com/mcp?token=${secret}` }
    });
    const report = await assessPackageRuntimeCompatibility(root);
    expect(report.servers[0]).toMatchObject({ status: "not-assessed", handshake: "not-assessed" });
    expect(JSON.stringify(report)).toContain("APCI-RUNTIME-NET-008");
    expect(JSON.stringify(report)).not.toContain(secret);
  });
  it("orders server evidence deterministically", async () => {
    const root = await packageDir("agentplugin-runtime-order-");
    await writeMcp(root, {
      zeta: { type: "stdio", command: "node" },
      alpha: { type: "stdio", command: "node" }
    });
    const first = await assessPackageRuntimeCompatibility(root);
    const second = await assessPackageRuntimeCompatibility(root);
    expect(first.servers.map((server) => server.name)).toEqual(["alpha", "zeta"]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("preflights one bounded environment-free stdio target without executing it", async () => {
    const root = await packageDir("agentplugin-client-mcp-preflight-");
    const marker = join(root, "must-not-exist.txt");
    const localFixture = join(root, "fixture-server.mjs");
    await writeFile(
      localFixture,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
      "utf8"
    );
    await writeMcp(root, {
      fixture: { type: "stdio", command: "node", args: [localFixture], cwd: "${PLUGIN_ROOT}" }
    });
    await expect(preflightSingleClientMcpStdioTarget(root)).resolves.toMatchObject({
      ok: true,
      target: {
        name: "fixture",
        location: "mcp.json/mcpServers/fixture",
        command: "node",
        args: [localFixture],
        mcpSchema: MCP_SCHEMA
      }
    });
    expect(await exists(marker)).toBe(false);
  });

  it("rejects ambiguous, remote, unsupported-cwd-bearing, and environment-bearing client MCP targets", async () => {
    const cases: Array<{ servers: Record<string, unknown>; code: string }> = [
      {
        servers: {
          one: { type: "stdio", command: "node" },
          two: { type: "stdio", command: "node" }
        },
        code: "APCI-RUNTIME-CLIENT-001"
      },
      {
        servers: { remote: { type: "streamable-http", url: "https://example.com/mcp" } },
        code: "APCI-RUNTIME-CLIENT-002"
      },
      {
        servers: { cwd: { type: "stdio", command: "node", cwd: "." } },
        code: "APCI-RUNTIME-INPUT-003"
      },
      {
        servers: { cwdPluginData: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}" } },
        code: "APCI-RUNTIME-BOUND-003"
      },
      {
        servers: { cwdPluginSubdir: { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}/subdir" } },
        code: "APCI-RUNTIME-BOUND-003"
      },
      {
        servers: { cwdRelative: { type: "stdio", command: "node", cwd: "./" } },
        code: "APCI-RUNTIME-BOUND-003"
      },
      {
        servers: { env: { type: "stdio", command: "node", env: { TOKEN: "${TOKEN}" } } },
        code: "APCI-RUNTIME-CLIENT-003"
      }
    ];
    for (const item of cases) {
      const root = await packageDir("agentplugin-client-mcp-reject-");
      await writeMcp(root, item.servers);
      const result = await preflightSingleClientMcpStdioTarget(root);
      expect(result).toMatchObject({ ok: false, code: item.code });
    }
  });

  it("rejects escaped, missing, and symlinked absolute client MCP argument paths", async () => {
    const externalRoot = await packageDir("agentplugin-client-mcp-external-");
    const externalFile = join(externalRoot, "external.mjs");
    await writeFile(externalFile, "// outside target package\n", "utf8");

    const escapedRoot = await packageDir("agentplugin-client-mcp-escaped-");
    await writeMcp(escapedRoot, { fixture: { type: "stdio", command: "node", args: [externalFile] } });
    await expect(preflightSingleClientMcpStdioTarget(escapedRoot)).resolves.toMatchObject({
      ok: false,
      code: "APCI-RUNTIME-CLIENT-004"
    });

    const missingRoot = await packageDir("agentplugin-client-mcp-missing-");
    await writeMcp(missingRoot, {
      fixture: { type: "stdio", command: "node", args: [join(missingRoot, "missing.mjs")] }
    });
    await expect(preflightSingleClientMcpStdioTarget(missingRoot)).resolves.toMatchObject({
      ok: false,
      code: "APCI-RUNTIME-CLIENT-004"
    });

    const traversalRoot = await packageDir("agentplugin-client-mcp-traversal-");
    await writeMcp(traversalRoot, {
      fixture: { type: "stdio", command: "node", args: ["../outside.mjs"] }
    });
    await expect(preflightSingleClientMcpStdioTarget(traversalRoot)).resolves.toMatchObject({
      ok: false,
      code: "APCI-RUNTIME-CLIENT-004"
    });

    const symlinkRoot = await packageDir("agentplugin-client-mcp-arg-link-");
    const link = join(symlinkRoot, "linked.mjs");
    try { await symlink(externalFile, link, "file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    await writeMcp(symlinkRoot, { fixture: { type: "stdio", command: "node", args: [link] } });
    await expect(preflightSingleClientMcpStdioTarget(symlinkRoot)).resolves.toMatchObject({
      ok: false,
      code: "APCI-RUNTIME-CLIENT-004"
    });
  });
});
