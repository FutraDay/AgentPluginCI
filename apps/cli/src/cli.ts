import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assessPackageCompatibility,
  assessPackageRuntimeCompatibility,
  assessPluginCompatibility,
  BUILT_IN_COMPATIBILITY_PROFILES,
  ClientRuntimeAdapterRegistry,
  createSyntheticFixtureClientAdapter,
  createVscodeClientRuntimeAdapter,
  PORTABLE_CORE_PROFILE_ID,
  runClientRuntimeHarness,
  UnknownClientRuntimeAdapterError,
  UnknownCompatibilityProfileError,
  VSCODE_CLIENT_RUNTIME_ADAPTER_ID,
  type ClientRuntimeCapability,
  type ClientRuntimeReport,
  type CompatibilitySuiteReport,
  type RuntimeCompatibilityOptions,
  type RuntimeCompatibilityReport
} from "@agent-plugin-ci/compatibility";
import {
  certifyPluginEvidence,
  STATIC_PORTABILITY_POLICY,
  type CertificationReport
} from "@agent-plugin-ci/certification";
import { compilePlugin, type CompiledPlugin } from "@agent-plugin-ci/compiler";
import { createSdkMcpToolDiscoverer, ingestMcpConfig, mcpConfigFromUrl } from "@agent-plugin-ci/ingest-mcp";
import { ingestOpenApiSource } from "@agent-plugin-ci/ingest-openapi";
import type { PluginIR } from "@agent-plugin-ci/plugin-ir";
import {
  scanPackageSecurity,
  scanPluginSecurity,
  severityAtLeast,
  type SecurityScanResult,
  type SecuritySeverity
} from "@agent-plugin-ci/security";
import { validateCompiledPlugin, type ValidationResult } from "@agent-plugin-ci/validator";
import cliPackage from "../package.json" with { type: "json" };

export const CLI_VERSION = cliPackage.version;
const MAX_JSON_BYTES = 1_000_000;

export interface CliIo {
  cwd?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

type SourceKind = "mcp" | "openapi" | "ir";
type ScanThreshold = SecuritySeverity | "none";
type Warning = { code: string; message: string; scope?: string };

type ParsedBuildOptions = {
  sourceKind: SourceKind;
  source: string;
  out?: string;
  name?: string;
  force: boolean;
  json: boolean;
  flags: Set<string>;
};
class CliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: 1 | 2 = 1
  ) {
    super(message);
  }
}

export async function runCli(rawArgs: string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((message: string) => console.log(message));
  const stderr = io.stderr ?? ((message: string) => console.error(message));
  const cwd = resolve(io.cwd ?? process.env.INIT_CWD ?? process.cwd());
  const json = rawArgs.includes("--json");

  try {
    if (rawArgs.length === 0 || rawArgs[0] === "help" || rawArgs.includes("--help") || rawArgs.includes("-h")) {
      stdout(helpText());
      return 0;
    }
    if (rawArgs[0] === "--version" || rawArgs[0] === "-v" || rawArgs[0] === "version") {
      stdout(json ? JSON.stringify({ ok: true, command: "version", version: CLI_VERSION }) : CLI_VERSION);
      return 0;
    }

    const args = normalizeLegacyArgs(rawArgs);
    if (args[0] === "build") return await runBuild(args.slice(1), cwd, stdout, stderr);
    if (args[0] === "validate") return await runValidate(args.slice(1), cwd, stdout, stderr);
    if (args[0] === "scan") return await runScan(args.slice(1), cwd, stdout, stderr);
    if (args[0] === "compat") return await runCompat(args.slice(1), cwd, stdout, stderr);
    if (args[0] === "compat-runtime") return await runCompatRuntime(args.slice(1), cwd, stdout, stderr);
    if (args[0] === "certify") return await runCertify(args.slice(1), cwd, stdout, stderr);
    throw new CliError(`Unknown command: ${args[0]}`, "USAGE_ERROR", 2);
  } catch (error) {
    return renderFailure(error, json, stdout, stderr);
  }
}
async function runBuild(
  args: string[],
  cwd: string,
  stdout: (message: string) => void,
  stderr: (message: string) => void
): Promise<number> {
  const options = parseBuildArgs(args);
  const source = resolveSource(cwd, options.source);
  const warnings: Warning[] = [];
  let ir: PluginIR;

  if (options.sourceKind === "openapi") {
    const result = await ingestOpenApiSource(source, {
      pluginName: options.name,
      allowPrivateNetwork: options.flags.has("--allow-private-network"),
      allowInsecureHttp: options.flags.has("--allow-insecure-http"),
      allowCrossOriginRefs: options.flags.has("--allow-cross-origin-refs"),
      allowExternalFileRefsOutsideRoot: options.flags.has("--allow-external-file-refs")
    });
    ir = result.ir;
    warnings.push(...result.warnings.map((item) => ({
      code: item.code,
      message: item.message,
      ...(item.operation ? { scope: item.operation } : {})
    })));
  } else if (options.sourceKind === "mcp") {
    const config = /^https?:\/\//i.test(source)
      ? mcpConfigFromUrl(source, deriveServerName(source))
      : await readJsonFile(source, "MCP configuration");
    const discoverer = options.flags.has("--no-discover") ? undefined : createSdkMcpToolDiscoverer({
      allowStdio: options.flags.has("--allow-stdio-discovery"),
      allowPrivateNetwork: options.flags.has("--allow-private-network"),
      allowInsecureHttp: options.flags.has("--allow-insecure-http")
    });
    const result = await ingestMcpConfig(config, { pluginName: options.name, discoverer });
    ir = result.ir;
    warnings.push(...result.warnings.map((item) => ({
      code: item.code,
      message: item.message,
      ...(item.server ? { scope: item.server } : {})
    })));
  } else {
    ir = await readJsonFile(source, "PluginIR") as PluginIR;
  }

  const compiled = compilePlugin(ir);
  const validation = validateCompiledPlugin(compiled.manifest, compiled.mcp);
  if (!validation.ok) return renderValidationFailure(validation, options.json, stdout, stderr);
  const security = scanPluginSecurity({
    manifest: compiled.manifest,
    mcp: compiled.mcp,
    skills: compiled.skills
  });
  const compatibility = assessPluginCompatibility({
    manifest: compiled.manifest,
    mcp: compiled.mcp,
    skills: Object.keys(compiled.skills).map((name) => ({ name, location: `skills/${name}/SKILL.md` }))
  });

  const outDir = resolve(cwd, options.out ?? join("dist", ir.identity.name));
  await writeCompiledPackage(compiled, outDir, cwd, options.force);
  const payload = {
    ok: true,
    command: "build",
    version: CLI_VERSION,
    source: { kind: options.sourceKind, value: redactSource(options.source) },
    outputDir: outDir,
    plugin: String(compiled.manifest.name),
    counts: {
      skills: Object.keys(compiled.skills).length,
      mcpServers: ir.mcpServers.length,
      capabilities: ir.capabilities?.length ?? 0
    },
    security: { mode: "report-only" as const, ...security },
    compatibility: { mode: "report-only" as const, ...compatibility },
    warnings: [...warnings, ...validation.warnings.map((message) => ({ code: "VALIDATION_WARNING", message }))]
  };

  if (options.json) stdout(JSON.stringify(payload));
  else renderBuildSuccess(payload, stdout, stderr);
  return 0;
}

async function runValidate(
  args: string[],
  cwd: string,
  stdout: (message: string) => void,
  stderr: (message: string) => void
): Promise<number> {
  const { target, json } = parseValidateArgs(args);
  const resolved = resolve(cwd, target);
  const info = await stat(resolved).catch(() => undefined);
  if (!info) throw new CliError(`Validation target not found: ${target}`, "VALIDATION_INPUT_ERROR");
  const packageDir = info.isDirectory() ? resolved : dirname(resolved);
  const pluginPath = info.isDirectory() ? join(packageDir, "plugin.json") : resolved;
  const manifest = await readJsonRecord(pluginPath, "plugin.json");
  const mcpPath = join(packageDir, "mcp.json");
  const mcpInfo = await stat(mcpPath).catch(() => undefined);
  const mcp = mcpInfo ? await readJsonRecord(mcpPath, "mcp.json") : undefined;
  const result = validateCompiledPlugin(manifest, mcp);

  const payload = {
    ok: result.ok,
    command: "validate",
    version: CLI_VERSION,
    target: packageDir,
    files: { plugin: pluginPath, ...(mcp ? { mcp: mcpPath } : {}) },
    errors: result.errors,
    warnings: result.warnings
  };

  if (json) stdout(JSON.stringify(payload));
  else if (result.ok) {
    stdout(`VALIDATION_OK ${packageDir}`);
    for (const warning of result.warnings) stderr(`WARNING ${warning}`);
  } else {
    stderr("VALIDATION_FAILED");
    for (const error of result.errors) stderr(`- ${error}`);
  }
  return result.ok ? 0 : 1;
}

async function runScan(
  args: string[],
  cwd: string,
  stdout: (message: string) => void,
  stderr: (message: string) => void
): Promise<number> {
  const { target, json, failOn } = parseScanArgs(args);
  const resolved = resolve(cwd, target);
  const info = await stat(resolved).catch(() => undefined);
  if (!info) throw new CliError(`Security scan target not found: ${target}`, "SECURITY_INPUT_ERROR");
  const packageDir = info.isDirectory() ? resolved : dirname(resolved);
  const result = await scanPackageSecurity(packageDir);
  const blocking = failOn === "none"
    ? []
    : result.findings.filter((finding) => severityAtLeast(finding.severity, failOn));
  const incompleteScanBlocked = failOn !== "none" && !result.complete;
  const ok = failOn === "none" || (!incompleteScanBlocked && blocking.length === 0);
  const payload = {
    ok,
    command: "scan",
    version: CLI_VERSION,
    target: packageDir,
    complete: result.complete,
    policy: { failOn },
    summary: result.summary,
    findings: result.findings,
    blockingFindings: blocking.length,
    incompleteScanBlocked
  };

  if (json) stdout(JSON.stringify(payload));
  else renderSecurityScan(payload, stdout, stderr);
  return ok ? 0 : 1;
}

async function runCompat(
  args: string[],
  cwd: string,
  stdout: (message: string) => void,
  stderr: (message: string) => void
): Promise<number> {
  const { target, json, profileIds } = parseCompatArgs(args);
  const resolved = resolve(cwd, target);
  const info = await stat(resolved).catch(() => undefined);
  if (!info) throw new CliError(`Compatibility target not found: ${target}`, "COMPATIBILITY_INPUT_ERROR");
  if (!info.isDirectory() && basename(resolved) !== "plugin.json") {
    throw new CliError("Compatibility target must be a package directory or its plugin.json file", "COMPATIBILITY_INPUT_ERROR");
  }
  const packageDir = info.isDirectory() ? resolved : dirname(resolved);
  const report = await assessPackageCompatibility(packageDir, profileIds);
  const ok = report.staticEligibility === "eligible";
  const payload = { ok, command: "compat", version: CLI_VERSION, target: packageDir, ...report };

  if (json) stdout(JSON.stringify(payload));
  else renderCompatibility(payload, stdout, stderr);
  return ok ? 0 : 1;
}

async function runCompatRuntime(
  args: string[],
  cwd: string,
  stdout: (message: string) => void,
  stderr: (message: string) => void
): Promise<number> {
  const { target, json, options, client } = parseCompatRuntimeArgs(args);
  const resolved = resolve(cwd, target);
  const info = await lstat(resolved).catch(() => undefined);
  if (!info) throw new CliError(`Runtime compatibility target not found: ${target}`, "RUNTIME_COMPATIBILITY_INPUT_ERROR");
  if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || basename(resolved) !== "plugin.json"))) {
    throw new CliError("Runtime compatibility target must be a regular package directory or its regular plugin.json file", "RUNTIME_COMPATIBILITY_INPUT_ERROR");
  }
  const packageDir = info.isDirectory() ? resolved : dirname(resolved);
  if (client) {
    const adapters = createCliClientAdapterRegistry(
      client.executablePath,
      options.timeoutMs,
      client.allowMcpRuntime
    );
    let adapter;
    try {
      adapter = adapters.get(client.adapterId);
    } catch (error) {
      if (error instanceof UnknownClientRuntimeAdapterError) {
        throw new CliError(
          `${error.message}. Available adapters: ${adapters.list().map((item) => item.adapter.id).join(", ")}`,
          "USAGE_ERROR",
          2
        );
      }
      throw error;
    }
    if (adapter.metadata.synthetic && !client.allowSyntheticFixture) {
      throw new CliError(
        "The synthetic fixture adapter requires --allow-synthetic-fixture and never represents a real client test",
        "USAGE_ERROR",
        2
      );
    }
    const report = await runClientRuntimeHarness(packageDir, adapter, {
      allowExecution: client.allowExecution,
      grantedCapabilities: client.grantedCapabilities,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
    });
    const ok = report.execution.status === "pass" && report.execution.complete;
    const payload = { ok, command: "compat-runtime", version: CLI_VERSION, target: packageDir, ...report };
    if (json) stdout(JSON.stringify(payload));
    else renderClientRuntimeCompatibility(payload, stdout, stderr);
    return ok ? 0 : 1;
  }
  const report = await assessPackageRuntimeCompatibility(packageDir, options);
  const ok = report.status === "pass" && report.complete && report.servers.length > 0;
  const payload = { ok, command: "compat-runtime", version: CLI_VERSION, target: packageDir, ...report };
  if (json) stdout(JSON.stringify(payload));
  else renderRuntimeCompatibility(payload, stdout, stderr);
  return ok ? 0 : 1;
}

async function runCertify(
  args: string[],
  cwd: string,
  stdout: (message: string) => void,
  stderr: (message: string) => void
): Promise<number> {
  const { target, json } = parseCertifyArgs(args);
  const resolved = resolve(cwd, target);
  const info = await lstat(resolved).catch(() => undefined);
  if (!info) throw new CliError(`Certification target not found: ${target}`, "CERTIFICATION_INPUT_ERROR");
  if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || basename(resolved) !== "plugin.json"))) {
    throw new CliError("Certification target must be a regular package directory or its regular plugin.json file", "CERTIFICATION_INPUT_ERROR");
  }
  const packageDir = info.isDirectory() ? resolved : dirname(resolved);
  const packageInfo = await lstat(packageDir).catch(() => undefined);
  if (!packageInfo?.isDirectory() || packageInfo.isSymbolicLink()) {
    throw new CliError("Certification package root must be a regular directory", "CERTIFICATION_INPUT_ERROR");
  }
  const profileIds = STATIC_PORTABILITY_POLICY.compatibility.requiredProfiles.map((profile) => profile.id);
  const [validation, security, compatibility] = await Promise.all([
    collectCertificationValidation(packageDir),
    scanPackageSecurity(packageDir),
    assessPackageCompatibility(packageDir, profileIds)
  ]);
  const report = certifyPluginEvidence({ validation, security, compatibility });
  const payload = { ok: report.status === "certified", command: "certify", version: CLI_VERSION, target: packageDir, ...report };
  if (json) stdout(JSON.stringify(payload));
  else renderCertification(payload, stdout, stderr);
  return payload.ok ? 0 : 1;
}

function parseBuildArgs(args: string[]): ParsedBuildOptions {
  const valueOptions = new Set(["--mcp", "--openapi", "--ir", "--out", "--name"]);
  const booleanOptions = new Set([
    "--force", "--json", "--no-discover", "--allow-stdio-discovery",
    "--allow-private-network", "--allow-insecure-http", "--allow-cross-origin-refs",
    "--allow-external-file-refs"
  ]);
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (valueOptions.has(arg)) {
      if (values.has(arg)) throw new CliError(`${arg} may only be provided once`, "USAGE_ERROR", 2);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new CliError(`${arg} requires a value`, "USAGE_ERROR", 2);
      values.set(arg, value);
      continue;
    }
    if (booleanOptions.has(arg)) {
      flags.add(arg);
      continue;
    }
    throw new CliError(`Unknown build option: ${arg}`, "USAGE_ERROR", 2);
  }

  const sources = (["--mcp", "--openapi", "--ir"] as const)
    .filter((name) => values.has(name))
    .map((name) => ({ option: name, value: values.get(name)! }));
  if (sources.length !== 1) throw new CliError("build requires exactly one of --mcp, --openapi, or --ir", "USAGE_ERROR", 2);
  const selected = sources[0]!;
  const sourceKind: SourceKind = selected.option === "--mcp" ? "mcp" : selected.option === "--openapi" ? "openapi" : "ir";

  validateSourceSpecificFlags(sourceKind, flags);
  if (sourceKind === "ir" && values.has("--name")) throw new CliError("--name is not supported with --ir", "USAGE_ERROR", 2);
  return {
    sourceKind,
    source: selected.value,
    out: values.get("--out"),
    name: values.get("--name"),
    force: flags.has("--force"),
    json: flags.has("--json"),
    flags
  };
}

function parseValidateArgs(args: string[]): { target: string; json: boolean } {
  let target = ".";
  let seenTarget = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--")) throw new CliError(`Unknown validate option: ${arg}`, "USAGE_ERROR", 2);
    if (seenTarget) throw new CliError("validate accepts only one target", "USAGE_ERROR", 2);
    target = arg;
    seenTarget = true;
  }
  return { target, json };
}

function parseScanArgs(args: string[]): { target: string; json: boolean; failOn: ScanThreshold } {
  let target = ".";
  let seenTarget = false;
  let json = false;
  let failOn: ScanThreshold = "high";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--fail-on") {
      const value = args[++index] as ScanThreshold | undefined;
      if (!value || !["none", "info", "low", "medium", "high", "critical"].includes(value)) {
        throw new CliError("--fail-on requires one of: none, info, low, medium, high, critical", "USAGE_ERROR", 2);
      }
      failOn = value;
      continue;
    }
    if (arg.startsWith("--")) throw new CliError(`Unknown scan option: ${arg}`, "USAGE_ERROR", 2);
    if (seenTarget) throw new CliError("scan accepts only one target", "USAGE_ERROR", 2);
    target = arg;
    seenTarget = true;
  }
  return { target, json, failOn };
}

function parseCompatArgs(args: string[]): { target: string; json: boolean; profileIds: string[] } {
  let target = ".";
  let seenTarget = false;
  let json = false;
  let profile: string | undefined;
  let all = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--all") {
      if (all) throw new CliError("--all may only be provided once", "USAGE_ERROR", 2);
      all = true;
      continue;
    }
    if (arg === "--profile") {
      if (profile) throw new CliError("--profile may only be provided once", "USAGE_ERROR", 2);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new CliError("--profile requires a profile ID", "USAGE_ERROR", 2);
      profile = value;
      continue;
    }
    if (arg.startsWith("--")) throw new CliError(`Unknown compat option: ${arg}`, "USAGE_ERROR", 2);
    if (seenTarget) throw new CliError("compat accepts only one target", "USAGE_ERROR", 2);
    target = arg;
    seenTarget = true;
  }
  if (all && profile) throw new CliError("--profile and --all cannot be used together", "USAGE_ERROR", 2);
  const profileIds = all
    ? BUILT_IN_COMPATIBILITY_PROFILES.map((candidate) => candidate.id)
    : [profile ?? PORTABLE_CORE_PROFILE_ID];
  for (const profileId of profileIds) {
    if (!BUILT_IN_COMPATIBILITY_PROFILES.some((candidate) => candidate.id === profileId)) {
      const error = new UnknownCompatibilityProfileError(profileId);
      throw new CliError(`${error.message}. Available profiles: ${BUILT_IN_COMPATIBILITY_PROFILES.map((candidate) => candidate.id).join(", ")}`, "USAGE_ERROR", 2);
    }
  }
  return { target, json, profileIds };
}

function parseCompatRuntimeArgs(args: string[]): {
  target: string;
  json: boolean;
  options: RuntimeCompatibilityOptions;
  client?: {
    adapterId: string;
    allowExecution: boolean;
    allowMcpRuntime: boolean;
    allowSyntheticFixture: boolean;
    executablePath?: string;
    grantedCapabilities: ClientRuntimeCapability[];
  };
} {
  let target = ".";
  let seenTarget = false;
  let json = false;
  let timeoutMs: number | undefined;
  let clientAdapterId: string | undefined;
  let allowClientRuntime = false;
  let allowClientMcpRuntime = false;
  let allowSyntheticFixture = false;
  let clientExecutable: string | undefined;
  const grantedCapabilities = new Set<ClientRuntimeCapability>();
  const options: RuntimeCompatibilityOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--allow-stdio-runtime") { options.allowStdioRuntime = true; continue; }
    if (arg === "--allow-private-network") { options.allowPrivateNetwork = true; continue; }
    if (arg === "--allow-insecure-http") { options.allowInsecureHttp = true; continue; }
    if (arg === "--allow-client-runtime") { allowClientRuntime = true; continue; }
    if (arg === "--allow-client-mcp-runtime") { allowClientMcpRuntime = true; continue; }
    if (arg === "--allow-synthetic-fixture") { allowSyntheticFixture = true; continue; }
    if (arg === "--allow-client-package-read") { grantedCapabilities.add("package-read"); continue; }
    if (arg === "--allow-client-process") { grantedCapabilities.add("client-process"); continue; }
    if (arg === "--allow-client-filesystem") { grantedCapabilities.add("client-filesystem"); continue; }
    if (arg === "--allow-client-network") { grantedCapabilities.add("network"); continue; }
    if (arg === "--client-executable") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new CliError("--client-executable requires an absolute executable path", "USAGE_ERROR", 2);
      if (clientExecutable !== undefined) throw new CliError("--client-executable may only be provided once", "USAGE_ERROR", 2);
      if (!isAbsolute(value) || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new CliError("--client-executable requires a bounded absolute executable path", "USAGE_ERROR", 2);
      }
      clientExecutable = value;
      continue;
    }
    if (arg === "--client-adapter") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new CliError("--client-adapter requires an adapter id", "USAGE_ERROR", 2);
      if (clientAdapterId !== undefined) throw new CliError("--client-adapter may only be provided once", "USAGE_ERROR", 2);
      clientAdapterId = value;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) throw new CliError("--timeout-ms requires an integer from 100 to 30000", "USAGE_ERROR", 2);
      timeoutMs = Number(value);
      if (timeoutMs < 100 || timeoutMs > 30_000) throw new CliError("--timeout-ms requires an integer from 100 to 30000", "USAGE_ERROR", 2);
      continue;
    }
    if (arg.startsWith("--")) throw new CliError(`Unknown compat-runtime option: ${arg}`, "USAGE_ERROR", 2);
    if (seenTarget) throw new CliError("compat-runtime accepts only one target", "USAGE_ERROR", 2);
    target = arg;
    seenTarget = true;
  }
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  if (clientAdapterId !== undefined) {
    if (options.allowStdioRuntime || options.allowPrivateNetwork || options.allowInsecureHttp) {
      throw new CliError("MCP runtime permission options cannot be combined with --client-adapter", "USAGE_ERROR", 2);
    }
    if (clientAdapterId === VSCODE_CLIENT_RUNTIME_ADAPTER_ID && clientExecutable === undefined) {
      throw new CliError(
        "The vscode-github-copilot adapter requires --client-executable with an absolute VS Code executable path",
        "USAGE_ERROR",
        2
      );
    }
    if (clientAdapterId === "synthetic-fixture"
      && (clientExecutable !== undefined || grantedCapabilities.size > 0 || allowClientMcpRuntime)) {
      throw new CliError(
        "The synthetic-fixture adapter accepts no executable path or client capability grants",
        "USAGE_ERROR",
        2
      );
    }
    if (allowClientMcpRuntime && clientAdapterId !== VSCODE_CLIENT_RUNTIME_ADAPTER_ID) {
      throw new CliError(
        "--allow-client-mcp-runtime is supported only by the vscode-github-copilot adapter",
        "USAGE_ERROR",
        2
      );
    }
    if (allowClientMcpRuntime && !allowClientRuntime) {
      throw new CliError(
        "--allow-client-mcp-runtime also requires --allow-client-runtime",
        "USAGE_ERROR",
        2
      );
    }
    return {
      target,
      json,
      options,
      client: {
        adapterId: clientAdapterId,
        allowExecution: allowClientRuntime,
        allowMcpRuntime: allowClientMcpRuntime,
        allowSyntheticFixture,
        ...(clientExecutable ? { executablePath: clientExecutable } : {}),
        grantedCapabilities: [...grantedCapabilities]
      }
    };
  }
  if (allowClientRuntime || allowClientMcpRuntime || allowSyntheticFixture
    || clientExecutable !== undefined || grantedCapabilities.size > 0) {
    throw new CliError("Client runtime opt-ins require --client-adapter", "USAGE_ERROR", 2);
  }
  return { target, json, options };
}

function createCliClientAdapterRegistry(
  executablePath?: string,
  timeoutMs = 5_000,
  allowMcpRuntime = false
): ClientRuntimeAdapterRegistry {
  return new ClientRuntimeAdapterRegistry([
    createSyntheticFixtureClientAdapter(),
    createVscodeClientRuntimeAdapter({
      executablePath: executablePath ?? "",
      allowMcpRuntime,
      observationWindowMs: Math.max(100, Math.min(20_000, timeoutMs - 2_500))
    })
  ]);
}

function parseCertifyArgs(args: string[]): { target: string; json: boolean } {
  let target = ".";
  let seenTarget = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      if (json) throw new CliError("--json may only be provided once", "USAGE_ERROR", 2);
      json = true;
      continue;
    }
    if (arg.startsWith("--")) throw new CliError(`Unknown certify option: ${arg}`, "USAGE_ERROR", 2);
    if (seenTarget) throw new CliError("certify accepts only one target", "USAGE_ERROR", 2);
    target = arg;
    seenTarget = true;
  }
  return { target, json };
}

function validateSourceSpecificFlags(sourceKind: SourceKind, flags: Set<string>): void {
  const mcpOnly = ["--no-discover", "--allow-stdio-discovery"];
  const openApiOnly = ["--allow-cross-origin-refs", "--allow-external-file-refs"];
  if (sourceKind !== "mcp") {
    for (const flag of mcpOnly) if (flags.has(flag)) throw new CliError(`${flag} is only valid with --mcp`, "USAGE_ERROR", 2);
  }
  if (sourceKind !== "openapi") {
    for (const flag of openApiOnly) if (flags.has(flag)) throw new CliError(`${flag} is only valid with --openapi`, "USAGE_ERROR", 2);
  }
  if (sourceKind === "ir") {
    for (const flag of ["--allow-private-network", "--allow-insecure-http"]) {
      if (flags.has(flag)) throw new CliError(`${flag} is not valid with --ir`, "USAGE_ERROR", 2);
    }
  }
}

function normalizeLegacyArgs(args: string[]): string[] {
  if (["build", "validate", "scan", "compat", "compat-runtime", "certify"].includes(args[0]!)) return args;
  if (args[0]?.startsWith("--")) return ["build", ...args];
  if (args[0]) {
    const [input, maybeOut, ...rest] = args;
    return maybeOut && !maybeOut.startsWith("--")
      ? ["build", "--ir", input, "--out", maybeOut, ...rest]
      : ["build", "--ir", input, ...rest];
  }
  return args;
}
async function writeCompiledPackage(compiled: CompiledPlugin, outDir: string, cwd: string, force: boolean): Promise<void> {
  assertSafeOutputTarget(outDir, cwd);
  const skillEntries = Object.entries(compiled.skills).sort(([a], [b]) => a.localeCompare(b));
  const skillsRoot = resolve(outDir, "skills");
  const portableSkillNames = new Set<string>();
  for (const [name] of skillEntries) {
    assertSafeSkillName(name);
    const portableName = name.toLowerCase();
    if (portableSkillNames.has(portableName)) throw new CliError(`Skill names collide on case-insensitive filesystems: ${name}`, "OUTPUT_UNSAFE");
    portableSkillNames.add(portableName);
    assertPathWithin(skillsRoot, resolve(skillsRoot, name), `Skill path escapes package output: ${name}`);
  }
  const existingLink = await lstat(outDir).catch(() => undefined);
  if (existingLink?.isSymbolicLink()) throw new CliError(`Output path must not be a symbolic link: ${outDir}`, "OUTPUT_UNSAFE");
  const existing = await stat(outDir).catch(() => undefined);
  if (existing) {
    const [realOutput, realCwd] = await Promise.all([realpath(outDir), realpath(cwd)]);
    assertSafeOutputTarget(realOutput, realCwd);
  }
  if (existing && !existing.isDirectory()) throw new CliError(`Output path is not a directory: ${outDir}`, "OUTPUT_INVALID");
  if (existing) {
    const entries = await readdir(outDir);
    if (entries.length && !force) throw new CliError(`Output directory is not empty: ${outDir}. Re-run with --force to replace it.`, "OUTPUT_EXISTS");
    if (entries.length && force) {
      await assertReplaceableGeneratedDirectory(outDir);
      await rm(outDir, { recursive: true, force: true });
    }
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "plugin.json"), `${JSON.stringify(compiled.manifest, null, 2)}\n`, "utf8");
  if (compiled.mcp) await writeFile(join(outDir, "mcp.json"), `${JSON.stringify(compiled.mcp, null, 2)}\n`, "utf8");
  for (const [name, content] of skillEntries) {
    const skillDir = resolve(skillsRoot, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
  }
}

async function assertReplaceableGeneratedDirectory(outDir: string): Promise<void> {
  const entries = await readdir(outDir, { withFileTypes: true });
  const allowed = new Set(["plugin.json", "mcp.json", "skills"]);
  for (const entry of entries) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      throw new CliError(`Refusing to replace directory with non-generated content: ${join(outDir, entry.name)}`, "OUTPUT_UNSAFE");
    }
  }

  const pluginEntry = entries.find((entry) => entry.name === "plugin.json");
  if (!pluginEntry?.isFile()) throw new CliError(`Refusing to replace a non-generated directory: ${outDir}`, "OUTPUT_UNSAFE");
  const manifest = await readJsonRecord(join(outDir, "plugin.json"), "Existing plugin.json").catch(() => undefined);
  if (!manifest) throw new CliError(`Refusing to replace a non-generated directory: ${outDir}`, "OUTPUT_UNSAFE");

  const mcpEntry = entries.find((entry) => entry.name === "mcp.json");
  if (mcpEntry && !mcpEntry.isFile()) throw new CliError(`Refusing to replace malformed generated content: ${join(outDir, "mcp.json")}`, "OUTPUT_UNSAFE");
  const mcp = mcpEntry ? await readJsonRecord(join(outDir, "mcp.json"), "Existing mcp.json").catch(() => undefined) : undefined;
  if (mcpEntry && !mcp) throw new CliError(`Refusing to replace malformed generated content: ${join(outDir, "mcp.json")}`, "OUTPUT_UNSAFE");
  if (!validateCompiledPlugin(manifest, mcp).ok) throw new CliError(`Refusing to replace a non-generated directory: ${outDir}`, "OUTPUT_UNSAFE");

  const skillsEntry = entries.find((entry) => entry.name === "skills");
  if (!skillsEntry) return;
  if (!skillsEntry.isDirectory()) throw new CliError(`Refusing to replace malformed generated content: ${join(outDir, "skills")}`, "OUTPUT_UNSAFE");
  await assertGeneratedSkillsDirectory(join(outDir, "skills"));
}

async function assertGeneratedSkillsDirectory(skillsRoot: string): Promise<void> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  if (entries.length === 0) throw new CliError(`Refusing to replace empty non-generated skills directory: ${skillsRoot}`, "OUTPUT_UNSAFE");
  const portableNames = new Set<string>();
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new CliError(`Refusing to replace directory with non-generated skill content: ${join(skillsRoot, entry.name)}`, "OUTPUT_UNSAFE");
    }
    assertSafeSkillName(entry.name);
    const portableName = entry.name.toLowerCase();
    if (portableNames.has(portableName)) throw new CliError(`Existing skill names collide on case-insensitive filesystems: ${entry.name}`, "OUTPUT_UNSAFE");
    portableNames.add(portableName);

    const skillDir = join(skillsRoot, entry.name);
    const files = await readdir(skillDir, { withFileTypes: true });
    if (files.length !== 1 || files[0]?.name !== "SKILL.md" || !files[0].isFile() || files[0].isSymbolicLink()) {
      throw new CliError(`Refusing to replace directory with non-generated skill content: ${skillDir}`, "OUTPUT_UNSAFE");
    }
    const content = await readFile(join(skillDir, "SKILL.md"), "utf8");
    const expectedPrefix = `---\nname: ${JSON.stringify(entry.name)}\n`;
    if (!content.startsWith(expectedPrefix)) throw new CliError(`Refusing to replace malformed generated skill: ${skillDir}`, "OUTPUT_UNSAFE");
  }
}

function assertSafeOutputTarget(outDir: string, cwd: string): void {
  const output = resolve(outDir);
  const invocation = resolve(cwd);
  if (isSameOrAncestor(output, invocation)) {
    throw new CliError(`Refusing unsafe output directory: ${outDir}`, "OUTPUT_UNSAFE");
  }
}

function assertSafeSkillName(name: string): void {
  const portable = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
  if (!portable || windowsReserved) throw new CliError(`Unsafe skill name for package output: ${name}`, "OUTPUT_UNSAFE");
}

function assertPathWithin(root: string, candidate: string, message: string): void {
  const path = relative(resolve(root), resolve(candidate));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new CliError(message, "OUTPUT_UNSAFE");
  }
}

function isSameOrAncestor(candidate: string, target: string): boolean {
  const path = relative(resolve(candidate), resolve(target));
  return !path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  const info = await stat(path).catch(() => undefined);
  if (!info || !info.isFile()) throw new CliError(`${label} not found: ${path}`, "INPUT_NOT_FOUND");
  if (info.size > MAX_JSON_BYTES) throw new CliError(`${label} exceeds ${MAX_JSON_BYTES / 1_000_000} MB safety limit`, "INPUT_TOO_LARGE");
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new CliError(`${label} is not valid JSON: ${errorMessage(error)}`, "INPUT_INVALID");
  }
}

async function readJsonRecord(path: string, label: string): Promise<Record<string, unknown>> {
  const value = await readJsonFile(path, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${label} must contain a JSON object`, "VALIDATION_INPUT_ERROR");
  return value as Record<string, unknown>;
}

async function collectCertificationValidation(packageDir: string): Promise<ValidationResult> {
  const manifestRead = await readCertificationJsonRecord(join(packageDir, "plugin.json"), "plugin.json", true);
  const mcpRead = await readCertificationJsonRecord(join(packageDir, "mcp.json"), "mcp.json", false);
  const result = validateCompiledPlugin(manifestRead.value, mcpRead.value);
  const inputErrors = [manifestRead.error, mcpRead.error].filter((message): message is string => Boolean(message));
  return {
    ok: result.ok && inputErrors.length === 0,
    errors: [...new Set([...result.errors, ...inputErrors])],
    warnings: result.warnings
  };
}

async function readCertificationJsonRecord(
  path: string,
  label: string,
  required: boolean
): Promise<{ value?: Record<string, unknown>; error?: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: `${label} is missing or could not be read safely` };
  }
  if (info.isSymbolicLink() || !info.isFile()) return { error: `${label} must be a regular file and not a symbolic link` };
  if (info.size > MAX_JSON_BYTES) return { error: `${label} exceeds the ${MAX_JSON_BYTES} byte certification input limit` };
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${label} must contain a JSON object` };
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: `${label} is not valid JSON` };
  }
}
function resolveSource(cwd: string, source: string): string {
  return /^https?:\/\//i.test(source) ? source : resolve(cwd, source);
}

function deriveServerName(source: string): string {
  try {
    const host = new URL(source).hostname.replace(/^www\./, "");
    return host.split(".")[0] || "mcp-server";
  } catch {
    return "mcp-server";
  }
}

function renderValidationFailure(
  result: ValidationResult,
  json: boolean,
  stdout: (message: string) => void,
  stderr: (message: string) => void
): 1 {
  const payload = { ok: false, command: "build", version: CLI_VERSION, error: { code: "VALIDATION_FAILED", message: "Compiled package failed validation" }, errors: result.errors, warnings: result.warnings, exitCode: 1 };
  if (json) stdout(JSON.stringify(payload));
  else {
    stderr("VALIDATION_FAILED");
    for (const error of result.errors) stderr(`- ${error}`);
  }
  return 1;
}

function renderBuildSuccess(
  payload: {
    outputDir: string;
    plugin: string;
    counts: { skills: number; mcpServers: number; capabilities: number };
    security: SecurityScanResult & { mode: "report-only" };
    compatibility: CompatibilitySuiteReport & { mode: "report-only" };
    warnings: Warning[];
  },
  stdout: (message: string) => void,
  stderr: (message: string) => void
): void {
  for (const warning of payload.warnings) stderr(`WARNING ${warning.code}${warning.scope ? ` [${warning.scope}]` : ""}: ${warning.message}`);
  stdout(`BUILD_OK ${payload.outputDir}`);
  stdout(`PLUGIN ${payload.plugin}`);
  stdout(`SKILLS ${payload.counts.skills}`);
  stdout(`MCP_SERVERS ${payload.counts.mcpServers}`);
  stdout(`CAPABILITIES ${payload.counts.capabilities}`);
  stdout("AGENT_PLUGINS_1_0_VALIDATION_PASS");
  if (payload.security.findings.length === 0 && payload.security.complete) {
    stdout("SECURITY_SCAN_PASS");
  } else {
    stdout(`SECURITY_FINDINGS ${payload.security.findings.length} REPORT_ONLY`);
    for (const finding of payload.security.findings) {
      stderr(`SECURITY ${finding.severity.toUpperCase()} ${finding.id} [${sanitizeConsoleText(finding.location)}]: ${sanitizeConsoleText(finding.title)}`);
    }
  }
  stdout(`COMPATIBILITY_STATIC_${payload.compatibility.staticEligibility.toUpperCase()} ${PORTABLE_CORE_PROFILE_ID} REPORT_ONLY`);
}

function renderSecurityScan(
  payload: {
    ok: boolean;
    target: string;
    complete: boolean;
    policy: { failOn: ScanThreshold };
    summary: SecurityScanResult["summary"];
    findings: SecurityScanResult["findings"];
    blockingFindings: number;
    incompleteScanBlocked: boolean;
  },
  stdout: (message: string) => void,
  stderr: (message: string) => void
): void {
  const write = payload.ok ? stdout : stderr;
  write(`${payload.ok ? "SECURITY_SCAN_OK" : "SECURITY_SCAN_FAILED"} ${sanitizeConsoleText(payload.target)}`);
  write(`SECURITY_SCAN_COMPLETE ${payload.complete}`);
  write(`SECURITY_POLICY fail-on=${payload.policy.failOn} blocking=${payload.blockingFindings} incomplete-blocked=${payload.incompleteScanBlocked}`);
  write(`SECURITY_SUMMARY critical=${payload.summary.critical} high=${payload.summary.high} medium=${payload.summary.medium} low=${payload.summary.low} info=${payload.summary.info}`);
  for (const finding of payload.findings) {
    write(`[${finding.severity.toUpperCase()}] ${finding.id} ${sanitizeConsoleText(finding.location)}: ${sanitizeConsoleText(finding.title)}`);
    write(`  Evidence: ${sanitizeConsoleText(finding.evidence)}`);
    write(`  Remediation: ${sanitizeConsoleText(finding.remediation)}`);
  }
}

function renderCompatibility(
  payload: CompatibilitySuiteReport & { ok: boolean; target: string },
  stdout: (message: string) => void,
  stderr: (message: string) => void
): void {
  const write = payload.ok ? stdout : stderr;
  write(`COMPATIBILITY_STATIC_${payload.staticEligibility.toUpperCase()} ${sanitizeConsoleText(payload.target)}`);
  write(`COMPATIBILITY_EVIDENCE_LEVEL ${payload.evidenceLevel}`);
  write(`COMPATIBILITY_COMPLETE ${payload.complete}`);
  for (const profile of payload.profiles) {
    write(`PROFILE ${profile.profile.id}@${profile.profile.version} status=${profile.status} static-eligibility=${profile.staticEligibility}`);
    write(`SUMMARY pass=${profile.summary.pass} warn=${profile.summary.warn} fail=${profile.summary.fail} unknown=${profile.summary.unknown}`);
    for (const test of profile.tests) {
      write(`[${test.status.toUpperCase()}] ${test.id}: ${sanitizeConsoleText(test.title)}`);
      for (const evidence of test.evidence) {
        write(`  Evidence ${sanitizeConsoleText(evidence.location)}: ${sanitizeConsoleText(evidence.summary)}`);
      }
    }
  }
  write("RUNTIME_EVIDENCE verified=false client-install=not-assessed mcp-handshake=not-assessed");
  write(`NOTE ${sanitizeConsoleText(payload.runtimeEvidence.note)}`);
}

function renderRuntimeCompatibility(
  payload: RuntimeCompatibilityReport & { ok: boolean; target: string },
  stdout: (message: string) => void,
  stderr: (message: string) => void
): void {
  const write = payload.ok ? stdout : stderr;
  write(`RUNTIME_COMPATIBILITY_${payload.status.toUpperCase().replace("-", "_")} ${sanitizeConsoleText(payload.target)}`);
  write(`RUNTIME_SCOPE ${payload.scope} complete=${payload.complete} interoperability=${payload.interoperability}`);
  write(`RUNTIME_CLIENT install=${payload.clientInstall} load=${payload.clientLoad} mcp-handshake=${payload.mcpHandshake}`);
  write(`RUNTIME_SUMMARY pass=${payload.summary.pass} fail=${payload.summary.fail} unknown=${payload.summary.unknown} not-assessed=${payload.summary.notAssessed}`);
  for (const server of payload.servers) {
    write(`SERVER ${sanitizeConsoleText(server.name)} transport=${server.transport} status=${server.status} startup=${server.startup} handshake=${server.handshake} complete=${server.complete}`);
    for (const item of server.evidence) write(`  [${item.code}] ${sanitizeConsoleText(item.summary)}`);
  }
  for (const item of payload.evidence) write(`[${item.code}] ${sanitizeConsoleText(item.summary)}`);
  write(`NOTE ${sanitizeConsoleText(payload.note)}`);
}

function renderClientRuntimeCompatibility(
  payload: ClientRuntimeReport & { ok: boolean; target: string },
  stdout: (message: string) => void,
  stderr: (message: string) => void
): void {
  const write = payload.ok ? stdout : stderr;
  write(`CLIENT_RUNTIME_${payload.execution.status.toUpperCase().replace("-", "_")} ${sanitizeConsoleText(payload.target)}`);
  write(`CLIENT_RUNTIME_SCOPE ${payload.scope} complete=${payload.execution.complete} synthetic=${payload.synthetic} interoperability=${payload.interoperability} interoperability-scope=${payload.interoperabilityScope}`);
  write(`CLIENT_ADAPTER ${payload.adapter.id}@${payload.adapter.version}`);
  write(`TARGET_CLIENT ${payload.targetClient.id}${payload.targetClient.version ? `@${payload.targetClient.version}` : "@unknown"}`);
  write(`CLIENT_OBSERVATIONS install=${payload.packageInstall} load=${payload.clientLoad} mcp-startup=${payload.mcpStartup} mcp-handshake=${payload.mcpHandshake} tool-exposure=${payload.toolExposure} tool-invocation=${payload.toolInvocation} finalize=${payload.execution.finalize}`);
  for (const item of payload.evidence) write(`[${item.code}] ${sanitizeConsoleText(item.summary)}`);
  write(`NOTE ${sanitizeConsoleText(payload.note)}`);
}

function renderCertification(
  payload: CertificationReport & { ok: boolean; target: string },
  stdout: (message: string) => void,
  stderr: (message: string) => void
): void {
  const write = payload.ok ? stdout : stderr;
  write(`CERTIFICATION_${payload.status.toUpperCase().replace("-", "_")} ${sanitizeConsoleText(payload.target)}`);
  write(`CERTIFICATION_POLICY ${payload.policy.id}@${payload.policy.version} complete=${payload.complete}`);
  for (const check of payload.checks) {
    write(`[${check.status.toUpperCase()}] ${check.id}@${check.version}: ${sanitizeConsoleText(check.title)}`);
    for (const evidence of check.evidence) {
      write(`  Evidence ${sanitizeConsoleText(evidence.location)}: ${sanitizeConsoleText(evidence.summary)}`);
      if (evidence.remediation) write(`  Remediation: ${sanitizeConsoleText(evidence.remediation)}`);
    }
  }
  write("RUNTIME_EVIDENCE verified=false client-install=not-assessed mcp-handshake=not-assessed");
  write(`NOTE ${sanitizeConsoleText(payload.runtimeEvidence.note)}`);
}

function renderFailure(
  error: unknown,
  json: boolean,
  stdout: (message: string) => void,
  stderr: (message: string) => void
): number {
  const cliError = error instanceof CliError
    ? error
    : new CliError(sanitizeErrorMessage(errorMessage(error)), "BUILD_FAILED");
  const message = sanitizeErrorMessage(cliError.message);
  if (json) {
    stdout(JSON.stringify({
      ok: false,
      version: CLI_VERSION,
      error: { code: cliError.code, message },
      exitCode: cliError.exitCode
    }));
  } else {
    stderr(`ERROR ${cliError.code}: ${sanitizeConsoleText(message)}`);
    if (cliError.exitCode === 2) stderr("Run agentplugin --help for usage.");
  }
  return cliError.exitCode;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactSource(source: string): string {
  if (!/^https?:\/\//i.test(source)) return source;
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    if (url.search) url.search = "?REDACTED";
    return url.toString();
  } catch {
    return source;
  }
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s)\]}]+/gi, (candidate) => redactSource(candidate));
}

function sanitizeConsoleText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function helpText(): string {
  return `Agent Plugin CI ${CLI_VERSION}

Usage:
  agentplugin build --mcp <config-or-url> [options]
  agentplugin build --openapi <spec-or-url> [options]
  agentplugin build --ir <plugin-ir.json> [options]
  agentplugin validate [package-dir|plugin.json] [--json]
  agentplugin scan [package-dir|plugin.json] [--fail-on <severity>] [--json]
  agentplugin compat [package-dir|plugin.json] [--profile <id>|--all] [--json]
  agentplugin compat-runtime [package-dir|plugin.json] [options]
  agentplugin certify [package-dir|plugin.json] [--json]
  agentplugin --version

Build options:
  --name <name>                   Override derived plugin name (MCP/OpenAPI)
  --out <dir>                     Output directory (default: ./dist/<plugin-name>)
  --force                         Replace a non-empty output directory
  --json                          Emit one machine-readable JSON result

MCP options:
  --no-discover                   Skip MCP capability discovery
  --allow-stdio-discovery         Permit launching stdio MCP servers for discovery
  --allow-private-network         Permit private-network MCP targets
  --allow-insecure-http           Permit insecure HTTP MCP targets

OpenAPI options:
  --allow-private-network         Permit private-network specification/ref targets
  --allow-insecure-http           Permit insecure HTTP specification/ref targets
  --allow-cross-origin-refs       Permit cross-origin remote $ref targets
  --allow-external-file-refs      Permit file $refs outside the source root

Security scan options:
  --fail-on <severity>            Fail on info|low|medium|high|critical (default: high)
  --fail-on none                  Report findings without a non-zero policy exit
  --json                          Emit findings, evidence, remediation, and summary as JSON

Compatibility options:
  --profile <id>                  Run one versioned profile (default: ${PORTABLE_CORE_PROFILE_ID})
  --all                           Run every built-in static compatibility profile
  --json                          Emit deterministic static evidence and summaries as JSON

Runtime compatibility options:
  --allow-stdio-runtime           Explicitly permit stdio MCP process execution for this runtime assessment
  --allow-private-network         Permit private-network remote MCP runtime targets
  --allow-insecure-http           Permit insecure HTTP remote MCP runtime targets
  --timeout-ms <100-30000>        MCP initialize or client lifecycle timeout (default: 5000)
  --client-adapter <id>           Use synthetic-fixture or real vscode-github-copilot (MCP disabled by default)
  --client-executable <path>      Required absolute VS Code executable path for vscode-github-copilot
  --allow-client-runtime          Explicitly permit the selected client adapter lifecycle
  --allow-client-mcp-runtime      Permit one preflighted stdio server and eligible deterministic tool invocation through VS Code (default: denied)
  --allow-client-package-read     Grant the selected adapter bounded package-root read access
  --allow-client-process          Grant the selected adapter direct client process execution
  --allow-client-filesystem       Grant isolated client state/log filesystem access
  --allow-client-network          Grant possible client network access (required for VS Code fail-closed gating)
  --allow-synthetic-fixture       Permit the synthetic-fixture test adapter (never real evidence)
  --json                          Emit bounded MCP or client-runtime evidence as JSON

Certification:
  Aggregates official validation, fail-on-high security, and the three pinned Phase 2J
  compatibility profiles. Static certification does not prove runtime interoperability.
  --json                          Emit the deterministic certification report as JSON

Exit codes:
  0  Success
  1  Build, input, security, validation, compatibility, or certification failure/unknown
  2  Invalid CLI usage

Security defaults are deny-by-default for stdio and client-adapter execution/capabilities,
synthetic fixtures, private-network access, insecure HTTP, cross-origin OpenAPI refs,
and external file refs.`;
}
