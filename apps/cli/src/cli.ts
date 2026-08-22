import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compilePlugin, type CompiledPlugin } from "@agent-plugin-ci/compiler";
import { createSdkMcpToolDiscoverer, ingestMcpConfig, mcpConfigFromUrl } from "@agent-plugin-ci/ingest-mcp";
import { ingestOpenApiSource } from "@agent-plugin-ci/ingest-openapi";
import type { PluginIR } from "@agent-plugin-ci/plugin-ir";
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
  if (["build", "validate"].includes(args[0]!)) return args;
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
  for (const [name] of skillEntries) {
    assertSafeSkillName(name);
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
      const pluginPath = join(outDir, "plugin.json");
      const pluginFile = await stat(pluginPath).catch(() => undefined);
      const manifest = pluginFile?.isFile() ? await readJsonRecord(pluginPath, "Existing plugin.json").catch(() => undefined) : undefined;
      if (!manifest || !validateCompiledPlugin(manifest).ok) throw new CliError(`Refusing to replace a non-generated directory: ${outDir}`, "OUTPUT_UNSAFE");
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
  payload: { outputDir: string; plugin: string; counts: { skills: number; mcpServers: number; capabilities: number }; warnings: Warning[] },
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
    stderr(`ERROR ${cliError.code}: ${message}`);
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
function helpText(): string {
  return `Agent Plugin CI ${CLI_VERSION}

Usage:
  agentplugin build --mcp <config-or-url> [options]
  agentplugin build --openapi <spec-or-url> [options]
  agentplugin build --ir <plugin-ir.json> [options]
  agentplugin validate [package-dir|plugin.json] [--json]
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

Exit codes:
  0  Success
  1  Build, input, security, or validation failure
  2  Invalid CLI usage

Security defaults are deny-by-default for stdio execution, private-network access,
insecure HTTP, cross-origin OpenAPI refs, and external file refs.`;
}
