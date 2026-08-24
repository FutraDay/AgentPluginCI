import { describe, expect, it } from "vitest";
import {
  assessPluginCompatibility,
  CLIENT_RUNTIME_REPORT_SCHEMA_VERSION,
  COPILOT_PROFILE_ID,
  CURSOR_PROFILE_ID,
  PORTABLE_CORE_PROFILE_ID,
  type ClientRuntimeReport
} from "@agent-plugin-ci/compatibility";
import type { SecurityFinding, SecurityScanResult } from "@agent-plugin-ci/security";
import {
  certifyPluginEvidence,
  certifyRuntimeEvidence,
  REQUIRED_COMPATIBILITY_PROFILES,
  RUNTIME_CERTIFICATION_REPORT_SCHEMA_VERSION,
  SCOPED_RUNTIME_CERTIFICATION_ID,
  SCOPED_RUNTIME_CERTIFICATION_POLICY_ID,
  SCOPED_RUNTIME_CERTIFICATION_SCOPE,
  STATIC_PORTABILITY_CERTIFICATION_ID,
  type CertificationEvidenceInput
} from "./index.js";

const manifest = { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "safe-plugin", version: "1.0.0", description: "Safe", author: { name: "Test" } };
const profiles = [PORTABLE_CORE_PROFILE_ID, CURSOR_PROFILE_ID, COPILOT_PROFILE_ID];

function security(findings: SecurityFinding[] = [], complete = true): SecurityScanResult {
  const count = (severity: SecurityFinding["severity"]) => findings.filter((item) => item.severity === severity).length;
  return { complete, findings, summary: { info: count("info"), low: count("low"), medium: count("medium"), high: count("high"), critical: count("critical"), total: findings.length } };
}

function finding(severity: SecurityFinding["severity"], evidence = "bounded evidence"): SecurityFinding {
  return { id: `APCI-SEC-${severity}`, severity, title: "Finding", location: "plugin.json", evidence, remediation: "Fix it" };
}

function base(): CertificationEvidenceInput {
  return { validation: { ok: true, errors: [], warnings: [] }, security: security(), compatibility: assessPluginCompatibility({ manifest }, profiles) };
}

function clientRuntime(overrides: Partial<ClientRuntimeReport> = {}): ClientRuntimeReport {
  return {
    schemaVersion: CLIENT_RUNTIME_REPORT_SCHEMA_VERSION,
    evidenceLevel: "client-runtime-observation",
    scope: "client-adapter-harness",
    synthetic: false,
    adapter: { id: "vscode-github-copilot", version: "1.5.0" },
    targetClient: { id: "vscode-github-copilot", name: "VS Code/GitHub Copilot", version: "1.105.1" },
    requestedCapabilities: ["client-filesystem", "client-process", "network", "package-read"],
    grantedCapabilities: ["client-filesystem", "client-process", "network", "package-read"],
    execution: { status: "pass", complete: true, finalize: "complete" },
    packageInstall: "not-observed",
    clientLoad: "observed",
    mcpStartup: "observed",
    mcpHandshake: "observed",
    toolExposure: "observed",
    toolInvocation: "observed",
    interoperability: "scoped-established",
    interoperabilityScope: "named-client-version-mcp-tool-path",
    evidence: [{ code: "APCI-CLIENT-TEST-001", location: "client-runtime/test", summary: "Observed tool invocation." }],
    note: "Bounded source note.",
    ...overrides
  };
}

function runtimeInput(runtime: unknown = clientRuntime(), staticCertification: unknown = certifyPluginEvidence(base())) {
  return { staticCertification, clientRuntime: runtime };
}

describe("certifyPlugin", () => {
  it("certifies deterministically with pinned profiles and an explicit non-runtime claim", () => {
    const first = certifyPluginEvidence(base());
    const second = certifyPluginEvidence(base());
    expect(first).toEqual(second);
    expect(first.status).toBe("certified");
    expect(first.policy.compatibility.requiredProfiles).toEqual(REQUIRED_COMPATIBILITY_PROFILES);
    expect(first.runtimeEvidence).toMatchObject({ runtimeVerified: false, clientInstall: "not-assessed", mcpHandshake: "not-assessed" });
    expect(first.runtimeEvidence.note).toContain("does not prove runtime");
  });

  it("normalizes source evidence ordering deterministically", () => {
    const first = base();
    first.validation.warnings = ["plugin.json warning z", "plugin.json warning a"];
    first.security = security([finding("medium", "z evidence"), finding("low", "a evidence")]);
    const second = structuredClone(first);
    second.validation.warnings.reverse();
    second.security.findings.reverse();
    second.compatibility.profiles.reverse();
    expect(certifyPluginEvidence(first)).toEqual(certifyPluginEvidence(second));
  });

  it("fails validation errors and high or critical findings", () => {
    const validation = base();
    validation.validation = { ok: false, errors: ["bad manifest"], warnings: [] };
    expect(certifyPluginEvidence(validation).status).toBe("not-certified");
    expect(certifyPluginEvidence({ ...base(), security: security([finding("high")]) }).status).toBe("not-certified");
    expect(certifyPluginEvidence({ ...base(), security: security([finding("critical")]) }).status).toBe("not-certified");
  });

  it("keeps medium and lower findings non-blocking", () => {
    const report = certifyPluginEvidence({
      ...base(),
      validation: { ok: true, errors: [], warnings: ["plugin.json unknown top-level field: future"] },
      security: security([finding("medium"), finding("low"), finding("info")])
    });
    expect(report.status).toBe("certified");
    expect(report.checks.map((check) => check.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("returns unknown for incomplete security", () => {
    expect(certifyPluginEvidence({ ...base(), security: security([], false) }).status).toBe("unknown");
    expect(certifyPluginEvidence({ ...base(), security: security([finding("high")], false) }).status).toBe("not-certified");

    const malformed = { ...security(), findings: "not-an-array" } as unknown as SecurityScanResult;
    expect(certifyPluginEvidence({ ...base(), security: malformed }).status).toBe("unknown");

    const overBound = Array.from({ length: 501 }, () => finding("medium"));
    expect(certifyPluginEvidence({ ...base(), security: security(overBound) }).status).toBe("unknown");
  });

  it("fails ineligible compatibility and returns unknown for missing or incomplete evidence", () => {
    const ineligible = base();
    ineligible.compatibility.profiles[0]!.staticEligibility = "ineligible";
    expect(certifyPluginEvidence(ineligible).status).toBe("not-certified");
    const missing = base();
    missing.compatibility.profiles = missing.compatibility.profiles.slice(1);
    expect(certifyPluginEvidence(missing).status).toBe("unknown");
    const incomplete = base();
    incomplete.compatibility.profiles[0]!.complete = false;
    incomplete.compatibility.profiles[0]!.staticEligibility = "unknown";
    expect(certifyPluginEvidence(incomplete).status).toBe("unknown");

    const wrongSchema = base();
    wrongSchema.compatibility.schemaVersion = "future" as typeof wrongSchema.compatibility.schemaVersion;
    expect(certifyPluginEvidence(wrongSchema).status).toBe("unknown");

    const duplicate = base();
    duplicate.compatibility.profiles.push(structuredClone(duplicate.compatibility.profiles[0]!));
    expect(certifyPluginEvidence(duplicate).status).toBe("unknown");
  });

  it("redacts secrets, escapes controls, bounds evidence, and orders it deterministically", () => {
    const findings = Array.from({ length: 30 }, (_, index) => finding("high", `token=secret-${index}\n sk-proj-abcdefgh`));
    const report = certifyPluginEvidence({ ...base(), security: security(findings.reverse()) });
    const evidence = report.checks.find((item) => item.id === "APCI-CERT-SECURITY-001")!.evidence;
    expect(evidence).toHaveLength(8);
    expect(JSON.stringify(evidence)).not.toContain("secret-0");
    expect(JSON.stringify(evidence)).not.toContain("sk-proj-");
    expect(JSON.stringify(evidence)).toContain("\\\\u000a");
    expect(evidence.at(-1)?.summary).toContain("omitted");
    expect(evidence.every((item) => item.location.length <= 240 && item.summary.length <= 240)).toBe(true);
    const securityCheck = report.checks.find((item) => item.id === "APCI-CERT-SECURITY-001")!;
    expect(securityCheck.evidenceCount).toEqual({ observed: 30, included: 7, omitted: 23, capped: true });
  });

  it("redacts credential-bearing URLs and bearer values from every copied evidence field", () => {
    const sensitive = finding(
      "high",
      "Authorization: Bearer literal-secret https://user:pass@example.com/path?api_key=query-secret"
    );
    sensitive.location = "token=location-secret\nnext";
    sensitive.remediation = "password=remediation-secret";
    const serialized = JSON.stringify(certifyPluginEvidence({ ...base(), security: security([sensitive]) }));
    expect(serialized).not.toContain("literal-secret");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("location-secret");
    expect(serialized).not.toContain("remediation-secret");
    expect(serialized).toContain("\\\\u000a");
  });
});

describe("certifyRuntimeEvidence", () => {
  it("certifies only the named client-version MCP tool path and treats package installation as non-blocking", () => {
    const report = certifyRuntimeEvidence(runtimeInput());
    expect(report.status).toBe("certified");
    expect(report.complete).toBe(true);
    expect(report.scope).toBe(SCOPED_RUNTIME_CERTIFICATION_SCOPE);
    expect(report.targetClient).toEqual({ id: "vscode-github-copilot", name: "VS Code/GitHub Copilot", version: "1.105.1" });
    expect(report.packageInstall).toBe("not-observed");
    expect(report.checks.map((check) => check.status)).toEqual(["pass", "pass"]);
    expect(report.schemaVersion).toBe(RUNTIME_CERTIFICATION_REPORT_SCHEMA_VERSION);
    expect(report.certification.id).toBe(SCOPED_RUNTIME_CERTIFICATION_ID);
    expect(report.policy.id).toBe(SCOPED_RUNTIME_CERTIFICATION_POLICY_ID);
    expect(report.policy.id).not.toBe(STATIC_PORTABILITY_CERTIFICATION_ID);
    expect(report.policy.clientRuntime.packageInstall).toBe("reported-non-blocking");
    expect(report.note).toContain("Installation");
    expect(report.note).toContain("other-client");
    expect(report.note).toContain("other-tool");
  });

  it("never certifies synthetic, incomplete, or finalization-failed runtime evidence", () => {
    const synthetic = clientRuntime({
      synthetic: true,
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    expect(certifyRuntimeEvidence(runtimeInput(synthetic)).status).toBe("not-certified");

    const incomplete = clientRuntime({
      execution: { status: "pass", complete: false, finalize: "complete" },
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    expect(certifyRuntimeEvidence(runtimeInput(incomplete)).status).toBe("not-certified");

    const finalizeFailed = clientRuntime({
      execution: { status: "pass", complete: false, finalize: "failed" },
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    expect(certifyRuntimeEvidence(runtimeInput(finalizeFailed)).status).toBe("not-certified");

    const missingObservation = clientRuntime({
      mcpHandshake: "not-observed",
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    expect(certifyRuntimeEvidence(runtimeInput(missingObservation)).status).toBe("not-certified");
  });

  it("requires a complete successful current static certification", () => {
    const staticFailure = certifyPluginEvidence({
      ...base(),
      validation: { ok: false, errors: ["invalid"], warnings: [] }
    });
    expect(certifyRuntimeEvidence(runtimeInput(clientRuntime(), staticFailure)).status).toBe("not-certified");

    const stale = structuredClone(certifyPluginEvidence(base())) as unknown as Record<string, unknown>;
    stale.schemaVersion = "0.9.0";
    expect(certifyRuntimeEvidence(runtimeInput(clientRuntime(), stale)).status).toBe("unknown");

    const staticUnknown = certifyPluginEvidence({ ...base(), security: security([], false) });
    expect(certifyRuntimeEvidence(runtimeInput(clientRuntime(), staticUnknown)).status).toBe("unknown");

    const absentRuntime = certifyRuntimeEvidence({
      staticCertification: certifyPluginEvidence(base()),
      clientRuntime: undefined
    });
    expect(absentRuntime.status).toBe("unknown");
    expect(absentRuntime.scope).toBe("none");
    expect(absentRuntime.packageInstall).toBe("not-assessed");
  });

  it("fails closed for malformed, stale, inconsistent, or over-bound runtime reports", () => {
    expect(certifyRuntimeEvidence(runtimeInput({ schemaVersion: CLIENT_RUNTIME_REPORT_SCHEMA_VERSION })).status).toBe("unknown");
    expect(certifyRuntimeEvidence(runtimeInput({ ...clientRuntime(), schemaVersion: "future" })).status).toBe("unknown");
    expect(certifyRuntimeEvidence(runtimeInput({
      ...clientRuntime(),
      targetClient: { id: "vscode-github-copilot", name: "VS Code", version: undefined }
    })).status).toBe("unknown");
    expect(certifyRuntimeEvidence(runtimeInput({
      ...clientRuntime(),
      targetClient: { id: "vscode-github-copilot", name: "VS Code", version: "unknown" }
    })).status).toBe("unknown");
    expect(certifyRuntimeEvidence(runtimeInput({
      ...clientRuntime(),
      evidence: Array.from({ length: 9 }, (_, index) => ({
        code: `APCI-CLIENT-TEST-${String(index).padStart(3, "0")}`,
        location: "test",
        summary: "bounded"
      }))
    })).status).toBe("unknown");
    expect(certifyRuntimeEvidence(runtimeInput({
      ...clientRuntime(),
      evidence: [{ code: "APCI-CLIENT-TEST-001", location: "test", summary: 42 }]
    })).status).toBe("unknown");
    expect(certifyRuntimeEvidence(runtimeInput(clientRuntime({
      evidence: [{ code: "APCI-CLIENT-TEST-001", location: "test", summary: "x".repeat(241) }]
    }))).status).toBe("unknown");
  });

  it.each(["clientLoad", "mcpStartup", "mcpHandshake", "toolExposure", "toolInvocation"] as const)(
    "rejects runtime certification when %s is not observed",
    (field) => {
      const report = clientRuntime({
        [field]: "not-observed",
        interoperability: "not-established",
        interoperabilityScope: "none"
      });
      expect(certifyRuntimeEvidence(runtimeInput(report)).status).toBe("not-certified");
    }
  );

  it("rejects interoperability that is not established or has no scoped claim", () => {
    const notEstablished = clientRuntime({
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    const result = certifyRuntimeEvidence(runtimeInput(notEstablished));
    expect(result.status).toBe("not-certified");
    expect(result.scope).toBe("none");

    const inconsistentScope = clientRuntime({ interoperabilityScope: "none" });
    const inconsistentResult = certifyRuntimeEvidence(runtimeInput(inconsistentScope));
    expect(inconsistentResult.status).toBe("unknown");
    expect(inconsistentResult.scope).toBe("none");
  });

  it("normalizes runtime evidence deterministically and redacts secrets and controls", () => {
    const source = clientRuntime({
      evidence: [
        { code: "APCI-CLIENT-TEST-002", location: "z\nlocation", summary: "token=literal-secret" },
        { code: "APCI-CLIENT-TEST-001", location: "a", summary: "Authorization: Bearer another-secret" }
      ]
    });
    const first = certifyRuntimeEvidence(runtimeInput(source));
    source.evidence.reverse();
    const second = certifyRuntimeEvidence(runtimeInput(source));
    expect(first).toEqual(second);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("literal-secret");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).toContain("\\\\u000a");
    expect(first.status).toBe("unknown");
    expect(first.scope).toBe("none");
    expect(first.runtimeEvidence).toHaveLength(2);
    expect(first.runtimeEvidence.every((item) => item.location.length <= 240 && item.summary.length <= 240)).toBe(true);
  });

  it("requires exact declared capability grants while preserving packageInstall independently", () => {
    const mismatch = clientRuntime({
      grantedCapabilities: ["client-filesystem", "client-process", "package-read"],
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    const report = certifyRuntimeEvidence(runtimeInput(mismatch));
    expect(report.status).toBe("not-certified");
    expect(report.packageInstall).toBe("not-observed");
    expect(report.checks[1]?.evidence.some((item) => item.location === "client-runtime/capabilities")).toBe(true);
  });

  it("bounds and accounts for failed runtime requirement evidence deterministically", () => {
    const report = certifyRuntimeEvidence(runtimeInput(clientRuntime({
      synthetic: true,
      targetClient: { id: "fixture", name: "Fixture" },
      execution: { status: "denied", complete: false, finalize: "not-run" },
      clientLoad: "not-observed",
      mcpStartup: "not-observed",
      mcpHandshake: "not-observed",
      toolExposure: "not-observed",
      toolInvocation: "not-observed",
      interoperability: "not-established",
      interoperabilityScope: "none"
    })));
    const runtimeCheck = report.checks[1]!;
    expect(runtimeCheck.status).toBe("fail");
    expect(runtimeCheck.evidence).toHaveLength(8);
    expect(runtimeCheck.evidence.at(-1)?.summary).toContain("omitted");
    expect(runtimeCheck.evidenceCount.capped).toBe(true);
    expect(runtimeCheck.evidenceCount.observed).toBeGreaterThan(runtimeCheck.evidenceCount.included);
  });
});
