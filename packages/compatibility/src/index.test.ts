import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SCHEMA, PLUGIN_SCHEMA } from "@agent-plugin-ci/spec-agent-plugins-v1";
import { describe, expect, it } from "vitest";
import {
  assessPackageCompatibility,
  assessPluginCompatibility,
  BUILT_IN_COMPATIBILITY_PROFILES,
  COPILOT_PROFILE_ID,
  CURSOR_PROFILE_ID,
  evaluateCompatibilityProfile,
  getCompatibilityProfile,
  listCompatibilityProfiles,
  PORTABLE_CORE_PROFILE_ID,
  UnknownCompatibilityProfileError,
  type CompatibilityProfile
} from "./index.js";

const validManifest = (overrides: Record<string, unknown> = {}) => ({
  $schema: PLUGIN_SCHEMA,
  name: "compatibility-fixture",
  ...overrides
});

async function packageDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("compatibility profiles and reports", () => {
  it("publishes stable built-in profile and source metadata", () => {
    const profiles = listCompatibilityProfiles();

    expect(profiles.map((profile) => profile.id)).toEqual([
      PORTABLE_CORE_PROFILE_ID,
      CURSOR_PROFILE_ID,
      COPILOT_PROFILE_ID
    ]);
    expect(profiles.every((profile) => profile.version === "1.0.0")).toBe(true);
    expect(profiles.every((profile) => profile.evidenceLevel === "static-inspection")).toBe(true);
    expect(profiles.every((profile) => profile.sources.length > 0)).toBe(true);
    expect(BUILT_IN_COMPATIBILITY_PROFILES.every((profile) => Object.isFrozen(profile) && Object.isFrozen(profile.rules))).toBe(true);
    expect(profiles.find((profile) => profile.id === COPILOT_PROFILE_ID)?.sources
      .flatMap((source) => source.claims)).toContain("Other client extension namespaces are ignored.");
    expect(BUILT_IN_COMPATIBILITY_PROFILES.flatMap((profile) => profile.rules)
      .every((rule) => /^APCI-COMP-[A-Z]+-\d{3}$/.test(rule.id))).toBe(true);
  });

  it("rejects unknown profile IDs deterministically", () => {
    expect(() => getCompatibilityProfile("unknown-client"))
      .toThrowError(UnknownCompatibilityProfileError);
    expect(() => assessPluginCompatibility({ manifest: validManifest() }, ["unknown-client"]))
      .toThrow("Unknown compatibility profile: unknown-client");
  });

  it("produces deterministic ordered reports with explicit runtime-unverified state", () => {
    const input = {
      manifest: validManifest(),
      skills: [
        { name: "zeta", location: "skills/zeta/SKILL.md" },
        { name: "alpha", location: "skills/alpha/SKILL.md" }
      ]
    };
    const first = assessPluginCompatibility(input, [COPILOT_PROFILE_ID, PORTABLE_CORE_PROFILE_ID]);
    const second = assessPluginCompatibility(input, [COPILOT_PROFILE_ID, PORTABLE_CORE_PROFILE_ID]);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.profiles.map((profile) => profile.profile.id)).toEqual([COPILOT_PROFILE_ID, PORTABLE_CORE_PROFILE_ID]);
    for (const profile of first.profiles) {
      expect(profile.tests.map((test) => test.id)).toEqual([...profile.tests.map((test) => test.id)].sort());
      expect(profile.runtimeEvidence).toMatchObject({
        runtimeVerified: false,
        clientInstall: "not-assessed",
        mcpHandshake: "not-assessed"
      });
    }
    expect(first.runtimeEvidence.runtimeVerified).toBe(false);
    expect(first.runtimeEvidence.note).toContain("does not prove");
  });

  it("bounds and redacts rule evidence", () => {
    const profile: CompatibilityProfile = {
      id: "test-redaction",
      version: "1.0.0",
      title: "Redaction test",
      evidenceLevel: "static-inspection",
      sources: [{ title: "Local test source", url: "https://example.com/test", claims: ["Exercises report safety."] }],
      rules: [{
        id: "APCI-COMP-TEST-001",
        title: "Untrusted evidence is bounded",
        evaluate: () => ({
          status: "warn",
          evidence: Array.from({ length: 10 }, (_, index) => ({
            location: `plugin.json/test-${index}`,
            summary: index === 0
              ? `api_key=literal-sensitive-value-${"x".repeat(300)}\nINJECTED`
              : index === 1
                ? "-----BEGIN PRIVATE KEY-----\nprivate-material"
                : index === 2
                  ? "AWS key AKIAABCDEFGHIJKLMNOP"
              : `evidence-${index}`
          }))
        })
      }]
    };

    const report = evaluateCompatibilityProfile(profile, { manifest: validManifest() });
    const serialized = JSON.stringify(report);
    expect(report.tests[0]?.evidence).toHaveLength(4);
    expect(report.tests[0]?.evidence.at(-1)?.summary).toContain("additional evidence");
    expect(serialized).not.toContain("literal-sensitive-value");
    expect(report.tests[0]?.evidence[0]?.summary).toContain("\\u000aINJECTED");
    expect(report.tests[0]?.evidence[0]?.summary).not.toContain("\n");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  it("fails closed when assessment input is explicitly incomplete", () => {
    const report = evaluateCompatibilityProfile(getCompatibilityProfile(PORTABLE_CORE_PROFILE_ID), {
      manifest: validManifest(),
      inputComplete: false
    });

    expect(report.status).toBe("unknown");
    expect(report.staticEligibility).toBe("unknown");
    expect(report.complete).toBe(false);
    expect(report.summary.unknown).toBe(1);
  });

  it("bounds official validation evidence without duplicating validator rules", () => {
    const report = assessPluginCompatibility({
      manifest: {
        $schema: "wrong-schema",
        name: "Invalid--Name",
        version: 1,
        author: { unexpected: true },
        keywords: [1, 2],
        extra: true
      }
    });
    const validation = report.profiles[0]?.tests.find((test) => test.id === "APCI-COMP-CORE-002");

    expect(report.staticEligibility).toBe("ineligible");
    expect(validation?.evidence).toHaveLength(4);
    expect(validation?.evidence.at(-1)?.summary).toContain("additional validation message(s) omitted");
  });

  it("converts unexpected rule failures into unknown evidence", () => {
    const profile: CompatibilityProfile = {
      id: "test-rule-failure",
      version: "1.0.0",
      title: "Rule failure test",
      evidenceLevel: "static-inspection",
      sources: [{ title: "Local test source", url: "https://example.com/test", claims: ["Exercises fail-closed behavior."] }],
      rules: [{ id: "APCI-COMP-TEST-002", title: "Failing rule", evaluate: () => { throw new Error("private detail"); } }]
    };

    const report = evaluateCompatibilityProfile(profile, { manifest: validManifest() });
    expect(report.status).toBe("unknown");
    expect(report.complete).toBe(false);
    expect(report.tests[0]?.evidence[0]?.summary).not.toContain("private detail");
  });
});

describe("compiled package compatibility inspection", () => {
  it("accepts a portable skill-only package", async () => {
    const root = await packageDirectory("agentplugin-compat-skill-");
    await writeJson(join(root, "plugin.json"), validManifest());
    await mkdir(join(root, "skills", "greet"), { recursive: true });
    await writeFile(join(root, "skills", "greet", "SKILL.md"), "---\nname: greet\n---\n\nGreet the user.\n", "utf8");

    const report = await assessPackageCompatibility(root);
    expect(report).toMatchObject({ complete: true, status: "warn", staticEligibility: "eligible" });
    expect(report.package).toMatchObject({ name: "compatibility-fixture", skills: 1, mcpServers: 0 });
    expect(report.profiles[0]?.tests.find((test) => test.id === "APCI-COMP-CORE-003")?.evidence[0]?.summary)
      .toContain("SKILL.md document validity is not assessed");
  });

  it("accepts a schema-valid MCP package without connecting to its server", async () => {
    const root = await packageDirectory("agentplugin-compat-mcp-");
    await writeJson(join(root, "plugin.json"), validManifest());
    await writeJson(join(root, "mcp.json"), {
      $schema: MCP_SCHEMA,
      mcpServers: { local: { type: "stdio", command: "definitely-not-executed" } }
    });

    const report = await assessPackageCompatibility(root, [PORTABLE_CORE_PROFILE_ID, CURSOR_PROFILE_ID]);
    expect(report.staticEligibility).toBe("eligible");
    expect(report.package.mcpServers).toBe(1);
    expect(report.profiles.every((profile) => profile.status === "pass")).toBe(true);
  });

  it("keeps other clients' opaque extension namespaces non-blocking", async () => {
    const root = await packageDirectory("agentplugin-compat-extensions-");
    await writeJson(join(root, "plugin.json"), validManifest({
      extensions: {
        "com.github.copilot": { arbitrary: { nested: true } },
        "com.example.other-client": { undocumented: ["opaque"] }
      }
    }));
    await mkdir(join(root, "skills", "portable"), { recursive: true });
    await writeFile(join(root, "skills", "portable", "SKILL.md"), "Portable skill.\n", "utf8");

    const report = await assessPackageCompatibility(root, BUILT_IN_COMPATIBILITY_PROFILES.map((profile) => profile.id));
    expect(report.staticEligibility).toBe("eligible");
    expect(report.profiles.every((profile) => profile.summary.fail === 0 && profile.summary.unknown === 0)).toBe(true);
    const copilotExtension = report.profiles.find((profile) => profile.profile.id === COPILOT_PROFILE_ID)
      ?.tests.find((test) => test.id === "APCI-COMP-COPILOT-004");
    expect(copilotExtension?.evidence[0]?.summary).toContain("opaque contents were not interpreted");
    expect(copilotExtension?.evidence[0]?.summary).toContain("1 other namespace(s) are non-blocking");
  });

  it("reports malformed packages as invalid without exposing parser input", async () => {
    const root = await packageDirectory("agentplugin-compat-invalid-");
    await writeFile(join(root, "plugin.json"), "{\"token\":\"literal-sensitive-value\",", "utf8");

    const report = await assessPackageCompatibility(root);
    const serialized = JSON.stringify(report);
    expect(report.status).toBe("fail");
    expect(report.staticEligibility).toBe("ineligible");
    expect(report.complete).toBe(false);
    expect(serialized).toContain("APCI-COMP-INPUT-006");
    expect(serialized).not.toContain("literal-sensitive-value");
  });

  it("uses unknown and incomplete when a portable component exceeds inspection bounds", async () => {
    const root = await packageDirectory("agentplugin-compat-incomplete-");
    await writeJson(join(root, "plugin.json"), validManifest());
    await mkdir(join(root, "skills", "oversized"), { recursive: true });
    await writeFile(join(root, "skills", "oversized", "SKILL.md"), "x".repeat(256_001), "utf8");

    const report = await assessPackageCompatibility(root);
    expect(report.status).toBe("unknown");
    expect(report.staticEligibility).toBe("unknown");
    expect(report.complete).toBe(false);
    expect(JSON.stringify(report)).toContain("APCI-COMP-INPUT-014");
  });

  it("rejects non-directory targets and symbolic-link package roots", async () => {
    const root = await packageDirectory("agentplugin-compat-path-");
    const pluginPath = join(root, "plugin.json");
    await writeJson(pluginPath, validManifest());

    const fileReport = await assessPackageCompatibility(pluginPath);
    expect(fileReport.staticEligibility).toBe("ineligible");
    expect(JSON.stringify(fileReport)).toContain("APCI-COMP-INPUT-002");

    const linkPath = `${root}-link`;
    try {
      await symlink(root, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const linkReport = await assessPackageCompatibility(linkPath);
    expect(linkReport.staticEligibility).toBe("ineligible");
    expect(JSON.stringify(linkReport)).toContain("APCI-COMP-INPUT-002");
  });

  it("rejects unsafe skill entries instead of following them", async () => {
    const root = await packageDirectory("agentplugin-compat-skill-path-");
    await writeJson(join(root, "plugin.json"), validManifest());
    await mkdir(join(root, "skills"));
    await writeFile(join(root, "skills", "not-a-directory"), "outside", "utf8");

    const report = await assessPackageCompatibility(root);
    expect(report.staticEligibility).toBe("ineligible");
    expect(JSON.stringify(report)).toContain("APCI-COMP-INPUT-012");
  });
});
