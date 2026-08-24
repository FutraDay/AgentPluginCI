import type { Stats } from "node:fs";
import { lookup } from "node:dns/promises";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client, SSEClientTransport, StreamableHTTPClientTransport, type FetchLike, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { validateCompiledPlugin } from "@agent-plugin-ci/validator";

export const RUNTIME_COMPATIBILITY_REPORT_SCHEMA_VERSION = "1.0.0";
export const RUNTIME_COMPATIBILITY_EVIDENCE_LEVEL = "runtime-observation" as const;
export const RUNTIME_COMPATIBILITY_SCOPE = "mcp-startup-handshake" as const;

const MAX_JSON_BYTES = 1_000_000;
const MAX_SERVERS = 50;
const MAX_ARGS = 100;
const MAX_ENV = 100;
const MAX_STRING = 4_096;
const MAX_COMMAND = 1_024;
const MAX_URL = 2_048;
const MAX_EVIDENCE_ITEMS = 4;
const MAX_TEXT_INPUT = 2_048;
const MAX_TEXT = 240;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 1_000;
export type RuntimeProbeStatus = "pass" | "fail" | "unknown" | "not-assessed";
export type RuntimeMcpHandshakeStatus = "verified" | "failed" | "partial" | "not-assessed";

export interface RuntimeCompatibilityEvidence {
  code: string;
  location: string;
  summary: string;
  remediation?: string;
}

export interface RuntimeMcpServerResult {
  name: string;
  transport: "stdio" | "streamable-http" | "sse" | "unknown";
  status: RuntimeProbeStatus;
  complete: boolean;
  startup: RuntimeProbeStatus;
  handshake: RuntimeProbeStatus;
  evidence: RuntimeCompatibilityEvidence[];
}

export interface RuntimeCompatibilitySummary {
  pass: number;
  fail: number;
  unknown: number;
  notAssessed: number;
  total: number;
}
export interface RuntimeCompatibilityReport {
  schemaVersion: typeof RUNTIME_COMPATIBILITY_REPORT_SCHEMA_VERSION;
  evidenceLevel: typeof RUNTIME_COMPATIBILITY_EVIDENCE_LEVEL;
  scope: typeof RUNTIME_COMPATIBILITY_SCOPE;
  status: RuntimeProbeStatus;
  complete: boolean;
  interoperability: "not-established";
  clientInstall: "not-assessed";
  clientLoad: "not-assessed";
  mcpHandshake: RuntimeMcpHandshakeStatus;
  summary: RuntimeCompatibilitySummary;
  servers: RuntimeMcpServerResult[];
  evidence: RuntimeCompatibilityEvidence[];
  note: string;
}

export interface RuntimeCompatibilityOptions {
  allowStdioRuntime?: boolean;
  allowPrivateNetwork?: boolean;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
}

export interface ClientMcpStdioTarget {
  name: string;
  location: string;
  command: string;
  args: readonly string[];
  pluginManifest: Readonly<Record<string, unknown>>;
  mcpSchema: string;
}

export type ClientMcpStdioPreflight =
  | { ok: true; target: ClientMcpStdioTarget }
  | { ok: false; code: string; location: string; summary: string };

type RuntimeOptions = Required<RuntimeCompatibilityOptions>;
type ReadJsonResult = { present: boolean; value?: Record<string, unknown>; issue?: RuntimeCompatibilityEvidence };

class RuntimeTimeoutError extends Error {}

/**
 * Performs the non-executing subset of the Phase 3A stdio safety checks for a
 * client-mediated runtime. Client adapters use this before granting a real
 * client access to package runtime metadata. The deliberately narrow contract
 * accepts one environment-free stdio target so attribution stays exact and no
 * secret-bearing environment is passed to the client.
 */
export async function preflightSingleClientMcpStdioTarget(
  packageDir: string
): Promise<ClientMcpStdioPreflight> {
  const root = resolve(packageDir);
  const rootInfo = await readStats(root);
  if (!rootInfo.info || !rootInfo.info.isDirectory() || rootInfo.info.isSymbolicLink()) {
    return clientPreflightFailure(
      "APCI-RUNTIME-INPUT-001",
      "package",
      "Package root must be a readable regular directory and not a symbolic link."
    );
  }

  const pluginRead = await readJsonObject(join(root, "plugin.json"), "plugin.json", true);
  const mcpRead = await readJsonObject(join(root, "mcp.json"), "mcp.json", true);
  if (pluginRead.issue || !pluginRead.value) {
    return clientPreflightFailure(
      pluginRead.issue?.code ?? "APCI-RUNTIME-INPUT-002",
      pluginRead.issue?.location ?? "plugin.json",
      "Required plugin.json could not be assessed safely."
    );
  }
  if (mcpRead.issue || !mcpRead.value) {
    return clientPreflightFailure(
      mcpRead.issue?.code ?? "APCI-RUNTIME-INPUT-010",
      mcpRead.issue?.location ?? "mcp.json",
      "Required mcp.json could not be assessed safely."
    );
  }

  const validation = validateCompiledPlugin(pluginRead.value, mcpRead.value);
  if (!validation.ok) {
    return clientPreflightFailure(
      "APCI-RUNTIME-INPUT-003",
      validation.errors[0] ? validationLocation(validation.errors[0]) : "package",
      "Official Agent Plugins validation failed; client-mediated runtime execution was not permitted."
    );
  }

  const rawServers = isRecord(mcpRead.value.mcpServers)
    ? Object.entries(mcpRead.value.mcpServers)
    : [];
  if (rawServers.length !== 1) {
    return clientPreflightFailure(
      "APCI-RUNTIME-CLIENT-001",
      "mcp.json/mcpServers",
      "Client-mediated MCP execution requires exactly one server so runtime evidence remains attributable."
    );
  }

  const [rawName, raw] = rawServers[0]!;
  const location = `mcp.json/mcpServers/${safeText(rawName)}`;
  if (rawName.length === 0 || rawName.length > 128 || safeText(rawName) !== rawName || !isRecord(raw)) {
    return clientPreflightFailure(
      "APCI-RUNTIME-BOUND-002",
      location,
      "MCP server metadata is outside runtime processing bounds."
    );
  }
  if (raw.type !== "stdio") {
    return clientPreflightFailure(
      "APCI-RUNTIME-CLIENT-002",
      location,
      "Client-mediated MCP execution currently permits only one bounded stdio server."
    );
  }

  const command = boundedString(raw.command, MAX_COMMAND);
  const args = boundedStringArray(raw.args, MAX_ARGS, MAX_STRING);
  const cwdIsAllowed = raw.cwd === undefined || raw.cwd === "${PLUGIN_ROOT}";
  if (!command || args === undefined || !cwdIsAllowed) {
    return clientPreflightFailure(
      "APCI-RUNTIME-BOUND-003",
      location,
      "stdio command, arguments, or cwd are outside client-mediated runtime safety bounds."
    );
  }
  if (raw.env !== undefined) {
    return clientPreflightFailure(
      "APCI-RUNTIME-CLIENT-003",
      location,
      "Client-mediated MCP execution does not pass package-declared environment metadata."
    );
  }

  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (!canonicalRoot || !await clientMcpArgsStayContained(canonicalRoot, args)) {
    return clientPreflightFailure(
      "APCI-RUNTIME-CLIENT-004",
      location,
      "Client-mediated MCP arguments contain an escaped, traversing, missing, or symlinked filesystem path."
    );
  }

  const mcpSchema = boundedString(mcpRead.value.$schema, MAX_STRING);
  if (!mcpSchema) {
    return clientPreflightFailure(
      "APCI-RUNTIME-BOUND-005",
      "mcp.json/$schema",
      "MCP schema metadata is outside client-mediated runtime safety bounds."
    );
  }
  return {
    ok: true,
    target: {
      name: rawName,
      location,
      command,
      args: Object.freeze([...args]),
      pluginManifest: pluginRead.value,
      mcpSchema
    }
  };
}

async function clientMcpArgsStayContained(canonicalRoot: string, args: readonly string[]): Promise<boolean> {
  for (const argument of args) {
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(argument)) return false;
    if (!isAbsolute(argument)) continue;
    const info = await readStats(argument);
    if (!info.info?.isFile() || info.info.isSymbolicLink()) return false;
    const canonicalArgument = await realpath(argument).catch(() => undefined);
    if (!canonicalArgument) return false;
    const pathFromRoot = relative(canonicalRoot, canonicalArgument);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) return false;
  }
  return true;
}

function clientPreflightFailure(
  code: string,
  location: string,
  summary: string
): Extract<ClientMcpStdioPreflight, { ok: false }> {
  return { code, location: safeText(location), ok: false, summary: safeText(summary) };
}

export async function assessPackageRuntimeCompatibility(
  packageDir: string,
  options: RuntimeCompatibilityOptions = {}
): Promise<RuntimeCompatibilityReport> {
  const runtimeOptions = normalizeOptions(options);
  const root = resolve(packageDir);
  const rootInfo = await readStats(root);
  if (!rootInfo.info || !rootInfo.info.isDirectory() || rootInfo.info.isSymbolicLink()) {
    return inputReport("unknown", evidence(
      "APCI-RUNTIME-INPUT-001", "package",
      "Package root must be a readable regular directory and not a symbolic link."
    ));
  }

  const pluginRead = await readJsonObject(join(root, "plugin.json"), "plugin.json", true);
  if (pluginRead.issue || !pluginRead.value) {
    return inputReport("unknown", pluginRead.issue ?? evidence(
      "APCI-RUNTIME-INPUT-002", "plugin.json", "Required plugin.json could not be assessed safely."
    ));
  }
  const mcpRead = await readJsonObject(join(root, "mcp.json"), "mcp.json", false);
  if (mcpRead.issue) return inputReport("unknown", mcpRead.issue);
  if (!mcpRead.present) {
    return inputReport("not-assessed", evidence(
      "APCI-RUNTIME-NO-TARGET-001", "mcp.json",
      "No mcp.json is present, so there is no MCP runtime target to exercise."
    ));
  }
  if (!mcpRead.value) {
    return inputReport("unknown", evidence(
      "APCI-RUNTIME-INPUT-010", "mcp.json", "Runtime MCP input could not be normalized safely."
    ));
  }

  const validation = validateCompiledPlugin(pluginRead.value, mcpRead.value);
  if (!validation.ok) {
    const items = validation.errors.slice(0, MAX_EVIDENCE_ITEMS).map((message) => evidence(
      "APCI-RUNTIME-INPUT-003",
      validationLocation(message),
      "Official Agent Plugins validation failed; runtime execution was not attempted.",
      "Resolve official validation errors before collecting runtime evidence."
    ));
    return reportFromServers([], "unknown", false, items.length ? items : [evidence(
      "APCI-RUNTIME-INPUT-003", "package",
      "Official Agent Plugins validation failed; runtime execution was not attempted."
    )]);
  }

  const rawServers = isRecord(mcpRead.value.mcpServers) ? Object.entries(mcpRead.value.mcpServers) : [];
  if (rawServers.length === 0) {
    return inputReport("not-assessed", evidence(
      "APCI-RUNTIME-NO-TARGET-002", "mcp.json/mcpServers",
      "mcp.json contains no MCP servers, so no runtime handshake was performed."
    ));
  }
  if (rawServers.length > MAX_SERVERS) {
    return inputReport("unknown", evidence(
      "APCI-RUNTIME-BOUND-001", "mcp.json/mcpServers",
      `MCP runtime assessment exceeds the ${MAX_SERVERS} server execution bound.`,
      "Reduce the runtime target set and assess again."
    ));
  }

  const servers: RuntimeMcpServerResult[] = [];
  for (const [name, raw] of rawServers.sort(([a], [b]) => compareText(a, b))) {
    servers.push(await assessServer(root, name, raw, runtimeOptions));
  }
  const status = aggregateServerStatus(servers);
  const complete = servers.every((server) => server.complete);
  return reportFromServers(servers, status, complete, []);
}

function normalizeOptions(options: RuntimeCompatibilityOptions): RuntimeOptions {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Runtime timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return {
    allowStdioRuntime: options.allowStdioRuntime ?? false,
    allowPrivateNetwork: options.allowPrivateNetwork ?? false,
    allowInsecureHttp: options.allowInsecureHttp ?? false,
    timeoutMs
  };
}
async function assessServer(
  packageDir: string,
  rawName: string,
  raw: unknown,
  options: RuntimeOptions
): Promise<RuntimeMcpServerResult> {
  const name = safeText(rawName);
  const location = `mcp.json/mcpServers/${name}`;
  if (rawName.length > 128 || !isRecord(raw)) {
    return serverResult(name, "unknown", "unknown", false, "unknown", "unknown", [evidence(
      "APCI-RUNTIME-BOUND-002", location, "MCP server metadata is outside runtime processing bounds."
    )]);
  }
  if (raw.type === "stdio") return assessStdioServer(packageDir, name, location, raw, options);
  if (raw.type === "streamable-http" || raw.type === "sse") {
    return assessRemoteServer(name, location, raw.type, raw, options);
  }
  return serverResult(name, "unknown", "unknown", false, "unknown", "unknown", [evidence(
    "APCI-RUNTIME-INPUT-004", location, "MCP server transport is unsupported for runtime assessment."
  )]);
}

async function assessStdioServer(
  packageDir: string,
  name: string,
  location: string,
  raw: Record<string, unknown>,
  options: RuntimeOptions
): Promise<RuntimeMcpServerResult> {
  if (!options.allowStdioRuntime) {
    return serverResult(name, "stdio", "not-assessed", false, "not-assessed", "not-assessed", [evidence(
      "APCI-RUNTIME-POLICY-001", location,
      "stdio runtime execution is disabled by default; no process was started.",
      "Re-run the explicit runtime command with stdio execution enabled only for a trusted test target."
    )]);
  }

  const command = boundedString(raw.command, MAX_COMMAND);
  const args = boundedStringArray(raw.args, MAX_ARGS, MAX_STRING);
  if (!command || args === undefined || raw.cwd !== undefined) {
    return serverResult(name, "stdio", "unknown", false, "unknown", "not-assessed", [evidence(
      "APCI-RUNTIME-BOUND-003", location,
      raw.cwd !== undefined
        ? "stdio cwd is not executed by the Phase 3A runtime foundation because safe plugin-data path resolution is not yet modeled."
        : "stdio command or arguments are outside runtime processing bounds."
    )]);
  }

  const environment = resolveRuntimeEnvironment(raw.env);
  if (!environment.ok) {
    return serverResult(name, "stdio", "not-assessed", false, "not-assessed", "not-assessed", [evidence(
      "APCI-RUNTIME-ENV-001", location, environment.reason,
      "Use ${NAME} environment placeholders and provide required variables in the runtime process environment."
    )]);
  }
  const client = new Client({ name: "agent-plugin-ci-runtime", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command,
    args,
    ...(environment.env ? { env: environment.env } : {}),
    cwd: packageDir,
    stderr: "ignore",
    maxBufferSize: MAX_JSON_BYTES
  });

  try {
    await withTimeout(client.connect(transport), options.timeoutMs);
    return serverResult(name, "stdio", "pass", true, "pass", "pass", [evidence(
      "APCI-RUNTIME-MCP-001", location,
      "The explicitly permitted stdio server started and completed an MCP initialize handshake."
    )]);
  } catch (error) {
    if (error instanceof RuntimeTimeoutError) {
      return serverResult(name, "stdio", "fail", true,
        transport.pid === null ? "unknown" : "pass", "fail", [evidence(
          "APCI-RUNTIME-MCP-003", location,
          "The stdio MCP initialize handshake did not complete within the configured runtime timeout."
        )]);
    }
    if (isStdioStartupFailure(error, transport)) {
      return serverResult(name, "stdio", "fail", true, "fail", "not-assessed", [evidence(
        "APCI-RUNTIME-MCP-002", location, "The explicitly permitted stdio server could not remain available for MCP initialization."
      )]);
    }
    return serverResult(name, "stdio", "fail", true,
      transport.pid === null ? "unknown" : "pass", "fail", [evidence(
        "APCI-RUNTIME-MCP-004", location,
        "The stdio MCP initialize handshake did not complete successfully."
      )]);
  } finally {
    await boundedClose(client, transport);
  }
}

async function assessRemoteServer(
  name: string,
  location: string,
  type: "streamable-http" | "sse",
  raw: Record<string, unknown>,
  options: RuntimeOptions
): Promise<RuntimeMcpServerResult> {
  if (raw.headers !== undefined) {
    return serverResult(name, type, "not-assessed", false, "not-assessed", "not-assessed", [evidence(
      "APCI-RUNTIME-POLICY-002", location,
      "Credential-bearing or custom HTTP headers are not transmitted by the Phase 3A runtime foundation."
    )]);
  }

  const rawUrl = boundedString(raw.url, MAX_URL);
  if (!rawUrl) {
    return serverResult(name, type, "unknown", false, "not-assessed", "unknown", [evidence(
      "APCI-RUNTIME-BOUND-004", location, "Remote MCP URL is outside runtime processing bounds."
    )]);
  }
  const preflight = await remotePreflight(rawUrl, options);
  if (!preflight.ok) {
    return serverResult(
      name, type, preflight.blocked ? "not-assessed" : "fail", !preflight.blocked,
      "not-assessed", preflight.blocked ? "not-assessed" : "fail",
      [evidence(preflight.code, location, preflight.summary, preflight.remediation)]
    );
  }

  const client = new Client({ name: "agent-plugin-ci-runtime", version: "0.1.0" });
  const guardedFetch = createGuardedFetch(options);
  const transport: Transport = type === "sse"
    ? new SSEClientTransport(preflight.url, { fetch: guardedFetch, requestInit: { redirect: "manual" } })
    : new StreamableHTTPClientTransport(preflight.url, { fetch: guardedFetch, requestInit: { redirect: "manual" } });
  try {
    await withTimeout(client.connect(transport), options.timeoutMs);
    return serverResult(name, type, "pass", true, "not-assessed", "pass", [evidence(
      "APCI-RUNTIME-MCP-005", location, "The remote MCP endpoint completed an MCP initialize handshake."
    )]);
  } catch (error) {
    return serverResult(name, type, "fail", true, "not-assessed", "fail", [evidence(
      error instanceof RuntimeTimeoutError ? "APCI-RUNTIME-MCP-006" : "APCI-RUNTIME-MCP-007",
      location,
      error instanceof RuntimeTimeoutError
        ? "The remote MCP initialize handshake did not complete within the configured runtime timeout."
        : "The remote MCP initialize handshake did not complete successfully."
    )]);
  } finally {
    await boundedClose(client, transport);
  }
}
async function remotePreflight(rawUrl: string, options: RuntimeOptions): Promise<
  | { ok: true; url: URL }
  | { ok: false; blocked: boolean; code: string; summary: string; remediation?: string }
> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch {
    return { ok: false, blocked: false, code: "APCI-RUNTIME-NET-001", summary: "Remote MCP URL is not a valid absolute URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, blocked: true, code: "APCI-RUNTIME-NET-002", summary: "Remote MCP runtime probing permits only HTTP(S) endpoints." };
  }
  if (url.username || url.password) {
    return { ok: false, blocked: true, code: "APCI-RUNTIME-NET-003", summary: "Credential-bearing MCP URLs are not used for runtime probing." };
  }
  if ([...url.searchParams.keys()].some((key) => /(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|credential|authorization)/i.test(key))) {
    return { ok: false, blocked: true, code: "APCI-RUNTIME-NET-008", summary: "Credential-like MCP URL query parameters are not transmitted by runtime probing." };
  }
  if (url.protocol === "http:" && !options.allowInsecureHttp) {
    return { ok: false, blocked: true, code: "APCI-RUNTIME-NET-004", summary: "Insecure HTTP MCP runtime probing is disabled by default." };
  }
  if (options.allowPrivateNetwork) return { ok: true, url };

  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (isPrivateHostName(host) || (isIP(host) !== 0 && isReservedIp(host))) {
    return { ok: false, blocked: true, code: "APCI-RUNTIME-NET-005", summary: "Private, local, link-local, or reserved MCP targets are disabled by default." };
  }
  if (isIP(host) === 0) {
    try {
      const addresses = await lookup(host, { all: true, verbatim: true });
      if (addresses.length === 0 || addresses.some((entry) => isReservedIp(entry.address))) {
        return {
          ok: false, blocked: true, code: "APCI-RUNTIME-NET-006",
          summary: "MCP hostname resolution reached a private, local, link-local, reserved, or unavailable target."
        };
      }
    } catch {
      return {
        ok: false, blocked: false, code: "APCI-RUNTIME-NET-007",
        summary: "MCP hostname resolution did not complete successfully."
      };
    }
  }
  return { ok: true, url };
}

function createGuardedFetch(options: RuntimeOptions): FetchLike {
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input.href;
    const check = await remotePreflight(raw, options);
    if (!check.ok) throw new Error("Runtime network request was blocked by the MCP safety policy.");
    return fetch(check.url, { ...init, redirect: "manual" });
  };
}
function resolveRuntimeEnvironment(raw: unknown):
  | { ok: true; env?: Record<string, string> }
  | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true };
  if (!isRecord(raw)) return { ok: false, reason: "stdio environment metadata is invalid; no process was started." };
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENV) {
    return { ok: false, reason: `stdio environment exceeds the ${MAX_ENV} variable runtime bound; no process was started.` };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length > MAX_STRING) {
      return { ok: false, reason: "stdio environment metadata is outside runtime processing bounds; no process was started." };
    }
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (!match || match[1] !== key) {
      return { ok: false, reason: "Literal stdio environment values are never executed; no process was started." };
    }
    const actual = process.env[key];
    if (actual === undefined) {
      return { ok: false, reason: "A required runtime environment variable is unavailable; no process was started." };
    }
    env[key] = actual;
  }
  return { ok: true, ...(entries.length ? { env } : {}) };
}

function isReservedIp(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.includes(":")) {
    if (normalized.startsWith("::ffff:")) return true;
    return normalized === "::" || normalized === "::1"
      || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff")
      || normalized.startsWith("2001:db8:");
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function isPrivateHostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

async function readJsonObject(path: string, location: string, required: boolean): Promise<ReadJsonResult> {
  const statRead = await readStats(path);
  if (statRead.missing) {
    return required
      ? { present: false, issue: evidence("APCI-RUNTIME-INPUT-005", location, "Required runtime input is missing.") }
      : { present: false };
  }
  const info = statRead.info;
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    return { present: true, issue: evidence("APCI-RUNTIME-INPUT-006", location, "Runtime JSON input must be a regular file and not a symbolic link.") };
  }
  if (info.size > MAX_JSON_BYTES) {
    return { present: true, issue: evidence(
      "APCI-RUNTIME-INPUT-007", location, `Runtime JSON input exceeds the ${MAX_JSON_BYTES} byte limit.`
    ) };
  }
  try {
    const text = await readFile(path, "utf8");
    const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const value = JSON.parse(normalized) as unknown;
    if (!isRecord(value)) {
      return { present: true, issue: evidence(
        "APCI-RUNTIME-INPUT-008", location, "Runtime JSON input must contain an object."
      ) };
    }
    return { present: true, value };
  } catch {
    return { present: true, issue: evidence(
      "APCI-RUNTIME-INPUT-009", location,
      "Runtime JSON input is not valid JSON or could not be read safely."
    ) };
  }
}

async function readStats(path: string): Promise<{ info?: Stats; missing: boolean }> {
  try { return { info: await lstat(path), missing: false }; }
  catch (error) {
    const code = errorCode(error);
    return { missing: code === "ENOENT" || code === "ENOTDIR" };
  }
}
function boundedString(raw: unknown, max: number): string | undefined {
  return typeof raw === "string" && raw.length > 0 && raw.length <= max && !raw.includes("\0") ? raw : undefined;
}

function boundedStringArray(raw: unknown, maxItems: number, maxString: number): string[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > maxItems) return undefined;
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.length > maxString || item.includes("\0")) return undefined;
    values.push(item);
  }
  return values;
}

function serverResult(
  name: string,
  transport: RuntimeMcpServerResult["transport"],
  status: RuntimeProbeStatus,
  complete: boolean,
  startup: RuntimeProbeStatus,
  handshake: RuntimeProbeStatus,
  items: RuntimeCompatibilityEvidence[]
): RuntimeMcpServerResult {
  return { name, transport, status, complete, startup, handshake, evidence: boundedEvidence(items) };
}

function inputReport(status: RuntimeProbeStatus, item: RuntimeCompatibilityEvidence): RuntimeCompatibilityReport {
  return reportFromServers([], status, false, [item]);
}
function reportFromServers(
  servers: RuntimeMcpServerResult[],
  status: RuntimeProbeStatus,
  complete: boolean,
  items: RuntimeCompatibilityEvidence[]
): RuntimeCompatibilityReport {
  const summary: RuntimeCompatibilitySummary = { pass: 0, fail: 0, unknown: 0, notAssessed: 0, total: servers.length };
  for (const server of servers) {
    if (server.status === "not-assessed") summary.notAssessed += 1;
    else summary[server.status] += 1;
  }
  const tested = servers.filter((server) => server.handshake === "pass" || server.handshake === "fail");
  const mcpHandshake: RuntimeMcpHandshakeStatus = tested.length === 0
    ? "not-assessed"
    : tested.some((server) => server.handshake === "fail") ? "failed"
      : tested.length === servers.length ? "verified" : "partial";

  return {
    schemaVersion: RUNTIME_COMPATIBILITY_REPORT_SCHEMA_VERSION,
    evidenceLevel: RUNTIME_COMPATIBILITY_EVIDENCE_LEVEL,
    scope: RUNTIME_COMPATIBILITY_SCOPE,
    status,
    complete,
    interoperability: "not-established",
    clientInstall: "not-assessed",
    clientLoad: "not-assessed",
    mcpHandshake,
    summary,
    servers,
    evidence: boundedEvidence(items),
    note: "Runtime MCP evidence is scoped to the observed startup/initialize handshake only. It does not establish client installation, client loading, tool behavior, or general interoperability."
  };
}

function aggregateServerStatus(servers: RuntimeMcpServerResult[]): RuntimeProbeStatus {
  if (servers.some((server) => server.status === "fail")) return "fail";
  if (servers.every((server) => server.status === "pass")) return "pass";
  if (servers.some((server) => server.status === "unknown" || server.status === "pass")) return "unknown";
  return "not-assessed";
}

function evidence(code: string, location: string, summary: string, remediation?: string): RuntimeCompatibilityEvidence {
  return {
    code,
    location: safeText(location),
    summary: safeText(summary),
    ...(remediation ? { remediation: safeText(remediation) } : {})
  };
}

function boundedEvidence(items: RuntimeCompatibilityEvidence[]): RuntimeCompatibilityEvidence[] {
  const retained = items.length > MAX_EVIDENCE_ITEMS ? MAX_EVIDENCE_ITEMS - 1 : items.length;
  const result = items.slice(0, retained).map((item) => evidence(item.code, item.location, item.summary, item.remediation));
  if (items.length > MAX_EVIDENCE_ITEMS) {
    result.push(evidence(
      "APCI-RUNTIME-REPORT-001", "runtime-report",
      `${items.length - retained} additional runtime evidence item(s) omitted by report bounds.`
    ));
  }
  return result;
}
function safeText(value: string): string {
  const bounded = value.slice(0, MAX_TEXT_INPUT);
  const redacted = redactSensitiveText(bounded);
  const escaped = redacted.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return escaped.length <= MAX_TEXT
    ? escaped
    : `${escaped.slice(0, MAX_TEXT - 16)}...[truncated]`;
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

function validationLocation(message: string): string {
  const match = /^(plugin\.json|mcp\.json)(?:\/[^ ]*)?/.exec(message);
  return match?.[0] ?? "package";
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isStdioStartupFailure(error: unknown, transport: StdioClientTransport): boolean {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return true;
  return code === "CONNECTION_CLOSED" && transport.pid === null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RuntimeTimeoutError("runtime operation timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedClose(client: Client, transport: Transport): Promise<void> {
  await withTimeout(transport.close().catch(() => undefined), CLEANUP_TIMEOUT_MS).catch(() => undefined);
  await withTimeout(client.close().catch(() => undefined), CLEANUP_TIMEOUT_MS).catch(() => undefined);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
