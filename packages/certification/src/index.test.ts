import { describe, expect, it } from "vitest";
import { assessPluginCompatibility, COPILOT_PROFILE_ID, CURSOR_PROFILE_ID, PORTABLE_CORE_PROFILE_ID } from "@agent-plugin-ci/compatibility";
import type { SecurityFinding, SecurityScanResult } from "@agent-plugin-ci/security";
import { certifyPluginEvidence, REQUIRED_COMPATIBILITY_PROFILES, type CertificationEvidenceInput } from "./index.js";

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
