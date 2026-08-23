import type { Dirent, Stats } from "node:fs";
import { lstat, opendir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AGENT_PLUGINS_V1_SCHEMA_SOURCE } from "@agent-plugin-ci/spec-agent-plugins-v1";
import { validateCompiledPlugin, type ValidationResult } from "@agent-plugin-ci/validator";

export const COMPATIBILITY_REPORT_SCHEMA_VERSION = "1.0.0";
const MAX_JSON_BYTES = 1_000_000;
const MAX_SKILL_BYTES = 256_000;
const MAX_SKILLS = 1_000;
const MAX_INPUT_ISSUES = 100;
const MAX_PROFILE_RULES = 100;
const MAX_PROFILE_SOURCES = 16;
const MAX_SOURCE_CLAIMS = 16;
const MAX_EVIDENCE_ITEMS = 4;
const MAX_EVIDENCE_LENGTH = 240;
const MAX_EVIDENCE_INPUT_LENGTH = 2_048;

export const PORTABLE_CORE_PROFILE_ID = "agent-plugins-1.0-portable-core";
export const CURSOR_PROFILE_ID = "cursor-agent-plugins-1.0";
export const COPILOT_PROFILE_ID = "vscode-github-copilot-agent-plugins-1.0";

export type CompatibilityStatus = "pass" | "warn" | "fail" | "unknown";
export type StaticEligibility = "eligible" | "ineligible" | "unknown";
export type CompatibilityEvidenceLevel = "static-inspection";

export interface CompatibilityEvidence {
  location: string;
  summary: string;
}

export interface CompatibilitySource {
  title: string;
  url: string;
  revision?: string;
  claims: string[];
}

export interface CompatibilityProfileMetadata {
  id: string;
  version: string;
  title: string;
  client?: string;
  evidenceLevel: CompatibilityEvidenceLevel;
  sources: CompatibilitySource[];
}

export interface CompatibilityInputIssue {
  code: string;
  status: "fail" | "unknown";
  location: string;
  message: string;
}

export interface CompatibilitySkill {
  name: string;
  location: string;
}

export interface CompatibilityInput {
  manifest?: unknown;
  mcp?: unknown;
  skills?: readonly CompatibilitySkill[];
  inputIssues?: readonly CompatibilityInputIssue[];
  inputComplete?: boolean;
}

export interface CompatibilityRuleContext {
  input: Readonly<Required<Pick<CompatibilityInput, "skills" | "inputIssues" | "inputComplete">> & Omit<CompatibilityInput, "skills" | "inputIssues" | "inputComplete">>;
  validation: ValidationResult;
  features: { skills: number; mcpServers: number };
}

export interface CompatibilityRuleEvaluation {
  status: CompatibilityStatus;
  evidence: CompatibilityEvidence[];
  remediation?: string;
}

export interface CompatibilityRule {
  id: string;
  title: string;
  evaluate(context: CompatibilityRuleContext): CompatibilityRuleEvaluation;
}

export interface CompatibilityProfile extends CompatibilityProfileMetadata {
  rules: readonly CompatibilityRule[];
}

export interface CompatibilityTestResult {
  id: string;
  title: string;
  status: CompatibilityStatus;
  evidenceLevel: CompatibilityEvidenceLevel;
  evidence: CompatibilityEvidence[];
  remediation?: string;
}

export interface CompatibilitySummary {
  pass: number;
  warn: number;
  fail: number;
  unknown: number;
  total: number;
}

export interface CompatibilityProfileReport {
  schemaVersion: typeof COMPATIBILITY_REPORT_SCHEMA_VERSION;
  profile: CompatibilityProfileMetadata;
  evidenceLevel: CompatibilityEvidenceLevel;
  status: CompatibilityStatus;
  staticEligibility: StaticEligibility;
  complete: boolean;
  summary: CompatibilitySummary;
  tests: CompatibilityTestResult[];
  runtimeEvidence: {
    runtimeVerified: false;
    clientInstall: "not-assessed";
    mcpHandshake: "not-assessed";
    note: string;
  };
}

export interface CompatibilitySuiteReport {
  schemaVersion: typeof COMPATIBILITY_REPORT_SCHEMA_VERSION;
  evidenceLevel: CompatibilityEvidenceLevel;
  status: CompatibilityStatus;
  staticEligibility: StaticEligibility;
  complete: boolean;
  package: { name?: string; skills: number; mcpServers: number };
  profiles: CompatibilityProfileReport[];
  runtimeEvidence: CompatibilityProfileReport["runtimeEvidence"];
}

export class UnknownCompatibilityProfileError extends Error {
  constructor(readonly profileId: string) {
    super(`Unknown compatibility profile: ${profileId}`);
  }
}

const SPEC_SOURCE: CompatibilitySource = {
  title: "Agent Plugins specification 1.0",
  url: AGENT_PLUGINS_V1_SCHEMA_SOURCE.repository,
  revision: AGENT_PLUGINS_V1_SCHEMA_SOURCE.revision,
  claims: ["Defines the portable plugin.json and mcp.json package contract used by official validation."]
};

const CURSOR_SOURCE: CompatibilitySource = {
  title: "Cursor Docs: Plugins",
  url: "https://cursor.com/docs/plugins",
  claims: ["A spec-conformant Agent Plugin loads in Cursor without changes.", "Agent Plugins provide portable skills and MCP servers."]
};

const COPILOT_SOURCE: CompatibilitySource = {
  title: "VS Code Docs: Agent plugins in VS Code",
  url: "https://code.visualstudio.com/docs/agent-customization/agent-plugins",
  claims: [
    "Agent Plugins 1.0 is supported with portable skills and MCP servers.",
    "The owned client extension namespace is com.github.copilot.",
    "Other client extension namespaces are ignored."
  ]
};

const inputRule = (id: string): CompatibilityRule => ({
  id,
  title: "Package input was inspected safely and completely",
  evaluate: ({ input }) => {
    if (input.inputIssues.length === 0 && input.inputComplete) {
      return { status: "pass", evidence: [{ location: "package", summary: "Required package inputs were read within static inspection limits." }] };
    }
    const status = input.inputIssues.some((issue) => issue.status === "fail") ? "fail" : "unknown";
    return {
      status,
      evidence: input.inputIssues.length > 0
        ? input.inputIssues.map((issue) => ({ location: issue.location, summary: `${issue.code}: ${issue.message}` }))
        : [{ location: "package", summary: "Static package inspection did not complete." }],
      remediation: "Correct the package input issue and run compatibility assessment again."
    };
  }
});

const validationRule = (id: string): CompatibilityRule => ({
  id,
  title: "Package passes Agent Plugins 1.0 official validation",
  evaluate: ({ input, validation }) => {
    if (input.manifest === undefined) {
      return {
        status: "unknown",
        evidence: [{ location: "plugin.json", summary: "The manifest was unavailable, so official validation could not run." }],
        remediation: "Provide a readable, bounded plugin.json file and run compatibility assessment again."
      };
    }
    if (!validation.ok) {
      return {
        status: "fail",
        evidence: boundedValidationEvidence(validation.errors),
        remediation: "Resolve official Agent Plugins 1.0 validation errors before claiming static compatibility."
      };
    }
    return {
      status: validation.warnings.length ? "warn" : "pass",
      evidence: validation.warnings.length
        ? boundedValidationEvidence(validation.warnings)
        : [{ location: "plugin.json", summary: "plugin.json and optional mcp.json pass the existing official validator." }]
    };
  }
});

const portableFeaturesRule = (id: string, client?: string): CompatibilityRule => ({
  id,
  title: client ? `${client} documented portable components are statically represented` : "Portable components are statically represented",
  evaluate: ({ features }) => {
    const summary = `${features.skills} skill(s) and ${features.mcpServers} MCP server(s) discovered in portable package locations.`;
    if (features.skills > 0) {
      return {
        status: "warn",
        evidence: [{ location: "skills", summary: `${summary} Skill paths and bounded regular SKILL.md files were confirmed; SKILL.md document validity is not assessed in this phase.` }]
      };
    }
    return features.mcpServers > 0
      ? { status: "pass", evidence: [{ location: "mcp.json", summary }] }
      : { status: "warn", evidence: [{ location: "package", summary: `${summary} The metadata-only package has no portable component to exercise.` }] };
  }
});

const extensionToleranceRule = (id: string): CompatibilityRule => ({
  id,
  title: "Client-specific extensions do not reduce portable-core eligibility",
  evaluate: ({ input }) => {
    const count = extensionKeys(input.manifest).length;
    return {
      status: "pass",
      evidence: [{ location: "plugin.json/extensions", summary: `${count} client extension namespace(s) treated as opaque and non-blocking for portable-core compatibility.` }]
    };
  }
});

const copilotExtensionRule: CompatibilityRule = {
  id: "APCI-COMP-COPILOT-004",
  title: "Copilot-owned extension namespace is isolated",
  evaluate: ({ input }) => {
    const keys = extensionKeys(input.manifest);
    const owned = keys.includes("com.github.copilot");
    const ignored = keys.filter((key) => key !== "com.github.copilot").length;
    return {
      status: "pass",
      evidence: [{
        location: "plugin.json/extensions",
        summary: owned
          ? `com.github.copilot is recognized as the documented owned namespace; its opaque contents were not interpreted. ${ignored} other namespace(s) are non-blocking.`
          : `No com.github.copilot extension is declared; ${ignored} other namespace(s) are non-blocking and were not interpreted.`
      }]
    };
  }
};

export const BUILT_IN_COMPATIBILITY_PROFILES: readonly CompatibilityProfile[] = Object.freeze(([
  {
    id: PORTABLE_CORE_PROFILE_ID,
    version: "1.0.0",
    title: "Agent Plugins 1.0 portable core",
    evidenceLevel: "static-inspection",
    sources: [SPEC_SOURCE],
    rules: [
      inputRule("APCI-COMP-CORE-001"),
      validationRule("APCI-COMP-CORE-002"),
      portableFeaturesRule("APCI-COMP-CORE-003"),
      extensionToleranceRule("APCI-COMP-CORE-004")
    ]
  },
  {
    id: CURSOR_PROFILE_ID,
    version: "1.0.0",
    title: "Cursor Agent Plugins 1.0 static eligibility",
    client: "Cursor",
    evidenceLevel: "static-inspection",
    sources: [SPEC_SOURCE, CURSOR_SOURCE],
    rules: [
      inputRule("APCI-COMP-CURSOR-001"),
      validationRule("APCI-COMP-CURSOR-002"),
      portableFeaturesRule("APCI-COMP-CURSOR-003", "Cursor"),
      extensionToleranceRule("APCI-COMP-CURSOR-004")
    ]
  },
  {
    id: COPILOT_PROFILE_ID,
    version: "1.0.0",
    title: "VS Code/GitHub Copilot Agent Plugins 1.0 static eligibility",
    client: "VS Code/GitHub Copilot",
    evidenceLevel: "static-inspection",
    sources: [SPEC_SOURCE, COPILOT_SOURCE],
    rules: [
      inputRule("APCI-COMP-COPILOT-001"),
      validationRule("APCI-COMP-COPILOT-002"),
      portableFeaturesRule("APCI-COMP-COPILOT-003", "VS Code/GitHub Copilot"),
      copilotExtensionRule
    ]
  }
] satisfies CompatibilityProfile[]).map(freezeBuiltInProfile));

export function listCompatibilityProfiles(): CompatibilityProfileMetadata[] {
  return BUILT_IN_COMPATIBILITY_PROFILES.map(profileMetadata);
}

export function getCompatibilityProfile(profileId: string): CompatibilityProfile {
  const profile = BUILT_IN_COMPATIBILITY_PROFILES.find((candidate) => candidate.id === profileId);
  if (!profile) throw new UnknownCompatibilityProfileError(profileId);
  return profile;
}

export function evaluateCompatibilityProfile(profile: CompatibilityProfile, input: CompatibilityInput): CompatibilityProfileReport {
  assertValidProfile(profile);
  const normalizedInput = normalizeInput(input);
  const validation = normalizedInput.manifest === undefined
    ? { ok: false, errors: [], warnings: [] }
    : validateCompiledPlugin(normalizedInput.manifest, normalizedInput.mcp);
  const context: CompatibilityRuleContext = {
    input: normalizedInput,
    validation,
    features: { skills: normalizedInput.skills.length, mcpServers: countMcpServers(normalizedInput.mcp) }
  };
  const tests = [...profile.rules]
    .sort((a, b) => compareText(a.id, b.id))
    .map((rule): CompatibilityTestResult => {
      try {
        const evaluation = rule.evaluate(context);
        return normalizeTest(rule, evaluation);
      } catch {
        return normalizeTest(rule, {
          status: "unknown",
          evidence: [{ location: "compatibility-engine", summary: "The static rule could not complete deterministically." }],
          remediation: "Review the profile rule implementation and run the assessment again."
        });
      }
    });
  const summary = summarize(tests);
  const complete = normalizedInput.inputComplete && summary.unknown === 0;
  const staticEligibility: StaticEligibility = summary.fail > 0 ? "ineligible" : complete ? "eligible" : "unknown";
  return {
    schemaVersion: COMPATIBILITY_REPORT_SCHEMA_VERSION,
    profile: profileMetadata(profile),
    evidenceLevel: "static-inspection",
    status: aggregateStatus(tests.map((test) => test.status)),
    staticEligibility,
    complete,
    summary,
    tests,
    runtimeEvidence: runtimeEvidence()
  };
}

export function assessPluginCompatibility(
  input: CompatibilityInput,
  profileIds: readonly string[] = [PORTABLE_CORE_PROFILE_ID]
): CompatibilitySuiteReport {
  if (profileIds.length === 0) throw new Error("At least one compatibility profile is required");
  const normalizedInput = normalizeInput(input);
  const uniqueIds = [...new Set(profileIds)];
  const profiles = uniqueIds.map((id) => evaluateCompatibilityProfile(getCompatibilityProfile(id), normalizedInput));
  const features = {
    skills: normalizedInput.skills.length,
    mcpServers: countMcpServers(normalizedInput.mcp)
  };
  const name = isRecord(normalizedInput.manifest) && typeof normalizedInput.manifest.name === "string" ? safeText(normalizedInput.manifest.name) : undefined;
  const complete = profiles.every((profile) => profile.complete);
  const staticEligibility: StaticEligibility = profiles.some((profile) => profile.staticEligibility === "ineligible")
    ? "ineligible"
    : profiles.every((profile) => profile.staticEligibility === "eligible") ? "eligible" : "unknown";
  return {
    schemaVersion: COMPATIBILITY_REPORT_SCHEMA_VERSION,
    evidenceLevel: "static-inspection",
    status: aggregateStatus(profiles.map((profile) => profile.status)),
    staticEligibility,
    complete,
    package: { ...(name ? { name } : {}), ...features },
    profiles,
    runtimeEvidence: runtimeEvidence()
  };
}

export async function assessPackageCompatibility(
  packageDir: string,
  profileIds: readonly string[] = [PORTABLE_CORE_PROFILE_ID]
): Promise<CompatibilitySuiteReport> {
  // Resolve profiles before touching the filesystem so unknown profile IDs are invocation errors.
  for (const profileId of [...new Set(profileIds)]) getCompatibilityProfile(profileId);
  const input = await inspectPackage(resolve(packageDir));
  return assessPluginCompatibility(input, profileIds);
}

async function inspectPackage(packageDir: string): Promise<CompatibilityInput> {
  const issues: CompatibilityInputIssue[] = [];
  let complete = true;
  const rootRead = await readStats(packageDir);
  if (rootRead.missing) {
    return { skills: [], inputIssues: [issue("APCI-COMP-INPUT-001", "fail", "package", "Package directory was not found.")], inputComplete: true };
  }
  if (!rootRead.info) {
    return { skills: [], inputIssues: [issue("APCI-COMP-INPUT-015", "unknown", "package", "Package directory metadata could not be read during static inspection.")], inputComplete: false };
  }
  const root = rootRead.info;
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return { skills: [], inputIssues: [issue("APCI-COMP-INPUT-002", "fail", "package", "Package target must be a regular directory and not a symbolic link.")], inputComplete: true };
  }

  const manifestRead = await readPackageJson(join(packageDir, "plugin.json"), "plugin.json", true);
  issues.push(...manifestRead.issues);
  complete &&= manifestRead.complete;
  const mcpRead = await readPackageJson(join(packageDir, "mcp.json"), "mcp.json", false);
  issues.push(...mcpRead.issues);
  complete &&= mcpRead.complete;
  const skillsRead = await inspectSkills(join(packageDir, "skills"));
  issues.push(...skillsRead.issues);
  complete &&= skillsRead.complete;
  return {
    ...(manifestRead.present ? { manifest: manifestRead.value } : {}),
    ...(mcpRead.present ? { mcp: mcpRead.value } : {}),
    skills: skillsRead.skills,
    inputIssues: issues,
    inputComplete: complete
  };
}

async function readPackageJson(path: string, location: string, required: boolean): Promise<{ present: boolean; value?: unknown; issues: CompatibilityInputIssue[]; complete: boolean }> {
  const statRead = await readStats(path);
  if (statRead.missing) {
    return required
      ? { present: false, issues: [issue("APCI-COMP-INPUT-003", "fail", location, "Required package file is missing.")], complete: true }
      : { present: false, issues: [], complete: true };
  }
  if (!statRead.info) {
    return { present: false, issues: [issue("APCI-COMP-INPUT-007", "unknown", location, "File metadata could not be read during static inspection.")], complete: false };
  }
  const info = statRead.info;
  if (!info.isFile() || info.isSymbolicLink()) {
    return { present: false, issues: [issue("APCI-COMP-INPUT-004", "fail", location, "Package JSON input must be a regular file and not a symbolic link.")], complete: true };
  }
  if (info.size > MAX_JSON_BYTES) {
    return { present: false, issues: [issue("APCI-COMP-INPUT-005", "unknown", location, `File exceeds the ${MAX_JSON_BYTES} byte static inspection limit.`)], complete: false };
  }
  try {
    const text = await readFile(path, "utf8");
    const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return { present: true, value: JSON.parse(normalized) as unknown, issues: [], complete: true };
  } catch (error) {
    const invalid = error instanceof SyntaxError;
    return {
      present: false,
      issues: [issue(invalid ? "APCI-COMP-INPUT-006" : "APCI-COMP-INPUT-007", invalid ? "fail" : "unknown", location, invalid ? "File is not valid JSON." : "File could not be read during static inspection.")],
      complete: invalid
    };
  }
}

async function inspectSkills(skillsRoot: string): Promise<{ skills: CompatibilitySkill[]; issues: CompatibilityInputIssue[]; complete: boolean }> {
  const rootRead = await readStats(skillsRoot);
  if (rootRead.missing) return { skills: [], issues: [], complete: true };
  if (!rootRead.info) {
    return { skills: [], issues: [issue("APCI-COMP-INPUT-009", "unknown", "skills", "Skills directory metadata could not be read.")], complete: false };
  }
  const root = rootRead.info;
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return { skills: [], issues: [issue("APCI-COMP-INPUT-008", "fail", "skills", "Skills root must be a regular directory and not a symbolic link.")], complete: true };
  }
  const entries: Dirent[] = [];
  try {
    const directory = await opendir(skillsRoot);
    for await (const entry of directory) {
      entries.push(entry);
      if (entries.length > MAX_SKILLS) break;
    }
  } catch {
    return { skills: [], issues: [issue("APCI-COMP-INPUT-009", "unknown", "skills", "Skills directory could not be enumerated.")], complete: false };
  }
  if (entries.length > MAX_SKILLS) {
    return { skills: [], issues: [issue("APCI-COMP-INPUT-010", "unknown", "skills", `Skills directory exceeds the ${MAX_SKILLS} entry static inspection limit.`)], complete: false };
  }

  const skills: CompatibilitySkill[] = [];
  const issues: CompatibilityInputIssue[] = [];
  const portableNames = new Map<string, string>();
  let complete = true;
  for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
    const location = `skills/${safeText(entry.name)}`;
    const folded = entry.name.toLowerCase();
    const previous = portableNames.get(folded);
    if (previous && previous !== entry.name) {
      issues.push(issue("APCI-COMP-INPUT-011", "fail", "skills", `Case-insensitive skill path collision detected between ${safeText(previous)} and ${safeText(entry.name)}.`));
    }
    portableNames.set(folded, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      issues.push(issue("APCI-COMP-INPUT-012", "fail", location, "Skill entry must be a regular directory and not a symbolic link."));
      continue;
    }
    const skillPath = join(skillsRoot, entry.name, "SKILL.md");
    const skillRead = await readStats(skillPath);
    if (!skillRead.info && !skillRead.missing) {
      issues.push(issue("APCI-COMP-INPUT-016", "unknown", `${location}/SKILL.md`, "Portable skill file metadata could not be read."));
      complete = false;
      continue;
    }
    const skillInfo = skillRead.info;
    if (!skillInfo || !skillInfo.isFile() || skillInfo.isSymbolicLink()) {
      issues.push(issue("APCI-COMP-INPUT-013", "fail", `${location}/SKILL.md`, "Portable skill entry requires a regular SKILL.md file."));
      continue;
    }
    if (skillInfo.size > MAX_SKILL_BYTES) {
      issues.push(issue("APCI-COMP-INPUT-014", "unknown", `${location}/SKILL.md`, `File exceeds the ${MAX_SKILL_BYTES} byte static inspection limit.`));
      complete = false;
      continue;
    }
    skills.push({ name: safeText(entry.name), location: `${location}/SKILL.md` });
  }
  return { skills, issues, complete };
}

function normalizeTest(rule: CompatibilityRule, evaluation: CompatibilityRuleEvaluation): CompatibilityTestResult {
  if (!(["pass", "warn", "fail", "unknown"] as string[]).includes(evaluation.status)) {
    throw new Error(`Compatibility rule ${rule.id} returned an invalid status`);
  }
  if (evaluation.evidence.length === 0) {
    return {
      id: safeText(rule.id),
      title: safeText(rule.title),
      status: "unknown",
      evidenceLevel: "static-inspection",
      evidence: [{ location: "compatibility-engine", summary: "The rule returned no supporting static evidence." }],
      remediation: "Update the profile rule to return bounded supporting evidence."
    };
  }
  const evidenceLimit = evaluation.evidence.length > MAX_EVIDENCE_ITEMS ? MAX_EVIDENCE_ITEMS - 1 : MAX_EVIDENCE_ITEMS;
  const evidence = evaluation.evidence.slice(0, evidenceLimit).map((item) => ({
    location: safeText(item.location),
    summary: safeText(item.summary)
  }));
  if (evaluation.evidence.length > MAX_EVIDENCE_ITEMS) {
    evidence.push({ location: "compatibility-report", summary: `${evaluation.evidence.length - evidenceLimit} additional evidence item(s) omitted by report bounds.` });
  }
  return {
    id: safeText(rule.id),
    title: safeText(rule.title),
    status: evaluation.status,
    evidenceLevel: "static-inspection",
    evidence,
    ...(evaluation.remediation ? { remediation: safeText(evaluation.remediation) } : {})
  };
}

function assertValidProfile(profile: CompatibilityProfile): void {
  if (!profile.id || !profile.version || profile.evidenceLevel !== "static-inspection" || profile.rules.length === 0 || profile.rules.length > MAX_PROFILE_RULES) {
    throw new Error("Compatibility profile metadata is incomplete");
  }
  if (profile.sources.length === 0 || profile.sources.length > MAX_PROFILE_SOURCES) {
    throw new Error("Compatibility profile source metadata is incomplete");
  }
  for (const source of profile.sources) {
    if (!source.title || !source.url || source.claims.length === 0 || source.claims.length > MAX_SOURCE_CLAIMS) {
      throw new Error("Compatibility profile source metadata is incomplete");
    }
  }
  const ids = new Set<string>();
  for (const rule of profile.rules) {
    if (!rule.id || ids.has(rule.id)) throw new Error(`Compatibility profile contains an invalid or duplicate rule ID: ${rule.id}`);
    ids.add(rule.id);
  }
}

function profileMetadata(profile: CompatibilityProfile): CompatibilityProfileMetadata {
  return {
    id: safeText(profile.id),
    version: safeText(profile.version),
    title: safeText(profile.title),
    ...(profile.client ? { client: safeText(profile.client) } : {}),
    evidenceLevel: profile.evidenceLevel,
    sources: profile.sources.map((source) => ({
      title: safeText(source.title),
      url: safeText(source.url),
      ...(source.revision ? { revision: safeText(source.revision) } : {}),
      claims: source.claims.slice(0, MAX_SOURCE_CLAIMS).map((claim) => safeText(claim))
    }))
  };
}

function freezeBuiltInProfile(profile: CompatibilityProfile): CompatibilityProfile {
  for (const source of profile.sources) {
    Object.freeze(source.claims);
    Object.freeze(source);
  }
  for (const rule of profile.rules) Object.freeze(rule);
  Object.freeze(profile.sources);
  Object.freeze(profile.rules);
  return Object.freeze(profile);
}

function summarize(tests: CompatibilityTestResult[]): CompatibilitySummary {
  const summary: CompatibilitySummary = { pass: 0, warn: 0, fail: 0, unknown: 0, total: tests.length };
  for (const test of tests) summary[test.status] += 1;
  return summary;
}

function aggregateStatus(statuses: CompatibilityStatus[]): CompatibilityStatus {
  for (const status of ["fail", "unknown", "warn", "pass"] as const) if (statuses.includes(status)) return status;
  return "unknown";
}

function runtimeEvidence(): CompatibilityProfileReport["runtimeEvidence"] {
  return {
    runtimeVerified: false,
    clientInstall: "not-assessed",
    mcpHandshake: "not-assessed",
    note: "Static eligibility does not prove client installation, component loading, MCP startup, or MCP handshake interoperability."
  };
}

function extensionKeys(manifest: unknown): string[] {
  if (!isRecord(manifest) || !isRecord(manifest.extensions)) return [];
  return Object.keys(manifest.extensions).sort(compareText);
}

function countMcpServers(mcp: unknown): number {
  return isRecord(mcp) && isRecord(mcp.mcpServers) ? Object.keys(mcp.mcpServers).length : 0;
}

function validationLocation(message: string): string {
  const match = /^(plugin\.json|mcp\.json)(?:\/[^ ]*)?/.exec(message);
  return match?.[0] ?? "package";
}

function boundedValidationEvidence(messages: readonly string[]): CompatibilityEvidence[] {
  const retained = messages.length > MAX_EVIDENCE_ITEMS ? MAX_EVIDENCE_ITEMS - 1 : messages.length;
  const evidence = messages.slice(0, retained).map((message) => ({
    location: validationLocation(message),
    summary: message
  }));
  if (messages.length > MAX_EVIDENCE_ITEMS) {
    evidence.push({
      location: "compatibility-report",
      summary: `${messages.length - retained} additional validation message(s) omitted by report bounds.`
    });
  }
  return evidence;
}

function issue(code: string, status: "fail" | "unknown", location: string, message: string): CompatibilityInputIssue {
  return { code, status, location: safeText(location), message: safeText(message) };
}

function compareIssues(a: CompatibilityInputIssue, b: CompatibilityInputIssue): number {
  return compareText(a.location, b.location) || compareText(a.code, b.code) || compareText(a.message, b.message);
}

function safeText(value: string): string {
  const bounded = value.slice(0, MAX_EVIDENCE_INPUT_LENGTH);
  const redacted = redactSensitiveText(bounded);
  const sanitized = redacted.replace(/[\u0000-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return value.length <= MAX_EVIDENCE_INPUT_LENGTH && sanitized.length <= MAX_EVIDENCE_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_EVIDENCE_LENGTH - 16)}...[truncated]`;
}

function normalizeInput(input: CompatibilityInput): CompatibilityRuleContext["input"] {
  const skills = [...(input.skills ?? [])];
  const inputIssues = [...(input.inputIssues ?? [])];
  let inputComplete = input.inputComplete ?? true;
  if (skills.length > MAX_SKILLS) {
    skills.length = MAX_SKILLS;
    inputIssues.push(issue("APCI-COMP-INPUT-010", "unknown", "skills", `Skill input exceeds the ${MAX_SKILLS} entry static inspection limit.`));
    inputComplete = false;
  }
  if (inputIssues.length > MAX_INPUT_ISSUES) {
    const retained = MAX_INPUT_ISSUES - 1;
    const omitted = inputIssues.length - retained;
    inputIssues.length = retained;
    inputIssues.push(issue("APCI-COMP-INPUT-017", "unknown", "package", `${omitted} additional input issue(s) omitted by report bounds.`));
    inputComplete = false;
  }
  return {
    ...input,
    skills: skills.sort((a, b) => compareText(a.location, b.location) || compareText(a.name, b.name)),
    inputIssues: inputIssues.sort(compareIssues),
    inputComplete
  };
}

async function readStats(path: string): Promise<{ info?: Stats; missing: boolean }> {
  try {
    return { info: await lstat(path), missing: false };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    return { missing: code === "ENOENT" || code === "ENOTDIR" };
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[REDACTED]")
    .replace(/\b(authorization|password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|credential)\b(\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/https?:\/\/[^\s)\]}]+/gi, (candidate) => redactUrl(candidate));
}

function redactUrl(candidate: string): string {
  try {
    const url = new URL(candidate);
    let changed = false;
    if (url.username) {
      url.username = "REDACTED";
      changed = true;
    }
    if (url.password) {
      url.password = "REDACTED";
      changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|credential|authorization)/i.test(key)) {
        url.searchParams.set(key, "REDACTED");
        changed = true;
      }
    }
    return changed ? url.toString() : candidate;
  } catch {
    return "[REDACTED_URL]";
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export * from "./runtime.js";
export * from "./client-runtime.js";
export * from "./client-runtime-fixture.js";
