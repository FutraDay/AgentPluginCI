import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { constants, lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  VSCODE_COPILOT_CLIENT_RUNTIME_TARGET_ID,
  type ClientRuntimeAdapter,
  type ClientRuntimeAdapterContext,
  type ClientRuntimeAdapterOutput,
  type ClientRuntimeExecutionStatus
} from "./client-runtime.js";

export const VSCODE_CLIENT_RUNTIME_ADAPTER_ID = VSCODE_COPILOT_CLIENT_RUNTIME_TARGET_ID;
export const VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES = Object.freeze([
  "package-read",
  "client-process",
  "client-filesystem",
  // VS Code has no reliable process-level offline switch. Requiring this grant is fail-closed.
  "network"
] as const);

const ADAPTER_VERSION = "1.1.0";
const MIN_OBSERVATION_MS = 100;
const MAX_OBSERVATION_MS = 20_000;
const DEFAULT_OBSERVATION_MS = 2_500;
const VERSION_TIMEOUT_MS = 2_000;
const TERMINATION_TIMEOUT_MS = 750;
const MAX_PATH_LENGTH = 4_096;
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_FILE_BYTES = 128 * 1024;
const MAX_LOG_ENTRIES = 256;
const MAX_LOG_DEPTH = 7;
const MAX_PACKAGE_ENTRIES = 4_096;
const MAX_PACKAGE_DEPTH = 16;
const MAX_WINDOWS_LAUNCHER_BYTES = 8 * 1024;
const MAX_WINDOWS_BUNDLED_CLI_BYTES = 16 * 1024 * 1024;
const TEMP_PREFIX = "agentplugin-vscode-";

interface RuntimeChildProcess {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

interface RuntimeSpawnOptions extends SpawnOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
  detached: boolean;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface VscodeClientRuntimeDependencies {
  spawn(executable: string, args: readonly string[], options: RuntimeSpawnOptions): RuntimeChildProcess;
  killProcess(pid: number, signal: NodeJS.Signals): void;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  tempDirectory(): string;
}

export interface VscodeClientRuntimeAdapterOptions {
  executablePath: string;
  observationWindowMs?: number;
  dependencies?: Partial<VscodeClientRuntimeDependencies>;
}

interface AdapterState {
  executablePath: string;
  packageRoot: string;
  tempBase: string;
  tempRoot: string;
  userDataDir: string;
  extensionsDir: string;
  homeDir: string;
  observationFile: string;
  environment: NodeJS.ProcessEnv;
}

interface VersionObservation {
  version: string;
  source: "bundled-cli" | "direct-executable";
}

type ExitResult =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error" };

interface LaunchedProcess {
  child: RuntimeChildProcess;
  exit: Promise<ExitResult>;
  output: () => string;
  groupSafe: boolean;
  exited: boolean;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

const DEFAULT_DEPENDENCIES: VscodeClientRuntimeDependencies = {
  spawn(executable, args, options) {
    return nodeSpawn(executable, [...args], options) as unknown as RuntimeChildProcess;
  },
  killProcess(pid, signal) {
    process.kill(pid, signal);
  },
  platform: process.platform,
  environment: process.env,
  tempDirectory: tmpdir
};

export function createVscodeClientRuntimeAdapter(options: VscodeClientRuntimeAdapterOptions): ClientRuntimeAdapter {
  return new VscodeClientRuntimeAdapter(options);
}

class VscodeClientRuntimeAdapter implements ClientRuntimeAdapter {
  readonly metadata = {
    adapter: { id: VSCODE_CLIENT_RUNTIME_ADAPTER_ID, version: ADAPTER_VERSION },
    targetClient: { id: VSCODE_COPILOT_CLIENT_RUNTIME_TARGET_ID, name: "VS Code/GitHub Copilot" },
    synthetic: false,
    requiredCapabilities: VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES
  } as const;

  readonly #configuredExecutablePath: string;
  readonly #observationWindowMs: number;
  readonly #dependencies: VscodeClientRuntimeDependencies;
  #state?: AdapterState;
  #active?: LaunchedProcess;
  #stopPromise?: Promise<void>;
  #finalizePromise?: Promise<void>;

  constructor(options: VscodeClientRuntimeAdapterOptions) {
    this.#configuredExecutablePath = options.executablePath;
    const observationWindowMs = options.observationWindowMs ?? DEFAULT_OBSERVATION_MS;
    if (!Number.isInteger(observationWindowMs)
      || observationWindowMs < MIN_OBSERVATION_MS || observationWindowMs > MAX_OBSERVATION_MS) {
      throw new Error(`VS Code observation window must be an integer from ${MIN_OBSERVATION_MS} to ${MAX_OBSERVATION_MS} milliseconds`);
    }
    this.#observationWindowMs = observationWindowMs;
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  }

  async initialize(context: ClientRuntimeAdapterContext): Promise<void> {
    if (this.#state) throw new Error("VS Code client adapter cannot be initialized more than once");
    if (!context.packageRoot) throw new Error("VS Code client adapter requires the package-read capability");

    const executablePath = await validateExecutablePath(
      this.#configuredExecutablePath,
      this.#dependencies.platform
    );
    const packageRoot = await validatePackageRoot(context.packageRoot);
    const tempBase = resolve(this.#dependencies.tempDirectory());
    const tempRoot = await mkdtemp(join(tempBase, TEMP_PREFIX));
    const userDataDir = join(tempRoot, "user-data");
    const extensionsDir = join(tempRoot, "extensions");
    const homeDir = join(tempRoot, "home");
    const observationFile = join(tempRoot, "observation.txt");
    const directories = [
      join(userDataDir, "User"), extensionsDir, homeDir,
      join(tempRoot, "config"), join(tempRoot, "cache"), join(tempRoot, "data"), join(tempRoot, "tmp"),
      join(tempRoot, "appdata"), join(tempRoot, "localappdata")
    ];
    this.#state = {
      executablePath,
      packageRoot,
      tempBase,
      tempRoot,
      userDataDir,
      extensionsDir,
      homeDir,
      observationFile,
      environment: isolatedEnvironment(this.#dependencies.environment, tempRoot, homeDir)
    };
    for (const directory of directories) await mkdir(directory, { recursive: true });

    const settings = {
      "chat.plugins.enabled": true,
      "chat.pluginLocations": { [packageRoot]: true },
      "chat.mcp.access": "none",
      "chat.plugins.marketplaces": [],
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "workbench.enableExperiments": false
    };
    await writeFile(join(userDataDir, "User", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    await writeFile(observationFile, "Agent Plugin CI isolated VS Code observation session.\n", { encoding: "utf8", flag: "wx" });

  }

  async execute(context: ClientRuntimeAdapterContext): Promise<ClientRuntimeAdapterOutput> {
    const state = this.#state;
    if (!state) throw new Error("VS Code client adapter was not initialized");
    try {
      const versionObservation = await this.#readVersion(state, context.signal);
      if (!versionObservation) {
        return loadOnlyOutput("unknown", "unknown", undefined, [
          evidence(
            "APCI-CLIENT-VSCODE-REGISTER-001",
            "vscode/local-registration",
            "The package was registered through isolated chat.pluginLocations; local registration is not package installation."
          ),
          evidence(
            "APCI-CLIENT-VSCODE-VERSION-002",
            "vscode/version",
            "No bounded recognizable VS Code version was available from a trusted version source, so client loading was not attempted."
          )
        ]);
      }

      const args = [
        "--user-data-dir", state.userDataDir,
        "--extensions-dir", state.extensionsDir,
        "--disable-telemetry",
        "--disable-updates",
        "--password-store=basic",
        "--skip-welcome",
        "--skip-release-notes",
        "--new-window",
        "--verbose",
        "--wait",
        state.observationFile
      ];
      const launched = launchProcess(this.#dependencies, state.executablePath, args, state.environment, state.tempRoot, true);
      this.#active = launched;
      await waitForObservation(launched.exit, this.#observationWindowMs, context.signal);
      await this.#stopActive();

      const clientEvidence = `${launched.output()}\n${await collectVscodeLogs(state.userDataDir)}`;
      const matches = qualifyingLoadRecords(clientEvidence, state.packageRoot);
      const observed = matches > 0;
      return loadOnlyOutput(observed ? "pass" : "unknown", observed ? "observed" : "not-observed", versionObservation.version, [
        evidence(
          "APCI-CLIENT-VSCODE-REGISTER-001",
          "vscode/local-registration",
          "The package was registered through isolated chat.pluginLocations; local registration is not package installation."
        ),
        evidence(
          "APCI-CLIENT-VSCODE-MCP-DISABLED-001",
          "vscode/settings",
          "The isolated observation session set chat.mcp.access to none; MCP startup, handshake, and tool exposure were not assessed."
        ),
        evidence(
          "APCI-CLIENT-VSCODE-VERSION-001",
          "vscode/version",
          versionObservation.source === "bundled-cli"
            ? "The target client version was obtained through VS Code's validated bundled CLI entrypoint using a bounded direct process invocation."
            : "The target client version was obtained through a bounded direct executable invocation."
        ),
        observed
          ? evidence(
            "APCI-CLIENT-VSCODE-LOAD-001",
            "vscode/client-evidence",
            `VS Code emitted ${matches} bounded discovery/read/watch record(s) referencing the registered package root or its manifest/skills.`
          )
          : evidence(
            "APCI-CLIENT-VSCODE-LOAD-002",
            "vscode/client-evidence",
            "No qualifying bounded VS Code discovery/read/watch record referenced the registered package root or its manifest/skills; client loading was not observed."
          )
      ]);
    } catch (error) {
      await this.#stopActive();
      throw error;
    }
  }

  finalize(_context: ClientRuntimeAdapterContext, _status: ClientRuntimeExecutionStatus): Promise<void> {
    this.#finalizePromise ??= this.#finalize();
    return this.#finalizePromise;
  }

  async #readVersion(state: AdapterState, signal: AbortSignal): Promise<VersionObservation | undefined> {
    if (this.#dependencies.platform === "win32") {
      const bundledCliPath = await resolveWindowsBundledCli(state.executablePath);
      if (bundledCliPath) {
        const bundledVersion = await this.#probeVersion(
          state,
          [bundledCliPath, "--user-data-dir", state.userDataDir, "--extensions-dir", state.extensionsDir, "--version"],
          { ...state.environment, ELECTRON_RUN_AS_NODE: "1" },
          signal,
          true
        );
        if (bundledVersion) return { version: bundledVersion, source: "bundled-cli" };
      }
    }
    const directVersion = await this.#probeVersion(
      state,
      ["--user-data-dir", state.userDataDir, "--extensions-dir", state.extensionsDir, "--version"],
      state.environment,
      signal,
      false
    );
    return directVersion ? { version: directVersion, source: "direct-executable" } : undefined;
  }

  async #probeVersion(
    state: AdapterState,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    allowFallback: boolean
  ): Promise<string | undefined> {
    let launched: LaunchedProcess | undefined;
    try {
      launched = launchProcess(
        this.#dependencies,
        state.executablePath,
        args,
        environment,
        state.tempRoot,
        false
      );
      this.#active = launched;
      await waitForExit(launched.exit, VERSION_TIMEOUT_MS, signal);
      await this.#stopActive();
      return parseVscodeVersion(launched.output());
    } catch (error) {
      if (launched && this.#active === launched) await this.#stopActive();
      if (!allowFallback || signal.aborted) throw error;
      return undefined;
    }
  }

  async #stopActive(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#stopPromise ??= terminateProcess(this.#dependencies, active);
    await this.#stopPromise;
    if (this.#active === active) {
      this.#active = undefined;
      this.#stopPromise = undefined;
    }
  }

  async #finalize(): Promise<void> {
    await this.#stopActive();
    const state = this.#state;
    if (!state) return;
    this.#state = undefined;
    if (!safeTemporaryRoot(state.tempBase, state.tempRoot)) {
      throw new Error("VS Code adapter refused unsafe temporary cleanup target");
    }
    const rootInfo = await lstat(state.tempRoot).catch(() => undefined);
    if (!rootInfo) return;
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("VS Code adapter refused altered temporary cleanup target");
    }
    const canonicalRoot = await realpath(state.tempRoot);
    if (!safeTemporaryRoot(state.tempBase, canonicalRoot)) {
      throw new Error("VS Code adapter refused escaped temporary cleanup target");
    }
    await rm(state.tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  }
}

async function validateExecutablePath(raw: string, platform: NodeJS.Platform): Promise<string> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/.test(raw) || !isAbsolute(raw)) {
    throw new Error("VS Code executable path must be an explicit bounded absolute path");
  }
  const info = await lstat(raw).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error("VS Code executable path must name an existing regular file");
  if (platform === "win32") {
    if (![".exe", ".com"].includes(extname(raw).toLowerCase())) {
      throw new Error("VS Code executable path must name a directly executable Windows .exe or .com file");
    }
  } else if ((info.mode & 0o111) === 0) {
    throw new Error("VS Code executable path is not executable");
  }
  return await realpath(raw);
}

async function resolveWindowsBundledCli(executablePath: string): Promise<string | undefined> {
  try {
    if (basename(executablePath).toLowerCase() !== "code.exe") return undefined;
    const installationRoot = dirname(executablePath);
    const rootInfo = await lstat(installationRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined;
    const canonicalRoot = await realpath(installationRoot);
    if (resolve(canonicalRoot) !== resolve(installationRoot)) return undefined;

    const launcherPath = await validateContainedRegularFile(canonicalRoot, ["bin", "code.cmd"]);
    const launcher = await readBoundedTrustedFile(launcherPath, canonicalRoot, MAX_WINDOWS_LAUNCHER_BYTES);
    const relativeCliPath = parseWindowsBundledCliLauncher(launcher);
    if (!relativeCliPath) return undefined;
    return await validateContainedRegularFile(
      canonicalRoot,
      relativeCliPath.split("\\"),
      MAX_WINDOWS_BUNDLED_CLI_BYTES
    );
  } catch {
    return undefined;
  }
}

function parseWindowsBundledCliLauncher(raw: string): string | undefined {
  if (raw.includes("\u0000") || raw.includes("\r") && !raw.includes("\r\n")) return undefined;
  const normalized = raw.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) return undefined;
  const match = /^@echo off\nsetlocal\nset VSCODE_DEV=\nset ELECTRON_RUN_AS_NODE=1\n"%~dp0\.\.\\Code\.exe" "%~dp0\.\.\\(?:(?<version>[0-9a-f]{10})\\)?resources\\app\\out\\cli\.js" %\*\nIF %ERRORLEVEL% NEQ 0 EXIT \/b %ERRORLEVEL%\nendlocal\n?$/.exec(normalized);
  if (!match) return undefined;
  const versionDirectory = match.groups?.version;
  return versionDirectory
    ? `${versionDirectory}\\resources\\app\\out\\cli.js`
    : "resources\\app\\out\\cli.js";
}

async function validateContainedRegularFile(
  root: string,
  segments: readonly string[],
  maximumFileBytes?: number
): Promise<string> {
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === ".."
    || segment.includes("/") || segment.includes("\\") || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new Error("VS Code bundled CLI path was not trusted");
  }
  let candidate = root;
  for (let index = 0; index < segments.length; index += 1) {
    candidate = join(candidate, segments[index]!);
    if (!isWithin(root, candidate)) throw new Error("VS Code bundled CLI path escaped its installation root");
    const info = await lstat(candidate);
    const isLast = index === segments.length - 1;
    if (info.isSymbolicLink() || (isLast ? !info.isFile() : !info.isDirectory())
      || (isLast && maximumFileBytes !== undefined && info.size > maximumFileBytes)) {
      throw new Error("VS Code bundled CLI path contained an unsafe filesystem entry");
    }
    const canonicalCandidate = await realpath(candidate);
    if (!isWithin(root, canonicalCandidate)) {
      throw new Error("VS Code bundled CLI path escaped its installation root");
    }
    candidate = canonicalCandidate;
  }
  return candidate;
}

async function readBoundedTrustedFile(path: string, root: string, maximumBytes: number): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new Error("VS Code bundled CLI launcher was not a bounded regular file");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const canonicalPath = await realpath(path);
    if (!opened.isFile() || opened.size > maximumBytes || !sameFileIdentity(before, opened)
      || !isWithin(root, canonicalPath)) {
      throw new Error("VS Code bundled CLI launcher changed during validation");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let retained = 0;
    while (retained < buffer.length) {
      const { bytesRead } = await handle.read(buffer, retained, buffer.length - retained, retained);
      if (bytesRead === 0) break;
      retained += bytesRead;
    }
    const after = await lstat(path);
    const afterCanonical = await realpath(path);
    if (retained > maximumBytes || retained !== opened.size || after.size !== opened.size
      || !after.isFile() || after.isSymbolicLink() || !sameFileIdentity(opened, after)
      || !isWithin(root, afterCanonical)) {
      throw new Error("VS Code bundled CLI launcher changed during validation");
    }
    return buffer.subarray(0, retained).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function validatePackageRoot(raw: string): Promise<string> {
  if (!isAbsolute(raw) || raw.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("VS Code package root must be a bounded absolute path");
  }
  const rootInfo = await lstat(raw).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("VS Code package root must be a regular directory");
  const canonicalRoot = await realpath(raw);
  const manifest = join(canonicalRoot, "plugin.json");
  const manifestInfo = await lstat(manifest).catch(() => undefined);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error("VS Code package root must contain a regular non-symlink plugin.json");
  }
  await preflightPackageTree(canonicalRoot);
  return canonicalRoot;
}

class PackagePreflightError extends Error {}

async function preflightPackageTree(canonicalRoot: string): Promise<void> {
  let visitedEntries = 0;

  const reject = (message: string): never => {
    throw new PackagePreflightError(message);
  };
  const metadata = async (candidate: string) => {
    try {
      return await lstat(candidate);
    } catch {
      return reject("VS Code package metadata preflight could not be completed");
    }
  };
  const canonicalize = async (candidate: string) => {
    try {
      return await realpath(candidate);
    } catch {
      return reject("VS Code package metadata preflight could not be completed");
    }
  };

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_PACKAGE_DEPTH) {
      reject("VS Code package metadata preflight exceeded its depth bound");
    }
    const directoryInfo = await metadata(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      reject("VS Code package metadata preflight rejected a symlink or altered directory");
    }
    const canonicalDirectory = await canonicalize(directory);
    if (!isWithin(canonicalRoot, canonicalDirectory)) {
      reject("VS Code package metadata preflight rejected an escaped directory");
    }

    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      return reject("VS Code package metadata preflight could not enumerate the package");
    }
    try {
      for await (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries > MAX_PACKAGE_ENTRIES) {
          reject("VS Code package metadata preflight exceeded its entry bound");
        }
        const candidate = resolve(directory, entry.name);
        if (!isWithin(canonicalRoot, candidate)) {
          reject("VS Code package metadata preflight rejected an escaped entry");
        }
        const info = await metadata(candidate);
        if (info.isSymbolicLink()) {
          reject("VS Code package metadata preflight rejected a symlink entry");
        }
        const canonicalCandidate = await canonicalize(candidate);
        if (!isWithin(canonicalRoot, canonicalCandidate)) {
          reject("VS Code package metadata preflight rejected an escaped entry");
        }
        if (info.isDirectory()) {
          if (depth >= MAX_PACKAGE_DEPTH) {
            reject("VS Code package metadata preflight exceeded its depth bound");
          }
          await visit(candidate, depth + 1);
        }
      }
    } catch (error) {
      if (error instanceof PackagePreflightError) throw error;
      reject("VS Code package metadata preflight could not enumerate the package");
    }
  };

  await visit(canonicalRoot, 0);
}

function isolatedEnvironment(source: NodeJS.ProcessEnv, tempRoot: string, homeDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot", "SYSTEMROOT", "WINDIR", "windir", "PATH", "Path",
    "DISPLAY", "WAYLAND_DISPLAY", "LANG", "LC_ALL"
  ]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  environment.HOME = homeDir;
  environment.USERPROFILE = homeDir;
  environment.APPDATA = join(tempRoot, "appdata");
  environment.LOCALAPPDATA = join(tempRoot, "localappdata");
  environment.XDG_CONFIG_HOME = join(tempRoot, "config");
  environment.XDG_CACHE_HOME = join(tempRoot, "cache");
  environment.XDG_DATA_HOME = join(tempRoot, "data");
  environment.TEMP = join(tempRoot, "tmp");
  environment.TMP = join(tempRoot, "tmp");
  environment.TMPDIR = join(tempRoot, "tmp");
  environment.VSCODE_DISABLE_UPDATE = "1";
  return environment;
}

function launchProcess(
  dependencies: VscodeClientRuntimeDependencies,
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  groupSafe: boolean
): LaunchedProcess {
  const child = dependencies.spawn(executable, args, {
    cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    detached: groupSafe && dependencies.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = boundedOutput(child.stdout, child.stderr);
  const launched: LaunchedProcess = {
    child,
    exit: Promise.resolve({ kind: "error" }),
    output,
    groupSafe,
    exited: false,
    cwd,
    environment
  };
  launched.exit = new Promise<ExitResult>((resolveExit) => {
    let settled = false;
    const settle = (result: ExitResult) => {
      if (settled) return;
      settled = true;
      launched.exited = true;
      resolveExit(result);
    };
    child.once("error", () => settle({ kind: "error" }));
    child.once("exit", (code, signal) => settle({ kind: "exit", code, signal }));
  });
  return launched;
}

function boundedOutput(stdout: Readable | null, stderr: Readable | null): () => string {
  const chunks: Buffer[] = [];
  let retained = 0;
  const collect = (chunk: unknown) => {
    if (retained >= MAX_PROCESS_OUTPUT_BYTES) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const bounded = buffer.subarray(0, MAX_PROCESS_OUTPUT_BYTES - retained);
    chunks.push(bounded);
    retained += bounded.length;
  };
  stdout?.on("data", collect);
  stderr?.on("data", collect);
  return () => Buffer.concat(chunks, retained).toString("utf8");
}

async function waitForExit(exit: Promise<ExitResult>, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const result = await raceWithAbortAndTimer(exit, timeoutMs, signal);
  if (result === "timer") throw new Error("VS Code version invocation exceeded its bounded timeout");
  if (result.kind === "error" || result.code !== 0) throw new Error("VS Code version invocation failed");
}

async function waitForObservation(exit: Promise<ExitResult>, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const result = await raceWithAbortAndTimer(exit, timeoutMs, signal);
  if (result !== "timer" && result.kind === "error") throw new Error("VS Code client process failed to launch");
}

async function raceWithAbortAndTimer(
  exit: Promise<ExitResult>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<ExitResult | "timer"> {
  if (signal.aborted) throw new Error("VS Code client observation aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const timeout = new Promise<"timer">((resolveTimer) => {
    timer = setTimeout(() => resolveTimer("timer"), timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error("VS Code client observation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([exit, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}

async function terminateProcess(dependencies: VscodeClientRuntimeDependencies, launched: LaunchedProcess): Promise<void> {
  if (launched.exited) return;
  const pid = launched.child.pid;
  if (dependencies.platform === "win32" && pid !== undefined) {
    let trustedCleanupFailed = false;
    try {
      const cleanup = launchProcess(
        dependencies,
        windowsTaskkillExecutable(),
        ["/pid", String(pid), "/t", "/f"],
        launched.environment,
        launched.cwd,
        false
      );
      const cleanupResult = await Promise.race([cleanup.exit, delay(TERMINATION_TIMEOUT_MS).then(() => undefined)]);
      if (!cleanupResult || cleanupResult.kind === "error" || cleanupResult.code !== 0) {
        trustedCleanupFailed = true;
        if (!cleanup.exited) cleanup.child.kill("SIGKILL");
        if (!launched.exited) launched.child.kill("SIGKILL");
      }
    } catch {
      trustedCleanupFailed = true;
      try {
        launched.child.kill("SIGKILL");
      } catch {
        // A concurrently exited process is already clean.
      }
    }
    await Promise.race([launched.exit, delay(250)]);
    if (!launched.exited) throw new Error("VS Code process-tree cleanup did not complete within bounds");
    if (trustedCleanupFailed) throw new Error("VS Code trusted process-tree cleanup failed");
    return;
  }
  if (pid !== undefined && launched.groupSafe) {
    try {
      dependencies.killProcess(-pid, "SIGTERM");
      await Promise.race([launched.exit, delay(250)]);
      if (!launched.exited) {
        dependencies.killProcess(-pid, "SIGKILL");
        await Promise.race([launched.exit, delay(250)]);
      }
      if (!launched.exited) throw new Error("VS Code process-group cleanup did not complete within bounds");
      return;
    } catch {
      // Fall through to the direct child handle when no process group exists.
    }
  }
  try {
    launched.child.kill("SIGKILL");
  } catch {
    // A concurrently exited process is already clean.
  }
  await Promise.race([launched.exit, delay(250)]);
  if (!launched.exited) throw new Error("VS Code child cleanup did not complete within bounds");
}

function windowsTaskkillExecutable(): string {
  return "C:\\Windows\\System32\\taskkill.exe";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function parseVscodeVersion(output: string): string | undefined {
  for (const line of output.split(/\r?\n/).slice(0, 16)) {
    const candidate = line.trim();
    if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z._-]+)?$/.test(candidate) && candidate.length <= 128) return candidate;
  }
  return undefined;
}

function qualifyingLoadRecords(raw: string, packageRoot: string): number {
  const normalizedRoot = packageRoot.toLowerCase().replaceAll("\\", "/");
  const rootForms = [
    normalizedRoot,
    encodeURI(normalizedRoot).toLowerCase(),
    pathToFileURL(packageRoot).href.toLowerCase()
  ];
  let matches = 0;
  for (const rawLine of raw.split(/\r?\n/).slice(0, 4_096)) {
    const line = rawLine.slice(0, 8_192).toLowerCase().replaceAll("\\", "/");
    if (!rootForms.some((root) => line.includes(root))) continue;
    if (!/\b(?:discover(?:ed|ing|s|y)?|load(?:ed|ing|s)?|read(?:ing|s)?|watch(?:ed|er|ers|es|ing)?)\b/i.test(line)) continue;
    if (!/(agent\s*plugin|chat\s*plugin|plugin\.json|skill\.md)/i.test(line)) continue;
    matches += 1;
    if (matches === 64) break;
  }
  return matches;
}

async function collectVscodeLogs(userDataDir: string): Promise<string> {
  const userDataInfo = await lstat(userDataDir).catch(() => undefined);
  if (!userDataInfo?.isDirectory() || userDataInfo.isSymbolicLink()) return "";
  const canonicalUserDataRoot = await realpath(userDataDir).catch(() => undefined);
  if (!canonicalUserDataRoot) return "";
  const requestedLogsRoot = join(canonicalUserDataRoot, "logs");
  const rootInfo = await lstat(requestedLogsRoot).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return "";
  const canonicalLogsRoot = await realpath(requestedLogsRoot).catch(() => undefined);
  if (!canonicalLogsRoot || canonicalLogsRoot === canonicalUserDataRoot
    || !isWithin(canonicalUserDataRoot, canonicalLogsRoot)) return "";
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let visitedEntries = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_LOG_DEPTH || retainedBytes >= MAX_LOG_BYTES || visitedEntries >= MAX_LOG_ENTRIES) return;
    const directoryInfo = await lstat(directory).catch(() => undefined);
    if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) return;
    const canonicalDirectory = await realpath(directory).catch(() => undefined);
    if (!canonicalDirectory || !isWithin(canonicalLogsRoot, canonicalDirectory)) return;
    const names: string[] = [];
    const entries = await opendir(directory).catch(() => undefined);
    if (!entries) return;
    try {
      for await (const entry of entries) {
        if (names.length >= MAX_LOG_ENTRIES - visitedEntries) break;
        names.push(entry.name);
      }
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      if (retainedBytes >= MAX_LOG_BYTES || visitedEntries >= MAX_LOG_ENTRIES) break;
      visitedEntries += 1;
      const candidate = resolve(directory, name);
      if (!isWithin(canonicalLogsRoot, candidate)) continue;
      const info = await lstat(candidate).catch(() => undefined);
      if (!info || info.isSymbolicLink()) continue;
      const canonicalCandidate = await realpath(candidate).catch(() => undefined);
      if (!canonicalCandidate || !isWithin(canonicalLogsRoot, canonicalCandidate)) continue;
      if (info.isDirectory()) {
        await visit(candidate, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      const handle = await open(candidate, constants.O_RDONLY | noFollow).catch(() => undefined);
      if (!handle) continue;
      try {
        const openedInfo = await handle.stat();
        const postOpenInfo = await lstat(candidate).catch(() => undefined);
        const postOpenCanonical = await realpath(candidate).catch(() => undefined);
        if (!openedInfo.isFile() || !postOpenInfo?.isFile() || postOpenInfo.isSymbolicLink()
          || !postOpenCanonical || !isWithin(canonicalLogsRoot, postOpenCanonical)
          || !sameFileIdentity(info, openedInfo) || !sameFileIdentity(postOpenInfo, openedInfo)) continue;
        const maximum = Math.min(MAX_LOG_FILE_BYTES, MAX_LOG_BYTES - retainedBytes, openedInfo.size);
        if (maximum <= 0) continue;
        const buffer = Buffer.alloc(maximum);
        const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
        chunks.push(buffer.subarray(0, bytesRead));
        retainedBytes += bytesRead;
      } finally {
        await handle.close();
      }
    }
  };

  await visit(canonicalLogsRoot, 0);
  return Buffer.concat(chunks, retainedBytes).toString("utf8");
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function loadOnlyOutput(
  status: ClientRuntimeAdapterOutput["status"],
  clientLoad: ClientRuntimeAdapterOutput["clientLoad"],
  targetClientVersion: string | undefined,
  evidenceItems: ClientRuntimeAdapterOutput["evidence"]
): ClientRuntimeAdapterOutput {
  return {
    status,
    complete: true,
    packageInstall: "not-observed",
    clientLoad,
    mcpStartup: "not-assessed",
    mcpHandshake: "not-assessed",
    toolExposure: "not-assessed",
    interoperability: "not-established",
    ...(targetClientVersion ? { targetClientVersion } : {}),
    evidence: evidenceItems
  };
}

function evidence(code: string, location: string, summary: string) {
  return { code, location, summary };
}

function safeTemporaryRoot(tempBase: string, candidate: string): boolean {
  return isAbsolute(candidate)
    && basename(candidate).startsWith(TEMP_PREFIX)
    && isWithin(tempBase, candidate)
    && candidate !== tempBase;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
