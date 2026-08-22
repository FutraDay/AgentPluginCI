import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scanPackageSecurity,
  scanPluginSecurity,
  severityAtLeast
} from "./index.js";

function ids(result: ReturnType<typeof scanPluginSecurity>): string[] {
  return result.findings.map((finding) => finding.id);
}

describe("deterministic Agent Plugin security scanning", () => {
  it("accepts a low-risk generated package without findings", () => {
    const result = scanPluginSecurity({
      manifest: { name: "safe-plugin", homepage: "https://example.com" },
      mcp: {
        mcpServers: {
          remote: {
            type: "streamable-http",
            url: "https://example.com/mcp",
            headers: { "X-Tenant": "public" }
          }
        }
      },
      skills: { help: "Use the safe remote MCP endpoint." }
    });

    expect(result).toEqual({
      complete: true,
      findings: [],
      summary: { info: 0, low: 0, medium: 0, high: 0, critical: 0, total: 0 }
    });
  });
  it("detects embedded environment credentials without exposing the value", () => {
    const secret = "literal-super-secret-value";
    const result = scanPluginSecurity({
      manifest: { name: "unsafe" },
      mcp: {
        mcpServers: {
          local: { type: "stdio", command: "node", env: { OPENAI_API_KEY: secret } }
        }
      }
    });

    expect(ids(result)).toContain("APCI-SEC-001");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("detects known secret material and marks it critical", () => {
    const secret = `sk-proj-${"A".repeat(32)}`;
    const result = scanPluginSecurity({
      manifest: { name: "unsafe", extensions: { "com.example": { token: secret } } },
      skills: { test: `Never embed ${secret}` }
    });

    expect(ids(result)).toContain("APCI-SEC-019");
    expect(result.summary.critical).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("allows runtime credential placeholders but flags literal auth headers", () => {
    const placeholder = scanPluginSecurity({
      manifest: { name: "safe" },
      mcp: { mcpServers: { remote: {
        type: "streamable-http", url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${MCP_TOKEN}" }
      } } }
    });
    expect(ids(placeholder)).not.toContain("APCI-SEC-008");

    const literal = scanPluginSecurity({
      manifest: { name: "unsafe" },
      mcp: { mcpServers: { remote: {
        type: "streamable-http", url: "https://example.com/mcp",
        headers: { Authorization: "Bearer fixed-token-value" }
      } } }
    });
    expect(ids(literal)).toContain("APCI-SEC-008");
    expect(JSON.stringify(literal)).not.toContain("fixed-token-value");
  });
  it("flags credentialed, insecure, private, and metadata MCP URLs", () => {
    const credentialed = scanPluginSecurity({
      manifest: { name: "unsafe" },
      mcp: { mcpServers: { remote: { type: "sse", url: "https://user:pass@example.com/mcp?token=abc" } } }
    });
    expect(ids(credentialed)).toContain("APCI-SEC-002");
    expect(ids(credentialed)).toContain("APCI-SEC-003");
    expect(JSON.stringify(credentialed)).not.toContain("user:pass");

    const privateTarget = scanPluginSecurity({
      manifest: { name: "private" },
      mcp: { mcpServers: { remote: { type: "streamable-http", url: "http://192.168.1.10/mcp" } } }
    });
    expect(ids(privateTarget)).toContain("APCI-SEC-004");
    expect(ids(privateTarget)).toContain("APCI-SEC-005");

    const metadata = scanPluginSecurity({
      manifest: { name: "metadata" },
      mcp: { mcpServers: { remote: { type: "streamable-http", url: "http://169.254.169.254/latest" } } }
    });
    expect(ids(metadata)).toContain("APCI-SEC-006");
    expect(metadata.summary.highestSeverity).toBe("critical");
  });

  it("flags risky stdio execution behavior and execution-control environment", () => {
    const result = scanPluginSecurity({
      manifest: { name: "unsafe" },
      mcp: { mcpServers: {
        runner: { type: "stdio", command: "npx", args: ["-y", "some-package@latest"] },
        inline: { type: "stdio", command: "powershell.exe", args: ["-Command", "Write-Host hi"], env: { NODE_OPTIONS: "--require ./hook.js" } },
        path: { type: "stdio", command: "node", args: ["--config=C:\\temp\\config.json"] },
        executable: { type: "stdio", command: "C:\\tools\\server.exe" }
      } }
    });

    expect(ids(result)).toContain("APCI-SEC-009");
    expect(ids(result)).toContain("APCI-SEC-010");
    expect(ids(result)).toContain("APCI-SEC-013");
    expect(ids(result)).toContain("APCI-SEC-023");
  });

  it("implements stable severity threshold comparison", () => {
    expect(severityAtLeast("critical", "high")).toBe(true);
    expect(severityAtLeast("high", "high")).toBe(true);
    expect(severityAtLeast("medium", "high")).toBe(false);
  });
  it("scans package files for sensitive artifacts and executable content", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentplugin-security-package-"));
    const secret = `sk-proj-${"B".repeat(32)}`;
    await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "safe" }), "utf8");
    await writeFile(join(root, ".env"), `OPENAI_API_KEY=${secret}\n`, "utf8");
    await writeFile(join(root, "server.js"), `export const token = ${JSON.stringify(secret)};\n`, "utf8");
    await writeFile(join(root, "launch.ps1"), "Write-Host test\n", "utf8");

    const result = await scanPackageSecurity(root);
    const ruleIds = result.findings.map((finding) => finding.id);
    expect(ruleIds).toContain("APCI-SEC-017");
    expect(ruleIds).toContain("APCI-SEC-018");
    expect(ruleIds).toContain("APCI-SEC-019");
    expect(result.findings.some((finding) => finding.id === "APCI-SEC-019" && finding.location === "server.js")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("flags and does not traverse sensitive security-state directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentplugin-security-sensitive-dir-"));
    const gitDir = join(root, ".git");
    await mkdir(gitDir);
    await writeFile(join(gitDir, "config"), "credential=should-not-be-read", "utf8");

    const result = await scanPackageSecurity(root);
    expect(result.findings.some((finding) => finding.id === "APCI-SEC-017" && finding.location === ".git")).toBe(true);
    expect(result.complete).toBe(true);
  });

  it("handles UTF-8 BOM JSON without losing targeted checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentplugin-security-bom-"));
    await writeFile(join(root, "plugin.json"), `\ufeff${JSON.stringify({ name: "safe" })}`, "utf8");
    await writeFile(join(root, "mcp.json"), `\ufeff${JSON.stringify({ mcpServers: { remote: { type: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer bom-secret" } } } })}`, "utf8");
    const result = await scanPackageSecurity(root);
    expect(result.complete).toBe(true);
    expect(result.findings.some((finding) => finding.id === "APCI-SEC-008")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("bom-secret");
  });

  it("marks malformed structured files as an incomplete security scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentplugin-security-json-"));
    await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "safe" }), "utf8");
    await writeFile(join(root, "mcp.json"), "{not-json", "utf8");

    const result = await scanPackageSecurity(root);
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => finding.id === "APCI-SEC-021")).toBe(true);
  });

  it("fails closed when filesystem inspection budgets are exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentplugin-security-limit-"));
    await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "safe" }), "utf8");
    await writeFile(join(root, "extra.txt"), "extra", "utf8");

    const result = await scanPackageSecurity(root, { maxFiles: 1 });
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => finding.id === "APCI-SEC-020")).toBe(true);
  });

  it("marks a text inspection budget cutoff as incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentplugin-security-text-limit-"));
    await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "safe", description: "x".repeat(200) }), "utf8");

    const result = await scanPackageSecurity(root, { maxTextBytes: 10 });
    expect(result.complete).toBe(false);
    expect(result.findings.some((finding) => finding.id === "APCI-SEC-020")).toBe(true);
  });
  it.skipIf(process.platform === "win32")("does not follow package symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentplugin-security-symlink-"));
    const target = join(root, "target");
    await mkdir(target);
    await writeFile(join(target, "secret.txt"), "safe", "utf8");
    await symlink(target, join(root, "linked"), "dir");

    const result = await scanPackageSecurity(root);
    expect(result.findings.some((finding) => finding.id === "APCI-SEC-015" && finding.location === "linked")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("detects case-insensitive filesystem collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentplugin-security-case-"));
    await writeFile(join(root, "Alpha.txt"), "a", "utf8");
    await writeFile(join(root, "alpha.txt"), "b", "utf8");

    const result = await scanPackageSecurity(root);
    expect(result.findings.some((finding) => finding.id === "APCI-SEC-016")).toBe(true);
  });
});
