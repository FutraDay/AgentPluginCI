import {
  COMPATIBILITY_REPORT_SCHEMA_VERSION,
  COPILOT_PROFILE_ID,
  CURSOR_PROFILE_ID,
  PORTABLE_CORE_PROFILE_ID,
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
