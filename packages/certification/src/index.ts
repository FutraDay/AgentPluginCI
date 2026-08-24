import {
  CLIENT_RUNTIME_REPORT_SCHEMA_VERSION,
  COMPATIBILITY_REPORT_SCHEMA_VERSION,
  COPILOT_PROFILE_ID,
  CURSOR_PROFILE_ID,
  PORTABLE_CORE_PROFILE_ID,
  parseClientRuntimeReport,
  type ClientRuntimeCapability,
  type ClientRuntimeEvidence,
  type ClientRuntimeExecutionStatus,
  type ClientRuntimeFinalizeStatus,
  type ClientRuntimeInteroperability,
  type ClientRuntimeInteroperabilityScope,
  type ClientRuntimeObservationStatus,
  type CompatibilityProfileReport,
  type CompatibilitySuiteReport
} from "@agent-plugin-ci/compatibility";
import type { SecurityFinding, SecurityScanResult, SecuritySeverity } from "@agent-plugin-ci/security";
import type { ValidationResult } from "@agent-plugin-ci/validator";

export const CERTIFICATION_REPORT_SCHEMA_VERSION = "1.0.0";
export const STATIC_PORTABILITY_CERTIFICATION_ID = "APCI-CERT-STATIC-PORTABILITY";
export const STATIC_PORTABILITY_CERTIFICATION_VERSION = "1.0.0";
export const CERTIFICATION_CHECK_VERSION = "1.0.0";

export const CERTIFICATION_CHECK_IDS = Object.freeze({
  validation: "APCI-CERT-VALIDATION-001",
  security: "APCI-CERT-SECURITY-001",
  compatibility: "APCI-CERT-COMPATIBILITY-001"
} as const);

export interface RequiredCompatibilityProfile {
  id: string;
  version: string;
}

export interface StaticPortabilityPolicy {
  id: typeof STATIC_PORTABILITY_CERTIFICATION_ID;
  version: typeof STATIC_PORTABILITY_CERTIFICATION_VERSION;
  title: string;
  validation: { errors: "fail"; warnings: "non-blocking" };
  security: { failOn: "high"; incomplete: "unknown" };
  compatibility: { requiredProfiles: readonly RequiredCompatibilityProfile[] };
}

export const REQUIRED_COMPATIBILITY_PROFILES: readonly RequiredCompatibilityProfile[] = Object.freeze([
  Object.freeze({ id: PORTABLE_CORE_PROFILE_ID, version: "1.0.0" }),
  Object.freeze({ id: CURSOR_PROFILE_ID, version: "1.0.0" }),
  Object.freeze({ id: COPILOT_PROFILE_ID, version: "1.0.0" })
]);

export const REQUIRED_COMPATIBILITY_PROFILE_IDS: readonly string[] = Object.freeze(
  REQUIRED_COMPATIBILITY_PROFILES.map((profile) => profile.id)
);

export const STATIC_PORTABILITY_POLICY: Readonly<StaticPortabilityPolicy> = Object.freeze({
  id: STATIC_PORTABILITY_CERTIFICATION_ID,
  version: STATIC_PORTABILITY_CERTIFICATION_VERSION,
  title: "Agent Plugins 1.0 static portability certification",
  validation: Object.freeze({ errors: "fail", warnings: "non-blocking" }),
  security: Object.freeze({ failOn: "high", incomplete: "unknown" }),
  compatibility: Object.freeze({ requiredProfiles: REQUIRED_COMPATIBILITY_PROFILES })
});

export type CertificationStatus = "certified" | "not-certified" | "unknown";
export type CertificationCheckStatus = "pass" | "fail" | "unknown";

export interface CertificationEvidence {
  location: string;
  summary: string;
  remediation?: string;
}

export interface CertificationCheckResult {
  id: (typeof CERTIFICATION_CHECK_IDS)[keyof typeof CERTIFICATION_CHECK_IDS];
  version: typeof CERTIFICATION_CHECK_VERSION;
  title: string;
  status: CertificationCheckStatus;
  evidenceCount: { observed: number; included: number; omitted: number; capped: boolean };
  evidence: CertificationEvidence[];
}

export interface CertificationRuntimeEvidence {
  runtimeVerified: false;
  clientInstall: "not-assessed";
  mcpHandshake: "not-assessed";
  note: string;
}

export interface CertificationEvidenceInput {
  validation: ValidationResult;
  security: SecurityScanResult;
  compatibility: CompatibilitySuiteReport;
}

export interface CertificationReport {
  schemaVersion: typeof CERTIFICATION_REPORT_SCHEMA_VERSION;
  certification: {
    id: typeof STATIC_PORTABILITY_CERTIFICATION_ID;
    version: typeof STATIC_PORTABILITY_CERTIFICATION_VERSION;
    title: string;
  };
  policy: Readonly<StaticPortabilityPolicy>;
  status: CertificationStatus;
  complete: boolean;
  summary: { pass: number; fail: number; unknown: number; total: number };
  checks: CertificationCheckResult[];
  runtimeEvidence: CertificationRuntimeEvidence;
}

const MAX_COPIED_ITEMS = 500;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_TEXT_INPUT_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 240;
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

export function certifyPluginEvidence(input: CertificationEvidenceInput): CertificationReport {
  const checks = [
    validationCheck(readField(input, "validation") as ValidationResult),
    securityCheck(readField(input, "security") as SecurityScanResult),
    compatibilityCheck(readField(input, "compatibility") as CompatibilitySuiteReport)
  ];
  const status: CertificationStatus = checks.some((check) => check.status === "fail")
    ? "not-certified"
    : checks.some((check) => check.status === "unknown") ? "unknown" : "certified";
  const summary = {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    unknown: checks.filter((check) => check.status === "unknown").length,
    total: checks.length
  };

  return {
    schemaVersion: CERTIFICATION_REPORT_SCHEMA_VERSION,
    certification: {
      id: STATIC_PORTABILITY_CERTIFICATION_ID,
      version: STATIC_PORTABILITY_CERTIFICATION_VERSION,
      title: STATIC_PORTABILITY_POLICY.title
    },
    policy: STATIC_PORTABILITY_POLICY,
    status,
    complete: summary.unknown === 0,
    summary,
    checks,
    runtimeEvidence: {
      runtimeVerified: false,
      clientInstall: "not-assessed",
      mcpHandshake: "not-assessed",
      note: "Static certification does not prove runtime interoperability, client installation, MCP startup, or MCP handshake success."
    }
  };
}

export const certifyPlugin = certifyPluginEvidence;

export const RUNTIME_CERTIFICATION_REPORT_SCHEMA_VERSION = "1.0.0";
export const SCOPED_RUNTIME_CERTIFICATION_ID = "APCI-CERT-RUNTIME-NAMED-CLIENT-MCP-TOOL";
export const SCOPED_RUNTIME_CERTIFICATION_VERSION = "1.0.0";
export const SCOPED_RUNTIME_CERTIFICATION_POLICY_ID = "APCI-POLICY-RUNTIME-NAMED-CLIENT-MCP-TOOL";
export const SCOPED_RUNTIME_CERTIFICATION_POLICY_VERSION = "1.0.0";
export const SCOPED_RUNTIME_CERTIFICATION_SCOPE = "named-client-version-mcp-tool-path" as const;
export const RUNTIME_CERTIFICATION_CHECK_VERSION = "1.0.0";

export const RUNTIME_CERTIFICATION_CHECK_IDS = Object.freeze({
  staticCertification: "APCI-CERT-RUNTIME-STATIC-001",
  clientRuntime: "APCI-CERT-RUNTIME-EVIDENCE-001"
} as const);

export interface ScopedRuntimeCertificationPolicy {
  id: typeof SCOPED_RUNTIME_CERTIFICATION_POLICY_ID;
  version: typeof SCOPED_RUNTIME_CERTIFICATION_POLICY_VERSION;
  title: string;
  scope: typeof SCOPED_RUNTIME_CERTIFICATION_SCOPE;
  staticCertification: {
    schemaVersion: typeof CERTIFICATION_REPORT_SCHEMA_VERSION;
    certificationId: typeof STATIC_PORTABILITY_CERTIFICATION_ID;
    certificationVersion: typeof STATIC_PORTABILITY_CERTIFICATION_VERSION;
    requiredStatus: "certified";
    complete: true;
  };
  clientRuntime: {
    schemaVersion: typeof CLIENT_RUNTIME_REPORT_SCHEMA_VERSION;
    synthetic: false;
    executionStatus: "pass";
    executionComplete: true;
    finalize: "complete";
    concreteTargetClientVersion: true;
    interoperability: "scoped-established";
    interoperabilityScope: typeof SCOPED_RUNTIME_CERTIFICATION_SCOPE;
    requiredObservations: readonly ["clientLoad", "mcpStartup", "mcpHandshake", "toolExposure", "toolInvocation"];
    exactCapabilityGrants: true;
    boundedEvidence: true;
    packageInstall: "reported-non-blocking";
  };
}

export const SCOPED_RUNTIME_CERTIFICATION_POLICY: Readonly<ScopedRuntimeCertificationPolicy> = Object.freeze({
  id: SCOPED_RUNTIME_CERTIFICATION_POLICY_ID,
  version: SCOPED_RUNTIME_CERTIFICATION_POLICY_VERSION,
  title: "Named client version MCP tool-path runtime certification",
  scope: SCOPED_RUNTIME_CERTIFICATION_SCOPE,
  staticCertification: Object.freeze({
    schemaVersion: CERTIFICATION_REPORT_SCHEMA_VERSION,
    certificationId: STATIC_PORTABILITY_CERTIFICATION_ID,
    certificationVersion: STATIC_PORTABILITY_CERTIFICATION_VERSION,
    requiredStatus: "certified",
    complete: true
  }),
  clientRuntime: Object.freeze({
    schemaVersion: CLIENT_RUNTIME_REPORT_SCHEMA_VERSION,
    synthetic: false,
    executionStatus: "pass",
    executionComplete: true,
    finalize: "complete",
    concreteTargetClientVersion: true,
    interoperability: "scoped-established",
    interoperabilityScope: SCOPED_RUNTIME_CERTIFICATION_SCOPE,
    requiredObservations: Object.freeze(["clientLoad", "mcpStartup", "mcpHandshake", "toolExposure", "toolInvocation"] as const),
    exactCapabilityGrants: true,
    boundedEvidence: true,
    packageInstall: "reported-non-blocking"
  })
});

export interface RuntimeCertificationEvidenceInput {
  staticCertification: unknown;
  clientRuntime?: unknown;
}

export interface RuntimeCertificationCheckResult {
  id: (typeof RUNTIME_CERTIFICATION_CHECK_IDS)[keyof typeof RUNTIME_CERTIFICATION_CHECK_IDS];
  version: typeof RUNTIME_CERTIFICATION_CHECK_VERSION;
  title: string;
  status: CertificationCheckStatus;
  evidenceCount: { observed: number; included: number; omitted: number; capped: boolean };
  evidence: CertificationEvidence[];
}

export interface RuntimeCertificationReport {
  schemaVersion: typeof RUNTIME_CERTIFICATION_REPORT_SCHEMA_VERSION;
  certification: {
    id: typeof SCOPED_RUNTIME_CERTIFICATION_ID;
    version: typeof SCOPED_RUNTIME_CERTIFICATION_VERSION;
    title: string;
  };
  policy: Readonly<ScopedRuntimeCertificationPolicy>;
  status: CertificationStatus;
  complete: boolean;
  scope: typeof SCOPED_RUNTIME_CERTIFICATION_SCOPE | "none";
  summary: { pass: number; fail: number; unknown: number; total: number };
  checks: RuntimeCertificationCheckResult[];
  staticCertification: {
    schemaVersion: string;
    id: string;
    version: string;
    status: CertificationStatus | "invalid";
    complete: boolean;
  };
  clientRuntimeSchemaVersion: string;
  adapter: { id: string; version: string; synthetic: boolean | "unknown" };
  targetClient: { id: string; name: string; version?: string };
  requestedCapabilities: ClientRuntimeCapability[];
  grantedCapabilities: ClientRuntimeCapability[];
  execution: { status: ClientRuntimeExecutionStatus | "invalid"; complete: boolean; finalize: ClientRuntimeFinalizeStatus | "invalid" };
  packageInstall: ClientRuntimeObservationStatus;
  clientLoad: ClientRuntimeObservationStatus;
  mcpStartup: ClientRuntimeObservationStatus;
  mcpHandshake: ClientRuntimeObservationStatus;
  toolExposure: ClientRuntimeObservationStatus;
  toolInvocation: ClientRuntimeObservationStatus;
  interoperability: ClientRuntimeInteroperability | "invalid";
  interoperabilityScope: ClientRuntimeInteroperabilityScope | "invalid";
  runtimeEvidence: ClientRuntimeEvidence[];
  note: string;
}

export type ScopedRuntimeCertificationReport = RuntimeCertificationReport;

export const RUNTIME_CERTIFICATION_NON_UNIVERSAL_CLAIM_NOTE = "Certification is limited to the named client version and observed MCP tool path. Installation of the package is independent and is not certified or implied. Universal interoperability, other-client interoperability, and other-tool interoperability are not implied.";

export function certifyRuntimeEvidence(input: RuntimeCertificationEvidenceInput): RuntimeCertificationReport {
  const staticResult = evaluateStaticCertification(readField(input, "staticCertification"));
  const runtimeResult = evaluateClientRuntime(readField(input, "clientRuntime"));
  const checks = [staticResult.check, runtimeResult.check];
  const status: CertificationStatus = checks.some((candidate) => candidate.status === "fail")
    ? "not-certified"
    : checks.some((candidate) => candidate.status === "unknown") ? "unknown" : "certified";
  const summary = {
    pass: checks.filter((candidate) => candidate.status === "pass").length,
    fail: checks.filter((candidate) => candidate.status === "fail").length,
    unknown: checks.filter((candidate) => candidate.status === "unknown").length,
    total: checks.length
  };

  return {
    schemaVersion: RUNTIME_CERTIFICATION_REPORT_SCHEMA_VERSION,
    certification: {
      id: SCOPED_RUNTIME_CERTIFICATION_ID,
      version: SCOPED_RUNTIME_CERTIFICATION_VERSION,
      title: SCOPED_RUNTIME_CERTIFICATION_POLICY.title
    },
    policy: SCOPED_RUNTIME_CERTIFICATION_POLICY,
    status,
    complete: summary.unknown === 0,
    scope: status === "certified" ? SCOPED_RUNTIME_CERTIFICATION_SCOPE : "none",
    summary,
    checks,
    staticCertification: staticResult.snapshot,
    ...runtimeResult.snapshot,
    note: RUNTIME_CERTIFICATION_NON_UNIVERSAL_CLAIM_NOTE
  };
}

export const certifyScopedRuntimeEvidence = certifyRuntimeEvidence;
export const certifyRuntime = certifyRuntimeEvidence;

function evaluateStaticCertification(raw: unknown): {
  check: RuntimeCertificationCheckResult;
  snapshot: RuntimeCertificationReport["staticCertification"];
} {
  const schemaVersion = safeString(readField(raw, "schemaVersion"));
  const certification = readField(raw, "certification");
  const id = safeString(readField(certification, "id"));
  const version = safeString(readField(certification, "version"));
  const rawStatus = readField(raw, "status");
  const rawComplete = readField(raw, "complete");
  const status = rawStatus === "certified" || rawStatus === "not-certified" || rawStatus === "unknown"
    ? rawStatus : "invalid";
  const structurallyCurrent = validCurrentStaticCertification(raw);
  const checkStatus: CertificationCheckStatus = structurallyCurrent && status === "not-certified"
    ? "fail"
    : structurallyCurrent && status === "certified" && rawComplete === true ? "pass" : "unknown";
  const candidates: CertificationEvidence[] = [{
    location: "static-certification",
    summary: checkStatus === "pass"
      ? "The current static portability certification is complete and certified."
      : checkStatus === "fail"
        ? "The static portability certification is not certified."
        : "A complete successful current static portability certificate was not provided.",
    ...(checkStatus === "pass" ? {} : { remediation: "Complete current static certification successfully before runtime certification." })
  }];
  return {
    check: runtimeCheck(RUNTIME_CERTIFICATION_CHECK_IDS.staticCertification, "Current static portability certification", checkStatus, candidates),
    snapshot: {
      schemaVersion: safeText(schemaVersion || "invalid"),
      id: safeText(id || "invalid"),
      version: safeText(version || "invalid"),
      status,
      complete: rawComplete === true
    }
  };
}

function validCurrentStaticCertification(raw: unknown): boolean {
  if (!isRecord(raw)
    || raw.schemaVersion !== CERTIFICATION_REPORT_SCHEMA_VERSION
    || !isRecord(raw.certification)
    || raw.certification.id !== STATIC_PORTABILITY_CERTIFICATION_ID
    || raw.certification.version !== STATIC_PORTABILITY_CERTIFICATION_VERSION
    || !isRecord(raw.policy)
    || raw.policy.id !== STATIC_PORTABILITY_CERTIFICATION_ID
    || raw.policy.version !== STATIC_PORTABILITY_CERTIFICATION_VERSION
    || !isRecord(raw.policy.validation)
    || raw.policy.validation.errors !== "fail"
    || raw.policy.validation.warnings !== "non-blocking"
    || !isRecord(raw.policy.security)
    || raw.policy.security.failOn !== "high"
    || raw.policy.security.incomplete !== "unknown"
    || !isRecord(raw.policy.compatibility)
    || !sameRequiredCompatibilityProfiles(raw.policy.compatibility.requiredProfiles)
    || !Array.isArray(raw.checks)
    || raw.checks.length !== Object.keys(CERTIFICATION_CHECK_IDS).length
    || !isRecord(raw.summary)
    || !isRecord(raw.runtimeEvidence)
    || raw.runtimeEvidence.runtimeVerified !== false) return false;
  const expected = Object.values(CERTIFICATION_CHECK_IDS).sort(compareText);
  const statuses: CertificationCheckStatus[] = [];
  const actual = raw.checks.map((candidate) => {
    if (!isRecord(candidate)
      || candidate.version !== CERTIFICATION_CHECK_VERSION
      || (candidate.status !== "pass" && candidate.status !== "fail" && candidate.status !== "unknown")
      || typeof candidate.id !== "string") return "";
    statuses.push(candidate.status);
    return candidate.id;
  }).sort(compareText);
  if (!actual.every((candidate, index) => candidate === expected[index])) return false;
  const derivedStatus: CertificationStatus = statuses.includes("fail")
    ? "not-certified"
    : statuses.includes("unknown") ? "unknown" : "certified";
  const pass = statuses.filter((candidate) => candidate === "pass").length;
  const fail = statuses.filter((candidate) => candidate === "fail").length;
  const unknown = statuses.filter((candidate) => candidate === "unknown").length;
  return raw.status === derivedStatus
    && raw.complete === (unknown === 0)
    && raw.summary.pass === pass
    && raw.summary.fail === fail
    && raw.summary.unknown === unknown
    && raw.summary.total === statuses.length;
}

function sameRequiredCompatibilityProfiles(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length !== REQUIRED_COMPATIBILITY_PROFILES.length) return false;
  return raw.every((candidate, index) => isRecord(candidate)
    && candidate.id === REQUIRED_COMPATIBILITY_PROFILES[index]?.id
    && candidate.version === REQUIRED_COMPATIBILITY_PROFILES[index]?.version);
}

function evaluateClientRuntime(raw: unknown): {
  check: RuntimeCertificationCheckResult;
  snapshot: Omit<RuntimeCertificationReport,
    "schemaVersion" | "certification" | "policy" | "status" | "complete" | "scope" | "summary" | "checks" | "staticCertification" | "note">;
} {
  if (raw === undefined) {
    return {
      check: runtimeCheck(
        RUNTIME_CERTIFICATION_CHECK_IDS.clientRuntime,
        "Bounded real-client MCP tool-path evidence",
        "unknown",
        [{
          location: "client-runtime",
          summary: "No client runtime report was collected, so no scoped runtime claim can be made."
        }],
        0
      ),
      snapshot: emptyRuntimeSnapshot("not-assessed")
    };
  }
  let report;
  try {
    report = parseClientRuntimeReport(raw);
  } catch {
    return {
      check: runtimeCheck(
        RUNTIME_CERTIFICATION_CHECK_IDS.clientRuntime,
        "Bounded real-client MCP tool-path evidence",
        "unknown",
        [{
          location: "client-runtime",
          summary: "Client runtime evidence was malformed, incomplete, stale, or outside processing bounds.",
          remediation: "Generate a complete current ClientRuntimeReport with the official client harness."
        }]
      ),
      snapshot: emptyRuntimeSnapshot()
    };
  }

  const evidenceClaimSafe = runtimeEvidenceIsClaimSafe(raw);

  const exactCapabilities = report.requestedCapabilities.length === report.grantedCapabilities.length
    && report.requestedCapabilities.every((capability, index) => report.grantedCapabilities[index] === capability);
  const observations = [report.clientLoad, report.mcpStartup, report.mcpHandshake, report.toolExposure, report.toolInvocation];
  const positive = report.synthetic === false
    && report.execution.status === "pass"
    && report.execution.complete
    && report.execution.finalize === "complete"
    && report.targetClient.version !== undefined
    && report.interoperability === "scoped-established"
    && report.interoperabilityScope === SCOPED_RUNTIME_CERTIFICATION_SCOPE
    && observations.every((observation) => observation === "observed")
    && exactCapabilities
    && report.evidence.length > 0
    && evidenceClaimSafe;
  const definiteFailure = report.synthetic
    || report.execution.status === "fail"
    || report.execution.status === "timeout"
    || report.execution.status === "denied"
    || report.interoperability === "not-established"
    || observations.some((observation) => observation === "not-observed")
    || !exactCapabilities;
  const checkStatus: CertificationCheckStatus = positive ? "pass" : !evidenceClaimSafe ? "unknown" : definiteFailure ? "fail" : "unknown";
  const candidates = !evidenceClaimSafe
    ? [{
        location: "client-runtime/evidence",
        summary: "Runtime evidence required redaction, control escaping, truncation, or exceeded certification claim bounds and was rejected for claim promotion.",
        remediation: "Generate fresh bounded evidence without credentials, control characters, or oversized fields."
      }]
    : runtimeRequirementEvidence(report, exactCapabilities, checkStatus);
  return {
    check: runtimeCheck(
      RUNTIME_CERTIFICATION_CHECK_IDS.clientRuntime,
      "Bounded real-client MCP tool-path evidence",
      checkStatus,
      candidates,
      Math.max(report.evidence.length, candidates.length)
    ),
    snapshot: {
      clientRuntimeSchemaVersion: report.schemaVersion,
      adapter: { ...report.adapter, synthetic: report.synthetic },
      targetClient: { ...report.targetClient },
      requestedCapabilities: [...report.requestedCapabilities],
      grantedCapabilities: [...report.grantedCapabilities],
      execution: { ...report.execution },
      packageInstall: report.packageInstall,
      clientLoad: report.clientLoad,
      mcpStartup: report.mcpStartup,
      mcpHandshake: report.mcpHandshake,
      toolExposure: report.toolExposure,
      toolInvocation: report.toolInvocation,
      interoperability: report.interoperability,
      interoperabilityScope: report.interoperabilityScope,
      runtimeEvidence: report.evidence.map((item) => ({ ...item }))
    }
  };
}

function runtimeEvidenceIsClaimSafe(raw: unknown): boolean {
  try {
    const items = readField(raw, "evidence");
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_EVIDENCE_ITEMS) return false;
    return items.every((candidate) => {
      const code = readField(candidate, "code");
      const location = readField(candidate, "location");
      const summary = readField(candidate, "summary");
      const remediation = readField(candidate, "remediation");
      if (typeof code !== "string" || !/^APCI-[A-Z0-9-]{3,80}$/.test(code)
        || typeof location !== "string" || typeof summary !== "string"
        || (remediation !== undefined && typeof remediation !== "string")) return false;
      const text = remediation === undefined ? [location, summary] : [location, summary, remediation];
      return text.every((value) => value.length > 0
        && value.length <= MAX_TEXT_LENGTH
        && !/[\u0000-\u001f\u007f]/.test(value)
        && redactSensitiveText(value) === value);
    });
  } catch {
    return false;
  }
}

function runtimeRequirementEvidence(
  report: ReturnType<typeof parseClientRuntimeReport>,
  exactCapabilities: boolean,
  status: CertificationCheckStatus
): CertificationEvidence[] {
  if (status === "pass") {
    return [{
      location: `client-runtime/${report.targetClient.id}@${report.targetClient.version}`,
      summary: "A real adapter produced complete scoped interoperability evidence for the named client version and MCP tool path. Package installation is reported separately and is non-blocking."
    }];
  }
  const candidates: CertificationEvidence[] = [];
  const add = (condition: boolean, location: string, summary: string) => {
    if (!condition) candidates.push({ location, summary, remediation: "Generate fresh complete evidence with the official real-client harness and all exact capability grants." });
  };
  add(!report.synthetic, "client-runtime/adapter", "Synthetic adapter evidence can never receive scoped runtime certification.");
  add(report.execution.status === "pass" && report.execution.complete, "client-runtime/execution", "Client execution must pass and be complete.");
  add(report.execution.finalize === "complete", "client-runtime/finalize", "Client finalization must complete.");
  add(report.targetClient.version !== undefined, "client-runtime/target-client", "A concrete target client version is required.");
  add(report.interoperability === "scoped-established", "client-runtime/interoperability", "Scoped interoperability must be established.");
  add(report.interoperabilityScope === SCOPED_RUNTIME_CERTIFICATION_SCOPE, "client-runtime/interoperability-scope", "Interoperability scope must be the named client version MCP tool path.");
  for (const [name, observation] of ([
    ["client-load", report.clientLoad],
    ["mcp-startup", report.mcpStartup],
    ["mcp-handshake", report.mcpHandshake],
    ["tool-exposure", report.toolExposure],
    ["tool-invocation", report.toolInvocation]
  ] as const)) add(observation === "observed", `client-runtime/${name}`, `${name} must be observed.`);
  add(exactCapabilities, "client-runtime/capabilities", "Granted capabilities must exactly match the adapter request.");
  add(report.evidence.length > 0, "client-runtime/evidence", "Bounded runtime evidence is required.");
  return candidates.length > 0 ? candidates : [{
    location: "client-runtime",
    summary: "Runtime evidence did not establish every scoped certification requirement.",
    remediation: "Generate fresh complete evidence with the official real-client harness."
  }];
}

function emptyRuntimeSnapshot(
  observation: ClientRuntimeObservationStatus = "unknown"
): ReturnType<typeof evaluateClientRuntime>["snapshot"] {
  return {
    clientRuntimeSchemaVersion: "invalid",
    adapter: { id: "unknown", version: "unknown", synthetic: "unknown" },
    targetClient: { id: "unknown", name: "Unknown client" },
    requestedCapabilities: [],
    grantedCapabilities: [],
    execution: { status: "invalid", complete: false, finalize: "invalid" },
    packageInstall: observation,
    clientLoad: observation,
    mcpStartup: observation,
    mcpHandshake: observation,
    toolExposure: observation,
    toolInvocation: observation,
    interoperability: "invalid",
    interoperabilityScope: "invalid",
    runtimeEvidence: []
  };
}

function runtimeCheck(
  id: RuntimeCertificationCheckResult["id"],
  title: string,
  status: CertificationCheckStatus,
  evidence: CertificationEvidence[],
  observed = evidence.length
): RuntimeCertificationCheckResult {
  const normalized = check(id as CertificationCheckResult["id"], title, status, evidence, observed);
  return { ...normalized, id, version: RUNTIME_CERTIFICATION_CHECK_VERSION };
}

function validationCheck(validation: ValidationResult): CertificationCheckResult {
  const errors = normalizedStrings(readField(validation, "errors"));
  const warnings = normalizedStrings(readField(validation, "warnings"));
  const ok = readField(validation, "ok");
  const status: CertificationCheckStatus = errors.observed > 0
    ? "fail"
    : errors.valid && warnings.valid && ok === true ? "pass" : "unknown";
  const candidates: CertificationEvidence[] = [];

  for (const error of errors.values.sort(compareText)) {
    candidates.push({
      location: validationLocation(error),
      summary: error,
      remediation: "Resolve the official validation error and generate fresh certification evidence."
    });
  }
  for (const warning of warnings.values.sort(compareText)) {
    candidates.push({
      location: validationLocation(warning),
      summary: `Non-blocking validation warning: ${warning}`
    });
  }
  if (candidates.length === 0) {
    candidates.push({
      location: "validation",
      summary: status === "pass"
        ? "Official validation completed without errors; warnings are non-blocking under this policy."
        : "Official validation did not provide complete pass or failure evidence.",
      ...(status === "unknown" ? { remediation: "Run official validation again and provide a complete ValidationResult." } : {})
    });
  }
  return check(
    CERTIFICATION_CHECK_IDS.validation,
    "Official Agent Plugins 1.0 validation",
    status,
    candidates,
    errors.observed + warnings.observed,
    errors.capped || warnings.capped
  );
}

function securityCheck(security: SecurityScanResult): CertificationCheckResult {
  const findings = normalizedFindings(readField(security, "findings"));
  const summary = readField(security, "summary");
  const complete = readField(security, "complete");
  const blocking = findings.values.filter((finding) => finding.severity === "high" || finding.severity === "critical");
  const summaryBlocking = positiveCount(readField(summary, "high")) + positiveCount(readField(summary, "critical"));
  const status: CertificationCheckStatus = blocking.length > 0 || summaryBlocking > 0
    ? "fail"
    : complete === true && findings.valid && !findings.capped ? "pass" : "unknown";
  const ordered = [...findings.values].sort(compareFindings);
  const relevant = status === "fail"
    ? ordered.filter((finding) => finding.severity === "high" || finding.severity === "critical")
    : ordered;
  const candidates = relevant.map((finding): CertificationEvidence => ({
    location: `${finding.id} ${finding.location}`,
    summary: `[${finding.severity}] ${finding.title}: ${finding.evidence}`,
    remediation: finding.remediation
  }));

  if (candidates.length === 0) {
    candidates.push({
      location: "security",
      summary: status === "fail"
        ? `${summaryBlocking} high or critical finding(s) reported by the security summary.`
        : status === "unknown"
          ? "The security scan was incomplete, so absence of blocking findings is not established."
          : "The complete security scan found no high or critical findings; lower severities are non-blocking.",
      ...(status === "unknown" ? { remediation: "Complete the security scan before relying on static certification." } : {})
    });
  }
  if (findings.capped) {
    candidates.push({
      location: "security",
      summary: `${findings.observed - MAX_COPIED_ITEMS} finding(s) were outside certification processing bounds.`,
      remediation: "Provide a bounded SecurityScanResult generated by the official scanner."
    });
  }
  return check(
    CERTIFICATION_CHECK_IDS.security,
    "Fail-on-high deterministic security policy",
    status,
    candidates,
    findings.observed,
    findings.capped
  );
}

function compatibilityCheck(compatibility: CompatibilitySuiteReport): CertificationCheckResult {
  const profiles = normalizedProfiles(readField(compatibility, "profiles"));
  const schemaVersion = readField(compatibility, "schemaVersion");
  const suiteComplete = readField(compatibility, "complete");
  const evaluations = REQUIRED_COMPATIBILITY_PROFILES.map((required) => {
    const matches = profiles.values.filter((profile) => profileId(profile) === required.id);
    if (matches.some((profile) => readField(profile, "staticEligibility") === "ineligible")) {
      return { required, status: "fail" as const, profile: matches.find((profile) => readField(profile, "staticEligibility") === "ineligible") };
    }
    if (matches.length !== 1) return { required, status: "unknown" as const, profile: matches[0] };
    const profile = matches[0]!;
    if (profileVersion(profile) !== required.version || readField(profile, "complete") !== true || readField(profile, "staticEligibility") === "unknown") {
      return { required, status: "unknown" as const, profile };
    }
    return readField(profile, "staticEligibility") === "eligible"
      ? { required, status: "pass" as const, profile }
      : { required, status: "unknown" as const, profile };
  });
  const structuralUnknown = !profiles.valid || profiles.capped
    || schemaVersion !== COMPATIBILITY_REPORT_SCHEMA_VERSION || suiteComplete !== true;
  const status: CertificationCheckStatus = evaluations.some((evaluation) => evaluation.status === "fail")
    ? "fail"
    : structuralUnknown || evaluations.some((evaluation) => evaluation.status === "unknown") ? "unknown" : "pass";
  const candidates: CertificationEvidence[] = [];

  for (const evaluation of evaluations) {
    candidates.push({
      location: `compatibility/${evaluation.required.id}@${evaluation.required.version}`,
      summary: evaluation.status === "pass"
        ? "Required static profile evidence is complete and eligible."
        : evaluation.status === "fail"
          ? "Required static profile evidence is ineligible."
          : "Required pinned static profile evidence is missing, duplicated, incomplete, or unknown.",
      ...(evaluation.status === "pass" ? {} : {
        remediation: "Run the required Phase 2J compatibility profile to completion and resolve ineligible or unknown checks."
      })
    });
    if (evaluation.status !== "pass" && evaluation.profile) {
      candidates.push(...profileEvidence(evaluation.profile, evaluation.status));
    }
  }
  if (profiles.capped) {
    candidates.push({
      location: "compatibility",
      summary: `${profiles.observed - MAX_COPIED_ITEMS} profile report(s) were outside certification processing bounds.`,
      remediation: "Provide a bounded CompatibilitySuiteReport from the official compatibility engine."
    });
  }
  return check(
    CERTIFICATION_CHECK_IDS.compatibility,
    "Required Phase 2J static portability profiles",
    status,
    candidates,
    REQUIRED_COMPATIBILITY_PROFILES.length,
    profiles.capped
  );
}

function profileEvidence(profile: CompatibilityProfileReport, status: "fail" | "unknown"): CertificationEvidence[] {
  const wanted = status === "fail" ? ["fail"] : ["unknown"];
  const tests = readField(profile, "tests");
  if (!Array.isArray(tests)) return [];
  return tests.slice(0, MAX_COPIED_ITEMS)
    .filter(isRecord)
    .filter((test) => wanted.includes(safeString(readField(test, "status"))))
    .sort((a, b) => compareText(safeString(readField(a, "id")), safeString(readField(b, "id"))))
    .flatMap((test) => {
      const rawEvidence = readField(test, "evidence");
      const remediation = readField(test, "remediation");
      return (Array.isArray(rawEvidence) ? rawEvidence : []).slice(0, MAX_COPIED_ITEMS)
        .filter(isRecord)
        .sort((a, b) => compareText(safeString(readField(a, "location")), safeString(readField(b, "location")))
          || compareText(safeString(readField(a, "summary")), safeString(readField(b, "summary"))))
        .map((item): CertificationEvidence => ({
          location: `${safeString(readField(test, "id"))} ${safeString(readField(item, "location"))}`,
          summary: `${safeString(readField(test, "title"))}: ${safeString(readField(item, "summary"))}`,
          ...(typeof remediation === "string" ? { remediation } : {})
        }));
    });
}

function check(
  id: CertificationCheckResult["id"],
  title: string,
  status: CertificationCheckStatus,
  evidence: CertificationEvidence[],
  observed = evidence.length,
  forcedCapped = false
): CertificationCheckResult {
  const capped = evidence.length > MAX_EVIDENCE_ITEMS;
  const included = capped ? MAX_EVIDENCE_ITEMS - 1 : Math.min(evidence.length, observed);
  const safeObserved = boundedCount(observed);
  return {
    id,
    version: CERTIFICATION_CHECK_VERSION,
    title,
    status,
    evidenceCount: {
      observed: safeObserved,
      included,
      omitted: Math.max(0, safeObserved - included),
      capped: forcedCapped || capped || observed > MAX_COPIED_ITEMS
    },
    evidence: boundedEvidence(evidence)
  };
}

function boundedEvidence(evidence: CertificationEvidence[]): CertificationEvidence[] {
  const retained = evidence.length > MAX_EVIDENCE_ITEMS ? MAX_EVIDENCE_ITEMS - 1 : evidence.length;
  const result = evidence.slice(0, retained).map((item) => ({
    location: safeText(item.location),
    summary: safeText(item.summary),
    ...(item.remediation ? { remediation: safeText(item.remediation) } : {})
  }));
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    result.push({
      location: "certification-report",
      summary: `${evidence.length - retained} additional evidence item(s) omitted by certification bounds.`
    });
  }
  return result;
}

function normalizedStrings(value: unknown): { values: string[]; observed: number; valid: boolean; capped: boolean } {
  if (!Array.isArray(value)) return { values: [], observed: 0, valid: false, capped: false };
  const limited = value.slice(0, MAX_COPIED_ITEMS);
  return {
    values: limited.map((item) => typeof item === "string" ? item : "Invalid non-text evidence was omitted."),
    observed: value.length,
    valid: limited.every((item) => typeof item === "string"),
    capped: value.length > MAX_COPIED_ITEMS
  };
}

function normalizedFindings(value: unknown): { values: SecurityFinding[]; observed: number; valid: boolean; capped: boolean } {
  if (!Array.isArray(value)) return { values: [], observed: 0, valid: false, capped: false };
  const values: SecurityFinding[] = [];
  let valid = true;
  for (const candidate of value.slice(0, MAX_COPIED_ITEMS)) {
    const severity = readField(candidate, "severity");
    const id = readField(candidate, "id");
    const title = readField(candidate, "title");
    const location = readField(candidate, "location");
    const findingEvidence = readField(candidate, "evidence");
    const remediation = readField(candidate, "remediation");
    if (!isSecuritySeverity(severity) || ![id, title, location, findingEvidence, remediation].every((item) => typeof item === "string")) {
      valid = false;
      continue;
    }
    values.push({ id, severity, title, location, evidence: findingEvidence, remediation } as SecurityFinding);
  }
  return { values, observed: value.length, valid, capped: value.length > MAX_COPIED_ITEMS };
}

function normalizedProfiles(value: unknown): { values: CompatibilityProfileReport[]; observed: number; valid: boolean; capped: boolean } {
  if (!Array.isArray(value)) return { values: [], observed: 0, valid: false, capped: false };
  const limited = value.slice(0, MAX_COPIED_ITEMS);
  const values = limited.filter(isRecord) as unknown as CompatibilityProfileReport[];
  return { values, observed: value.length, valid: values.length === limited.length, capped: value.length > MAX_COPIED_ITEMS };
}

function profileId(profile: CompatibilityProfileReport): string | undefined {
  const metadata = readField(profile, "profile");
  const id = readField(metadata, "id");
  return typeof id === "string" ? id : undefined;
}

function profileVersion(profile: CompatibilityProfileReport): string | undefined {
  const metadata = readField(profile, "profile");
  const version = readField(metadata, "version");
  return typeof version === "string" ? version : undefined;
}

function validationLocation(message: string): string {
  const match = /^(plugin\.json|mcp\.json)(?:\/[^ ]*)?/.exec(message);
  return match?.[0] ?? "validation";
}

function positiveCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_COPIED_ITEMS, Math.floor(value)) : 0;
}

function compareFindings(a: SecurityFinding, b: SecurityFinding): number {
  return (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5)
    || compareText(a.id, b.id)
    || compareText(a.location, b.location)
    || compareText(a.title, b.title)
    || compareText(a.evidence, b.evidence);
}

export function sanitizeCertificationText(value: unknown): string {
  const bounded = safeString(value).slice(0, MAX_TEXT_INPUT_LENGTH);
  const redacted = redactSensitiveText(bounded);
  const escaped = redacted.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return escaped.length <= MAX_TEXT_LENGTH
    ? escaped
    : `${escaped.slice(0, MAX_TEXT_LENGTH - 16)}...[truncated]`;
}

const safeText = sanitizeCertificationText;

function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bAKIA[0-9A-Z]*/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)[A-Za-z0-9_-]*/gi, "[REDACTED]")
    .replace(/\b(bearer|basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(authorization|password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|credential)\b(\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;]*/gi, "$1$2[REDACTED]")
    .replace(/https?:\/\/[^\s)\]}]+/gi, (candidate) => redactUrl(candidate));
}

function redactUrl(candidate: string): string {
  try {
    const url = new URL(candidate);
    if (url.username) url.username = "REDACTED";
    if (url.password) url.password = "REDACTED";
    for (const key of [...url.searchParams.keys()]) {
      if (/(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|credential|authorization)/i.test(key)) {
        url.searchParams.set(key, "REDACTED");
      }
    }
    return url.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readField(value: unknown, key: string): unknown {
  try {
    return isRecord(value) ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return value === null || value === undefined ? "" : "[invalid evidence]";
}

function boundedCount(value: number): number {
  return Math.min(1_000_000, Number.isSafeInteger(value) && value > 0 ? value : 0);
}

function isSecuritySeverity(value: unknown): value is SecuritySeverity {
  return value === "info" || value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
