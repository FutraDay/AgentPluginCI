export const CLIENT_RUNTIME_REPORT_SCHEMA_VERSION = "1.1.0";
export const CLIENT_RUNTIME_EVIDENCE_LEVEL = "client-runtime-observation" as const;
export const CLIENT_RUNTIME_SCOPE = "client-adapter-harness" as const;

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const FINALIZE_TIMEOUT_MS = 1_000;
const MAX_CAPABILITIES = 16;
const MAX_EVIDENCE_INPUT_ITEMS = 64;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_PACKAGE_ROOT = 4_096;
const MAX_TEXT_INPUT = 2_048;
const MAX_TEXT = 240;

export const CLIENT_RUNTIME_CAPABILITIES = Object.freeze([
  "package-read",
  "client-process",
  "client-filesystem",
  "network"
] as const);

export const CURSOR_CLIENT_RUNTIME_TARGET_ID = "cursor";
export const VSCODE_COPILOT_CLIENT_RUNTIME_TARGET_ID = "vscode-github-copilot";

export const KNOWN_CLIENT_RUNTIME_TARGETS = Object.freeze([
  Object.freeze({
    id: CURSOR_CLIENT_RUNTIME_TARGET_ID,
    name: "Cursor",
    adapterAvailable: false as const
  }),
  Object.freeze({
    id: VSCODE_COPILOT_CLIENT_RUNTIME_TARGET_ID,
    name: "VS Code/GitHub Copilot",
    adapterAvailable: true as const
  })
]);

export type ClientRuntimeCapability = typeof CLIENT_RUNTIME_CAPABILITIES[number];
export type ClientRuntimeObservationStatus = "observed" | "not-observed" | "not-assessed" | "unknown";
export type ClientRuntimeExecutionStatus = "pass" | "fail" | "unknown" | "timeout" | "denied";
export type ClientRuntimeFinalizeStatus = "complete" | "failed" | "timeout" | "not-run";
export type ClientRuntimeInteroperability = "established" | "not-established";

export interface ClientRuntimeEvidence {
  code: string;
  location: string;
  summary: string;
  remediation?: string;
}

export interface ClientRuntimeAdapterIdentity {
  id: string;
  version: string;
}

export interface ClientRuntimeTargetIdentity {
  id: string;
  name: string;
  version?: string;
}

export interface ClientRuntimeAdapterMetadata {
  adapter: ClientRuntimeAdapterIdentity;
  targetClient: ClientRuntimeTargetIdentity;
  synthetic: boolean;
  requiredCapabilities: readonly ClientRuntimeCapability[];
}

export interface ClientRuntimeAdapterContext {
  /** A label only, supplied only with an explicit package-read grant. No filesystem handle is granted. */
  readonly packageRoot?: string;
  readonly signal: AbortSignal;
  readonly grantedCapabilities: readonly ClientRuntimeCapability[];
}

export interface ClientRuntimeAdapterOutput {
  status: "pass" | "fail" | "unknown";
  complete: boolean;
  packageInstall: ClientRuntimeObservationStatus;
  clientLoad: ClientRuntimeObservationStatus;
  mcpStartup: ClientRuntimeObservationStatus;
  mcpHandshake: ClientRuntimeObservationStatus;
  toolExposure: ClientRuntimeObservationStatus;
  interoperability: ClientRuntimeInteroperability;
  targetClientVersion?: string;
  evidence: readonly ClientRuntimeEvidence[];
}

/**
 * Trust boundary: adapter implementations are trusted Agent Plugin CI infrastructure code.
 * This harness does not sandbox arbitrary imported adapter code. Adapter capability declarations
 * are policy gates for harness invocation, while adapter metadata and output are still normalized
 * as untrusted data before they are used or reported.
 */
export interface ClientRuntimeAdapter {
  readonly metadata: ClientRuntimeAdapterMetadata;
  initialize?(context: ClientRuntimeAdapterContext): Promise<void> | void;
  execute(context: ClientRuntimeAdapterContext): Promise<unknown> | unknown;
  finalize?(context: ClientRuntimeAdapterContext, status: ClientRuntimeExecutionStatus): Promise<void> | void;
}

export interface ClientRuntimeHarnessOptions {
  allowExecution?: boolean;
  timeoutMs?: number;
  grantedCapabilities?: readonly ClientRuntimeCapability[];
}

export interface ClientRuntimeReport {
  schemaVersion: typeof CLIENT_RUNTIME_REPORT_SCHEMA_VERSION;
  evidenceLevel: typeof CLIENT_RUNTIME_EVIDENCE_LEVEL;
  scope: typeof CLIENT_RUNTIME_SCOPE;
  synthetic: boolean;
  adapter: ClientRuntimeAdapterIdentity;
  targetClient: ClientRuntimeTargetIdentity;
  requestedCapabilities: ClientRuntimeCapability[];
  grantedCapabilities: ClientRuntimeCapability[];
  execution: {
    status: ClientRuntimeExecutionStatus;
    complete: boolean;
    finalize: ClientRuntimeFinalizeStatus;
  };
  packageInstall: ClientRuntimeObservationStatus;
  clientLoad: ClientRuntimeObservationStatus;
  mcpStartup: ClientRuntimeObservationStatus;
  mcpHandshake: ClientRuntimeObservationStatus;
  toolExposure: ClientRuntimeObservationStatus;
  interoperability: ClientRuntimeInteroperability;
  evidence: ClientRuntimeEvidence[];
  note: string;
}

export class InvalidClientRuntimeAdapterError extends Error {
  constructor(message = "Client runtime adapter metadata is invalid") {
    super(message);
  }
}

export class UnknownClientRuntimeAdapterError extends Error {
  constructor(readonly adapterId: string) {
    super(`Unknown client runtime adapter: ${safeText(adapterId)}`);
  }
}

export class ClientRuntimeAdapterRegistry {
  readonly #adapters = new Map<string, ClientRuntimeAdapter>();

  constructor(adapters: readonly ClientRuntimeAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ClientRuntimeAdapter): void {
    const metadata = validateAdapter(adapter);
    if (this.#adapters.has(metadata.adapter.id)) {
      throw new InvalidClientRuntimeAdapterError(`Duplicate client runtime adapter: ${metadata.adapter.id}`);
    }
    this.#adapters.set(metadata.adapter.id, adapter);
  }

  get(adapterId: string): ClientRuntimeAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) throw new UnknownClientRuntimeAdapterError(adapterId);
    return adapter;
  }

  list(): ClientRuntimeAdapterMetadata[] {
    return [...this.#adapters.values()]
      .map((adapter) => cloneMetadata(validateAdapter(adapter)))
      .sort((left, right) => compareText(left.adapter.id, right.adapter.id));
  }
}

class ClientRuntimeTimeoutError extends Error {}

export async function runClientRuntimeHarness(
  packageRoot: string,
  adapter: ClientRuntimeAdapter,
  options: ClientRuntimeHarnessOptions = {}
): Promise<ClientRuntimeReport> {
  if (typeof packageRoot !== "string" || packageRoot.length === 0 || packageRoot.length > MAX_PACKAGE_ROOT
    || /[\u0000-\u001f\u007f]/.test(packageRoot)) {
    throw new Error("Client runtime package label is outside harness safety bounds");
  }
  const metadata = cloneMetadata(validateAdapter(adapter));
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const grantedCapabilities = normalizeCapabilities(options.grantedCapabilities ?? [], "granted capabilities");
  const requestedCapabilities = [...metadata.requiredCapabilities];

  if (!options.allowExecution) {
    return baseReport(metadata, grantedCapabilities, "denied", false, "not-run", "not-assessed", "not-assessed", [
      evidence("APCI-CLIENT-POLICY-001", "client-runtime", "Client adapter execution is disabled by default; no adapter lifecycle method was invoked.")
    ]);
  }

  const missing = requestedCapabilities.filter((capability) => !grantedCapabilities.includes(capability));
  if (missing.length > 0) {
    return baseReport(metadata, grantedCapabilities, "denied", false, "not-run", "not-assessed", "not-assessed", [
      evidence(
        "APCI-CLIENT-POLICY-002",
        "client-runtime/capabilities",
        `Adapter execution was denied because ${missing.length} declared capability grant(s) are missing.`
      )
    ]);
  }
  const undeclared = grantedCapabilities.filter((capability) => !requestedCapabilities.includes(capability));
  if (undeclared.length > 0) {
    return baseReport(metadata, grantedCapabilities, "denied", false, "not-run", "not-assessed", "not-assessed", [
      evidence(
        "APCI-CLIENT-POLICY-003",
        "client-runtime/capabilities",
        `Adapter execution was denied because ${undeclared.length} capability grant(s) were not declared by the adapter.`
      )
    ]);
  }

  const controller = new AbortController();
  const context: ClientRuntimeAdapterContext = Object.freeze({
    ...(grantedCapabilities.includes("package-read") ? { packageRoot } : {}),
    signal: controller.signal,
    grantedCapabilities: Object.freeze([...grantedCapabilities])
  });
  let status: ClientRuntimeExecutionStatus = "unknown";
  let normalized: ClientRuntimeAdapterOutput | undefined;
  let failureEvidence: ClientRuntimeEvidence | undefined;

  try {
    const raw = await withTimeout((async () => {
      await adapter.initialize?.(context);
      return await adapter.execute(context);
    })(), timeoutMs, controller);
    normalized = normalizeAdapterOutput(raw);
    status = normalized.status;
  } catch (error) {
    if (error instanceof ClientRuntimeTimeoutError) {
      status = "timeout";
      failureEvidence = evidence(
        "APCI-CLIENT-LIFECYCLE-002",
        "client-runtime/execute",
        "The client adapter lifecycle did not complete within the configured timeout."
      );
    } else if (error instanceof InvalidAdapterOutputError) {
      status = "unknown";
      failureEvidence = evidence(
        "APCI-CLIENT-OUTPUT-001",
        "client-runtime/adapter-output",
        "Client adapter output was malformed or outside harness safety bounds; the result was rejected."
      );
    } else {
      status = "fail";
      failureEvidence = evidence(
        "APCI-CLIENT-LIFECYCLE-001",
        "client-runtime/execute",
        "The client adapter lifecycle failed without producing trusted runtime evidence."
      );
    }
  }

  const finalize = await finalizeAdapter(adapter, context, status);
  const evidenceItems = normalized?.evidence ?? (failureEvidence ? [failureEvidence] : []);
  const finalizeEvidence = finalize === "complete" ? [] : [evidence(
    finalize === "timeout" ? "APCI-CLIENT-LIFECYCLE-004" : "APCI-CLIENT-LIFECYCLE-003",
    "client-runtime/finalize",
    finalize === "timeout"
      ? "Client adapter finalization did not complete within the cleanup timeout."
      : "Client adapter finalization failed; no exception details were retained."
  )];
  const complete = Boolean(normalized?.complete) && finalize === "complete";
  const interoperability = warrantsInteroperability(metadata, normalized, complete)
    ? "established" as const
    : "not-established" as const;

  return baseReport(
    metadata,
    grantedCapabilities,
    status,
    complete,
    finalize,
    normalized?.packageInstall ?? "unknown",
    normalized?.clientLoad ?? "unknown",
    [...evidenceItems, ...finalizeEvidence],
    interoperability,
    normalized?.targetClientVersion,
    normalized?.mcpStartup ?? "unknown",
    normalized?.mcpHandshake ?? "unknown",
    normalized?.toolExposure ?? "unknown"
  );
}

function validateAdapter(adapter: ClientRuntimeAdapter): ClientRuntimeAdapterMetadata {
  try {
    if (!isRecord(adapter) || typeof adapter.execute !== "function" || !isRecord(adapter.metadata)) throw new Error();
    const metadata = adapter.metadata;
    if (!isRecord(metadata.adapter) || !isRecord(metadata.targetClient)) throw new Error();
    if (!validId(metadata.adapter.id) || !safeVersion(metadata.adapter.version)) throw new Error();
    if (!validId(metadata.targetClient.id) || !validLabel(metadata.targetClient.name)) throw new Error();
    if (safeText(metadata.adapter.id) !== metadata.adapter.id
      || safeText(metadata.targetClient.id) !== metadata.targetClient.id
      || safeText(metadata.targetClient.name) !== metadata.targetClient.name) throw new Error();
    if (metadata.targetClient.version !== undefined && !safeVersion(metadata.targetClient.version)) throw new Error();
    if (typeof metadata.synthetic !== "boolean") throw new Error();
    const requiredCapabilities = normalizeCapabilities(metadata.requiredCapabilities, "required capabilities");
    if (adapter.initialize !== undefined && typeof adapter.initialize !== "function") throw new Error();
    if (adapter.finalize !== undefined && typeof adapter.finalize !== "function") throw new Error();
    if (requiredCapabilities.some((capability) => capability === "client-process" || capability === "client-filesystem")
      && typeof adapter.finalize !== "function") throw new Error();
    return metadata as unknown as ClientRuntimeAdapterMetadata;
  } catch {
    throw new InvalidClientRuntimeAdapterError();
  }
}

function cloneMetadata(metadata: ClientRuntimeAdapterMetadata): ClientRuntimeAdapterMetadata {
  return {
    adapter: { id: metadata.adapter.id, version: metadata.adapter.version },
    targetClient: {
      id: metadata.targetClient.id,
      name: metadata.targetClient.name,
      ...(metadata.targetClient.version ? { version: metadata.targetClient.version } : {})
    },
    synthetic: metadata.synthetic,
    requiredCapabilities: normalizeCapabilities(metadata.requiredCapabilities, "required capabilities")
  };
}

class InvalidAdapterOutputError extends Error {}

function normalizeAdapterOutput(raw: unknown): ClientRuntimeAdapterOutput {
  try {
    if (!isRecord(raw)) throw new Error();
    if (!isExecutionResult(raw.status) || typeof raw.complete !== "boolean") throw new Error();
    if (!isObservation(raw.packageInstall) || !isObservation(raw.clientLoad)
      || !isObservation(raw.mcpStartup) || !isObservation(raw.mcpHandshake)
      || !isObservation(raw.toolExposure)) throw new Error();
    if (raw.interoperability !== "established" && raw.interoperability !== "not-established") throw new Error();
    if (raw.targetClientVersion !== undefined && !safeVersion(raw.targetClientVersion)) throw new Error();
    if (!Array.isArray(raw.evidence) || raw.evidence.length > MAX_EVIDENCE_INPUT_ITEMS) throw new Error();
    const items = raw.evidence.map(normalizeEvidence);
    return {
      status: raw.status,
      complete: raw.complete,
      packageInstall: raw.packageInstall,
      clientLoad: raw.clientLoad,
      mcpStartup: raw.mcpStartup,
      mcpHandshake: raw.mcpHandshake,
      toolExposure: raw.toolExposure,
      interoperability: raw.interoperability,
      ...(raw.targetClientVersion ? { targetClientVersion: raw.targetClientVersion } : {}),
      evidence: boundedEvidence(items)
    };
  } catch {
    throw new InvalidAdapterOutputError();
  }
}

function normalizeEvidence(raw: unknown): ClientRuntimeEvidence {
  if (!isRecord(raw) || typeof raw.code !== "string" || !/^APCI-[A-Z0-9-]{3,80}$/.test(raw.code)) throw new Error();
  if (typeof raw.location !== "string" || typeof raw.summary !== "string" || raw.location.length === 0 || raw.summary.length === 0) throw new Error();
  if (raw.remediation !== undefined && typeof raw.remediation !== "string") throw new Error();
  return evidence(raw.code, raw.location, raw.summary, raw.remediation);
}

function warrantsInteroperability(
  metadata: ClientRuntimeAdapterMetadata,
  output: ClientRuntimeAdapterOutput | undefined,
  complete: boolean
): boolean {
  return metadata.synthetic === false
    && output?.interoperability === "established"
    && output.status === "pass"
    && complete
    && output.packageInstall === "observed"
    && output.clientLoad === "observed"
    && output.evidence.length > 0;
}

async function finalizeAdapter(
  adapter: ClientRuntimeAdapter,
  context: ClientRuntimeAdapterContext,
  status: ClientRuntimeExecutionStatus
): Promise<ClientRuntimeFinalizeStatus> {
  if (!adapter.finalize) return "complete";
  try {
    await withTimeout(Promise.resolve(adapter.finalize(context, status)), FINALIZE_TIMEOUT_MS);
    return "complete";
  } catch (error) {
    return error instanceof ClientRuntimeTimeoutError ? "timeout" : "failed";
  }
}

function baseReport(
  metadata: ClientRuntimeAdapterMetadata,
  grantedCapabilities: ClientRuntimeCapability[],
  status: ClientRuntimeExecutionStatus,
  complete: boolean,
  finalize: ClientRuntimeFinalizeStatus,
  packageInstall: ClientRuntimeObservationStatus,
  clientLoad: ClientRuntimeObservationStatus,
  items: ClientRuntimeEvidence[],
  interoperability: ClientRuntimeInteroperability = "not-established",
  targetClientVersion?: string,
  mcpStartup: ClientRuntimeObservationStatus = "not-assessed",
  mcpHandshake: ClientRuntimeObservationStatus = "not-assessed",
  toolExposure: ClientRuntimeObservationStatus = "not-assessed"
): ClientRuntimeReport {
  const targetClient = {
    ...metadata.targetClient,
    ...(targetClientVersion ? { version: targetClientVersion } : {})
  };
  return {
    schemaVersion: CLIENT_RUNTIME_REPORT_SCHEMA_VERSION,
    evidenceLevel: CLIENT_RUNTIME_EVIDENCE_LEVEL,
    scope: CLIENT_RUNTIME_SCOPE,
    synthetic: metadata.synthetic,
    adapter: { ...metadata.adapter },
    targetClient,
    requestedCapabilities: [...metadata.requiredCapabilities].sort(compareText),
    grantedCapabilities: [...grantedCapabilities].sort(compareText),
    execution: { status, complete, finalize },
    packageInstall,
    clientLoad,
    mcpStartup,
    mcpHandshake,
    toolExposure,
    interoperability,
    evidence: boundedEvidence(items),
    note: metadata.synthetic
      ? "Synthetic fixture evidence exercises only the harness contract. It does not establish interoperability with any real client."
      : interoperability === "established"
        ? "Interoperability is established only for the named client version and bounded observations in this report."
        : "Client runtime execution did not establish interoperability."
  };
}

function boundedEvidence(items: readonly ClientRuntimeEvidence[]): ClientRuntimeEvidence[] {
  const sorted = [...items].sort((left, right) =>
    compareText(left.code, right.code) || compareText(left.location, right.location) || compareText(left.summary, right.summary));
  const retained = sorted.length > MAX_EVIDENCE_ITEMS ? MAX_EVIDENCE_ITEMS - 1 : sorted.length;
  const result = sorted.slice(0, retained).map((item) => evidence(item.code, item.location, item.summary, item.remediation));
  if (sorted.length > MAX_EVIDENCE_ITEMS) {
    result.push(evidence(
      "APCI-CLIENT-REPORT-001",
      "client-runtime/report",
      `${sorted.length - retained} additional client runtime evidence item(s) omitted by report bounds.`
    ));
  }
  return result;
}

function evidence(code: string, location: string, summary: string, remediation?: string): ClientRuntimeEvidence {
  return {
    code,
    location: safeText(location),
    summary: safeText(summary),
    ...(remediation ? { remediation: safeText(remediation) } : {})
  };
}

function safeText(value: string): string {
  const bounded = value.slice(0, MAX_TEXT_INPUT);
  const redacted = redactSensitiveText(bounded);
  const escaped = redacted.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return escaped.length <= MAX_TEXT ? escaped : `${escaped.slice(0, MAX_TEXT - 16)}...[truncated]`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bAKIA[0-9A-Z]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
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

function normalizeTimeout(raw: number | undefined): number {
  const value = raw ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(`Client runtime timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return value;
}

function normalizeCapabilities(raw: readonly ClientRuntimeCapability[], label: string): ClientRuntimeCapability[] {
  if (!Array.isArray(raw) || raw.length > MAX_CAPABILITIES) throw new InvalidClientRuntimeAdapterError(`Invalid ${label}`);
  const result: ClientRuntimeCapability[] = [];
  for (const capability of raw) {
    if (!isCapability(capability) || result.includes(capability)) {
      throw new InvalidClientRuntimeAdapterError(`Invalid ${label}`);
    }
    result.push(capability);
  }
  return result.sort(compareText);
}

function isCapability(value: unknown): value is ClientRuntimeCapability {
  return typeof value === "string" && (CLIENT_RUNTIME_CAPABILITIES as readonly string[]).includes(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new ClientRuntimeTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(value);
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(value);
}

function safeVersion(value: unknown): value is string {
  return validVersion(value) && safeText(value) === value;
}

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isExecutionResult(value: unknown): value is ClientRuntimeAdapterOutput["status"] {
  return value === "pass" || value === "fail" || value === "unknown";
}

function isObservation(value: unknown): value is ClientRuntimeObservationStatus {
  return value === "observed" || value === "not-observed" || value === "not-assessed" || value === "unknown";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
