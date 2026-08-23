import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import {
  constants,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
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

const ADAPTER_VERSION = "1.2.0";
const MIN_OBSERVATION_MS = 100;
const MAX_OBSERVATION_MS = 20_000;
const DEFAULT_OBSERVATION_MS = 7_500;
const VERSION_TIMEOUT_MS = 2_000;
const TERMINATION_TIMEOUT_MS = 750;
const TERMINATION_SETTLE_MS = 500;
const TEMP_CLEANUP_ATTEMPTS = 4;
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
const SHADOW_DIRECTORY = "client-shadow";
const SHADOW_EXECUTABLE = "Code.exe";
const OBSERVER_DIRECTORY = "agent-plugin-ci.agent-plugin-ci-runtime-observer-1.0.0";
const OBSERVER_EXTENSION_ID = "agent-plugin-ci.agent-plugin-ci-runtime-observer";
const OBSERVER_MARKER_FILENAME = "consumer-surface-exercised.marker";
const OBSERVER_MARKER_CONTENT = "agent-plugin-ci:consumer-surface-exercised:v1\n";
const OBSERVER_MANIFEST = `${JSON.stringify({
  name: "agent-plugin-ci-runtime-observer",
  displayName: "Agent Plugin CI Runtime Observer",
  description: "Activates a trusted built-in VS Code Agent Plugin consumer surface in an isolated runtime evidence session.",
  version: "1.0.0",
  publisher: "agent-plugin-ci",
  engines: { vscode: "^1.100.0" },
  main: "./extension.js",
  activationEvents: ["*"]
}, null, 2)}\n`;
const OBSERVER_SOURCE = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const MARKER_FILENAME = ${JSON.stringify(OBSERVER_MARKER_FILENAME)};
const MARKER_CONTENT = ${JSON.stringify(OBSERVER_MARKER_CONTENT)};

async function activate(context) {
  const consumerInvocation = vscode.commands.executeCommand("aiCustomization.openManagementEditor");
  fs.writeFileSync(path.join(context.extensionPath, MARKER_FILENAME), MARKER_CONTENT, {
    encoding: "utf8",
    flag: "wx"
  });
  await consumerInvocation;
}

exports.activate = activate;
`;

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
  linkFile(existingPath: string, newPath: string): Promise<void>;
  createJunction(target: string, path: string): Promise<void>;
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
  observerRoot: string;
  observerMarker: string;
  homeDir: string;
  observationFile: string;
  environment: NodeJS.ProcessEnv;
}

interface VersionObservation {
  version: string;
  source: "bundled-cli" | "direct-executable";
  windowsBundledLayout?: WindowsBundledLayout;
}

interface WindowsBundledCliResolution {
  cliPath: string;
  shadowLayout?: WindowsBundledLayout;
}

interface WindowsBundledLayout {
  installationRoot: string;
  installationRootIdentity: FileIdentity;
  executablePath: string;
  executableIdentity: FileIdentity & { size: number };
  launcherPath: string;
  launcherIdentity: FileIdentity & { size: number };
  cliPath: string;
  cliIdentity: FileIdentity & { size: number };
  versionDirectoryName: string;
  versionDirectory: string;
  versionDirectoryIdentity: FileIdentity;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface ParsedWindowsBundledCliLauncher {
  relativeCliPath: string;
  versionDirectoryName?: string;
}

interface PreparedGuiLauncher {
  executablePath: string;
  argsPrefix: readonly string[];
  environment: NodeJS.ProcessEnv;
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
  tempDirectory: tmpdir,
  linkFile(existingPath, newPath) {
    return link(existingPath, newPath);
  },
  createJunction(target, path) {
    return symlink(target, path, "junction");
  }
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
    const observerRoot = join(extensionsDir, OBSERVER_DIRECTORY);
    const observerMarker = join(observerRoot, OBSERVER_MARKER_FILENAME);
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
      observerRoot,
      observerMarker,
      homeDir,
      observationFile,
      environment: isolatedEnvironment(this.#dependencies.environment, tempRoot, homeDir)
    };
    for (const directory of directories) await mkdir(directory, { recursive: true });
    await materializeObserver(tempRoot, extensionsDir, observerRoot);

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
        "--extensionDevelopmentPath", state.observerRoot,
        "--disable-telemetry",
        "--disable-updates",
        "--password-store=basic",
        "--skip-welcome",
        "--skip-release-notes",
        "--new-window",
        "--log", "trace",
        "--verbose",
        "--wait",
        state.observationFile
      ];
      await validateObserverMaterialization(state.tempRoot, state.extensionsDir, state.observerRoot, true);
      const guiLauncher = await prepareWindowsShadowLauncher(
        this.#dependencies,
        state,
        versionObservation.windowsBundledLayout
      ).catch(() => directGuiLauncher(state));
      const launched = launchProcess(
        this.#dependencies,
        guiLauncher.executablePath,
        [...guiLauncher.argsPrefix, ...args],
        guiLauncher.environment,
        state.tempRoot,
        true
      );
      this.#active = launched;
      await waitForObservation(launched.exit, this.#observationWindowMs, context.signal);
      await this.#stopActive();

      // Drain bounded process output, but never use arbitrary process text as package-load evidence.
      launched.output();
      const observerActivated = await validateObserverMarker(state.tempRoot, state.observerRoot, state.observerMarker);
      const trustedClientLogs = await collectVscodeLogs(state.userDataDir);
      const matches = observerActivated ? qualifyingLoadRecords(trustedClientLogs, state.packageRoot) : 0;
      const observed = observerActivated && matches > 0;
      const clientLoad = !observerActivated ? "unknown" : observed ? "observed" : "not-observed";
      return loadOnlyOutput(
        observed ? "pass" : "unknown",
        clientLoad,
        versionObservation.version,
        [
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
          observerActivated
            ? evidence(
              "APCI-CLIENT-VSCODE-OBSERVER-001",
              "vscode/observer",
              "The isolated Agent Plugin CI observer activated and dispatched the trusted built-in AI customization management command."
            )
            : evidence(
              "APCI-CLIENT-VSCODE-OBSERVER-002",
              "vscode/observer",
              "The isolated observer did not prove activation and dispatch of the trusted built-in AI customization management command; client loading was not assessed."
            ),
          observed
            ? evidence(
              "APCI-CLIENT-VSCODE-LOAD-001",
              "vscode/client-logs",
              `VS Code emitted ${matches} bounded client-owned file-watcher start record(s) referencing the exact registered package root or a contained portable component.`
            )
            : observerActivated ? evidence(
              "APCI-CLIENT-VSCODE-LOAD-002",
              "vscode/client-logs",
              "No qualifying bounded VS Code-owned file-watcher start record referenced the exact registered package root or a contained portable component; client loading was not observed."
            ) : evidence(
              "APCI-CLIENT-VSCODE-LOAD-003",
              "vscode/client-logs",
              "No package-loading claim was made because observer activation was not proven."
            )
        ],
        observerActivated
      );
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
      const bundledCli = await resolveWindowsBundledCli(state.executablePath);
      if (bundledCli) {
        const bundledVersion = await this.#probeVersion(
          state,
          [bundledCli.cliPath, "--user-data-dir", state.userDataDir, "--extensions-dir", state.extensionsDir, "--version"],
          { ...state.environment, ELECTRON_RUN_AS_NODE: "1" },
          signal,
          true
        );
        if (bundledVersion) {
          return {
            version: bundledVersion,
            source: "bundled-cli",
            ...(bundledCli.shadowLayout ? { windowsBundledLayout: bundledCli.shadowLayout } : {})
          };
        }
        const directVersion = await this.#probeVersion(
          state,
          ["--user-data-dir", state.userDataDir, "--extensions-dir", state.extensionsDir, "--version"],
          state.environment,
          signal,
          false
        );
        return directVersion ? {
          version: directVersion,
          source: "direct-executable",
          ...(bundledCli.shadowLayout ? { windowsBundledLayout: bundledCli.shadowLayout } : {})
        } : undefined;
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
    for (let attempt = 0; attempt < TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
      if (!safeTemporaryRoot(state.tempBase, state.tempRoot)) {
        throw new Error("VS Code adapter refused unsafe temporary cleanup target");
      }
      const rootInfo = await lstatIfPresent(state.tempRoot);
      if (!rootInfo) return;
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error("VS Code adapter refused altered temporary cleanup target");
      }
      const canonicalRoot = await realpath(state.tempRoot);
      if (!safeTemporaryRoot(state.tempBase, canonicalRoot)) {
        throw new Error("VS Code adapter refused escaped temporary cleanup target");
      }
      await rm(state.tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      if (!await lstatIfPresent(state.tempRoot)) return;
      await delay(50 * (attempt + 1));
    }
    throw new Error("VS Code adapter could not remove isolated temporary state within bounds");
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

async function resolveWindowsBundledCli(executablePath: string): Promise<WindowsBundledCliResolution | undefined> {
  try {
    if (basename(executablePath).toLowerCase() !== "code.exe") return undefined;
    const installationRoot = dirname(executablePath);
    const rootInfo = await lstat(installationRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined;
    const canonicalRoot = await realpath(installationRoot);
    if (resolve(canonicalRoot) !== resolve(installationRoot)) return undefined;

    const launcherPath = await validateContainedRegularFile(canonicalRoot, ["bin", "code.cmd"]);
    const launcher = await readBoundedTrustedFile(launcherPath, canonicalRoot, MAX_WINDOWS_LAUNCHER_BYTES);
    const parsedLauncher = parseWindowsBundledCliLauncher(launcher);
    if (!parsedLauncher) return undefined;
    const cliPath = await validateContainedRegularFile(
      canonicalRoot,
      parsedLauncher.relativeCliPath.split("\\"),
      MAX_WINDOWS_BUNDLED_CLI_BYTES
    );
    const canonicalExecutable = await validateContainedRegularFile(canonicalRoot, [SHADOW_EXECUTABLE]);
    if (!sameCanonicalPath(canonicalExecutable, executablePath, "win32")) return undefined;
    if (!parsedLauncher.versionDirectoryName) return { cliPath };
    const versionDirectory = await validateContainedDirectory(
      canonicalRoot,
      [parsedLauncher.versionDirectoryName]
    );
    return {
      cliPath,
      shadowLayout: {
        installationRoot: canonicalRoot,
        installationRootIdentity: fileIdentity(await lstat(canonicalRoot)),
        executablePath: canonicalExecutable,
        executableIdentity: fileIdentityWithSize(await lstat(canonicalExecutable)),
        launcherPath,
        launcherIdentity: fileIdentityWithSize(await lstat(launcherPath)),
        cliPath,
        cliIdentity: fileIdentityWithSize(await lstat(cliPath)),
        versionDirectoryName: parsedLauncher.versionDirectoryName,
        versionDirectory,
        versionDirectoryIdentity: fileIdentity(await lstat(versionDirectory))
      }
    };
  } catch {
    return undefined;
  }
}

function parseWindowsBundledCliLauncher(raw: string): ParsedWindowsBundledCliLauncher | undefined {
  if (raw.includes("\u0000") || raw.includes("\r") && !raw.includes("\r\n")) return undefined;
  const normalized = raw.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) return undefined;
  const match = /^@echo off\nsetlocal\nset VSCODE_DEV=\nset ELECTRON_RUN_AS_NODE=1\n"%~dp0\.\.\\Code\.exe" "%~dp0\.\.\\(?:(?<version>[0-9a-f]{10})\\)?resources\\app\\out\\cli\.js" %\*\nIF %ERRORLEVEL% NEQ 0 EXIT \/b %ERRORLEVEL%\nendlocal\n?$/.exec(normalized);
  if (!match) return undefined;
  const versionDirectoryName = match.groups?.version;
  return {
    relativeCliPath: versionDirectoryName
      ? `${versionDirectoryName}\\resources\\app\\out\\cli.js`
      : "resources\\app\\out\\cli.js",
    ...(versionDirectoryName ? { versionDirectoryName } : {})
  };
}

async function prepareWindowsShadowLauncher(
  dependencies: VscodeClientRuntimeDependencies,
  state: AdapterState,
  layout: WindowsBundledLayout | undefined
): Promise<PreparedGuiLauncher> {
  if (dependencies.platform !== "win32" || !layout) return directGuiLauncher(state);
  await validateWindowsBundledLayout(state.executablePath, layout);

  const shadowRoot = join(state.tempRoot, SHADOW_DIRECTORY);
  const shadowExecutable = join(shadowRoot, SHADOW_EXECUTABLE);
  const shadowVersionDirectory = join(shadowRoot, layout.versionDirectoryName);
  if (shadowRoot !== join(state.tempRoot, SHADOW_DIRECTORY)
    || shadowExecutable !== join(shadowRoot, SHADOW_EXECUTABLE)
    || shadowVersionDirectory !== join(shadowRoot, layout.versionDirectoryName)
    || !isWithin(state.tempRoot, shadowRoot)) {
    throw new Error("VS Code shadow launcher path escaped isolated client state");
  }

  const tempInfo = await lstat(state.tempRoot);
  const canonicalTempRoot = await realpath(state.tempRoot);
  if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink()
    || !safeTemporaryRoot(state.tempBase, canonicalTempRoot)
    || !sameCanonicalPath(state.tempRoot, canonicalTempRoot, dependencies.platform)) {
    throw new Error("VS Code shadow launcher temporary root was not trusted");
  }
  await mkdir(shadowRoot, { mode: 0o700 });
  const shadowRootInfo = await lstat(shadowRoot);
  const canonicalShadowRoot = await realpath(shadowRoot);
  if (!shadowRootInfo.isDirectory() || shadowRootInfo.isSymbolicLink()
    || !isWithin(canonicalTempRoot, canonicalShadowRoot)
    || canonicalShadowRoot === canonicalTempRoot) {
    throw new Error("VS Code shadow launcher root was not trusted");
  }

  await dependencies.linkFile(layout.executablePath, shadowExecutable);
  await validateShadowExecutable(dependencies.platform, layout, canonicalShadowRoot, shadowExecutable);
  await dependencies.createJunction(layout.versionDirectory, shadowVersionDirectory);
  await validateWindowsBundledLayout(state.executablePath, layout);
  await validateShadowExecutable(dependencies.platform, layout, canonicalShadowRoot, shadowExecutable);

  const junctionInfo = await lstat(shadowVersionDirectory);
  if (!junctionInfo.isSymbolicLink()) {
    throw new Error("VS Code shadow version entry was not a controlled junction");
  }
  const junctionTarget = await readlink(shadowVersionDirectory);
  const resolvedJunctionTarget = isAbsolute(junctionTarget)
    ? resolve(junctionTarget)
    : resolve(dirname(shadowVersionDirectory), junctionTarget);
  const canonicalJunctionTarget = await realpath(shadowVersionDirectory);
  if (!sameCanonicalPath(resolvedJunctionTarget, layout.versionDirectory, dependencies.platform)
    || !sameCanonicalPath(canonicalJunctionTarget, layout.versionDirectory, dependencies.platform)) {
    throw new Error("VS Code shadow version junction did not resolve to the validated active version");
  }
  const shadowCliPath = join(
    shadowVersionDirectory,
    "resources",
    "app",
    "out",
    "cli.js"
  );
  const shadowCliInfo = await lstat(shadowCliPath);
  const canonicalShadowCli = await realpath(shadowCliPath);
  if (!shadowCliInfo.isFile() || shadowCliInfo.isSymbolicLink()
    || shadowCliInfo.size !== layout.cliIdentity.size
    || !sameFileIdentity(shadowCliInfo, layout.cliIdentity)
    || !sameCanonicalPath(canonicalShadowCli, layout.cliPath, dependencies.platform)) {
    throw new Error("VS Code shadow bundled CLI did not resolve to the validated active version");
  }
  return {
    executablePath: shadowExecutable,
    argsPrefix: [shadowCliPath],
    environment: { ...state.environment, ELECTRON_RUN_AS_NODE: "1" }
  };
}

function directGuiLauncher(state: AdapterState): PreparedGuiLauncher {
  return {
    executablePath: state.executablePath,
    argsPrefix: [],
    environment: state.environment
  };
}

async function validateShadowExecutable(
  platform: NodeJS.Platform,
  layout: WindowsBundledLayout,
  shadowRoot: string,
  shadowExecutable: string
): Promise<void> {
  if (shadowExecutable !== join(shadowRoot, SHADOW_EXECUTABLE)) {
    throw new Error("VS Code shadow executable path was not fixed");
  }
  const sourceInfo = await lstat(layout.executablePath);
  const shadowExecutableInfo = await lstat(shadowExecutable);
  const canonicalSourceExecutable = await realpath(layout.executablePath);
  const canonicalShadowExecutable = await realpath(shadowExecutable);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()
    || !shadowExecutableInfo.isFile() || shadowExecutableInfo.isSymbolicLink()
    || sourceInfo.size !== layout.executableIdentity.size
    || sourceInfo.size !== shadowExecutableInfo.size
    || !sameFileIdentity(sourceInfo, layout.executableIdentity)
    || !sameFileIdentity(sourceInfo, shadowExecutableInfo)
    || !sameCanonicalPath(canonicalSourceExecutable, layout.executablePath, platform)
    || !sameCanonicalPath(canonicalShadowExecutable, shadowExecutable, platform)
    || !isWithin(shadowRoot, canonicalShadowExecutable)) {
    throw new Error("VS Code shadow executable did not preserve trusted file identity");
  }
}

async function validateWindowsBundledLayout(
  executablePath: string,
  layout: WindowsBundledLayout
): Promise<void> {
  if (!/^[0-9a-f]{10}$/.test(layout.versionDirectoryName)) {
    throw new Error("VS Code active version directory name was not trusted");
  }
  const installationRoot = dirname(executablePath);
  if (!sameCanonicalPath(layout.installationRoot, installationRoot, "win32")
    || !sameCanonicalPath(layout.executablePath, executablePath, "win32")
    || !sameCanonicalPath(
      layout.versionDirectory,
      join(layout.installationRoot, layout.versionDirectoryName),
      "win32"
    )) {
    throw new Error("VS Code bundled layout no longer matched the selected installation");
  }
  const rootInfo = await lstat(layout.installationRoot);
  const canonicalRoot = await realpath(layout.installationRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || !sameFileIdentity(rootInfo, layout.installationRootIdentity)
    || !sameCanonicalPath(canonicalRoot, layout.installationRoot, "win32")) {
    throw new Error("VS Code installation root was not canonical");
  }
  const canonicalExecutable = await validateContainedRegularFile(canonicalRoot, [SHADOW_EXECUTABLE]);
  const executableInfo = await lstat(canonicalExecutable);
  if (!sameFileIdentity(executableInfo, layout.executableIdentity)
    || executableInfo.size !== layout.executableIdentity.size) {
    throw new Error("VS Code executable changed after bundled layout validation");
  }
  const canonicalLauncher = await validateContainedRegularFile(canonicalRoot, ["bin", "code.cmd"]);
  const launcherInfo = await lstat(canonicalLauncher);
  if (!sameFileIdentity(launcherInfo, layout.launcherIdentity)
    || launcherInfo.size !== layout.launcherIdentity.size) {
    throw new Error("VS Code bundled CLI launcher changed after layout validation");
  }
  const launcher = await readBoundedTrustedFile(
    canonicalLauncher,
    canonicalRoot,
    MAX_WINDOWS_LAUNCHER_BYTES
  );
  const parsedLauncher = parseWindowsBundledCliLauncher(launcher);
  if (!parsedLauncher || parsedLauncher.versionDirectoryName !== layout.versionDirectoryName
    || parsedLauncher.relativeCliPath !== `${layout.versionDirectoryName}\\resources\\app\\out\\cli.js`) {
    throw new Error("VS Code bundled CLI launcher changed after layout validation");
  }
  const canonicalCli = await validateContainedRegularFile(
    canonicalRoot,
    parsedLauncher.relativeCliPath.split("\\"),
    MAX_WINDOWS_BUNDLED_CLI_BYTES
  );
  const cliInfo = await lstat(canonicalCli);
  const canonicalVersionDirectory = await validateContainedDirectory(
    canonicalRoot,
    [layout.versionDirectoryName]
  );
  const versionDirectoryInfo = await lstat(canonicalVersionDirectory);
  if (!sameCanonicalPath(canonicalExecutable, layout.executablePath, "win32")
    || !sameCanonicalPath(canonicalLauncher, layout.launcherPath, "win32")
    || !sameFileIdentity(cliInfo, layout.cliIdentity)
    || cliInfo.size !== layout.cliIdentity.size
    || !sameCanonicalPath(canonicalCli, layout.cliPath, "win32")
    || !sameFileIdentity(versionDirectoryInfo, layout.versionDirectoryIdentity)
    || !sameCanonicalPath(canonicalVersionDirectory, layout.versionDirectory, "win32")) {
    throw new Error("VS Code bundled layout changed after validation");
  }
}

async function validateContainedDirectory(root: string, segments: readonly string[]): Promise<string> {
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === ".."
    || segment.includes("/") || segment.includes("\\") || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new Error("VS Code bundled directory path was not trusted");
  }
  let candidate = root;
  for (const segment of segments) {
    candidate = join(candidate, segment);
    if (!isWithin(root, candidate)) throw new Error("VS Code bundled directory escaped its installation root");
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("VS Code bundled directory contained an unsafe filesystem entry");
    }
    const canonicalCandidate = await realpath(candidate);
    if (!isWithin(root, canonicalCandidate)) {
      throw new Error("VS Code bundled directory escaped its installation root");
    }
    candidate = canonicalCandidate;
  }
  return candidate;
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

async function materializeObserver(
  tempRoot: string,
  extensionsDir: string,
  observerRoot: string
): Promise<void> {
  if (observerRoot !== join(extensionsDir, OBSERVER_DIRECTORY) || !isWithin(tempRoot, observerRoot)) {
    throw new Error("VS Code observer materialization path escaped isolated client state");
  }
  const registry = observerRegistry(observerRoot);
  await mkdir(observerRoot);
  await writeFile(join(observerRoot, "package.json"), OBSERVER_MANIFEST, { encoding: "utf8", flag: "wx" });
  await writeFile(join(observerRoot, "extension.js"), OBSERVER_SOURCE, { encoding: "utf8", flag: "wx" });
  await writeFile(join(extensionsDir, "extensions.json"), registry, { encoding: "utf8", flag: "wx" });
  await validateObserverMaterialization(tempRoot, extensionsDir, observerRoot, true);
}

function observerRegistry(observerRoot: string): string {
  const location = pathToFileURL(observerRoot);
  return `${JSON.stringify([{
    identifier: { id: OBSERVER_EXTENSION_ID },
    version: "1.0.0",
    location: {
      $mid: 1,
      path: decodeURIComponent(location.pathname),
      scheme: "file"
    },
    relativeLocation: OBSERVER_DIRECTORY
  }], null, 2)}\n`;
}

async function validateObserverMaterialization(
  tempRoot: string,
  extensionsDir: string,
  observerRoot: string,
  requireMissingMarker: boolean
): Promise<void> {
  if (extensionsDir !== join(tempRoot, "extensions")
    || observerRoot !== join(extensionsDir, OBSERVER_DIRECTORY)) {
    throw new Error("VS Code observer path did not match its fixed isolated location");
  }
  const tempInfo = await lstat(tempRoot);
  const extensionsInfo = await lstat(extensionsDir);
  const observerInfo = await lstat(observerRoot);
  if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink()
    || !extensionsInfo.isDirectory() || extensionsInfo.isSymbolicLink()
    || !observerInfo.isDirectory() || observerInfo.isSymbolicLink()) {
    throw new Error("VS Code observer path contained an unsafe filesystem entry");
  }
  const canonicalTempRoot = await realpath(tempRoot);
  const canonicalExtensionsDir = await realpath(extensionsDir);
  const canonicalObserverRoot = await realpath(observerRoot);
  if (!isWithin(canonicalTempRoot, canonicalExtensionsDir)
    || !isWithin(canonicalExtensionsDir, canonicalObserverRoot)
    || canonicalExtensionsDir === canonicalTempRoot
    || canonicalObserverRoot === canonicalExtensionsDir) {
    throw new Error("VS Code observer path escaped isolated client state");
  }
  const manifestPath = await validateContainedRegularFile(
    canonicalObserverRoot,
    ["package.json"],
    Buffer.byteLength(OBSERVER_MANIFEST)
  );
  const sourcePath = await validateContainedRegularFile(
    canonicalObserverRoot,
    ["extension.js"],
    Buffer.byteLength(OBSERVER_SOURCE)
  );
  const manifest = await readBoundedTrustedFile(
    manifestPath,
    canonicalObserverRoot,
    Buffer.byteLength(OBSERVER_MANIFEST)
  );
  const source = await readBoundedTrustedFile(
    sourcePath,
    canonicalObserverRoot,
    Buffer.byteLength(OBSERVER_SOURCE)
  );
  if (manifest !== OBSERVER_MANIFEST || source !== OBSERVER_SOURCE) {
    throw new Error("VS Code observer materialization content did not match its trusted definition");
  }
  if (requireMissingMarker) {
    const expectedRegistry = observerRegistry(canonicalObserverRoot);
    const registryPath = await validateContainedRegularFile(
      canonicalExtensionsDir,
      ["extensions.json"],
      Buffer.byteLength(expectedRegistry)
    );
    const registry = await readBoundedTrustedFile(
      registryPath,
      canonicalExtensionsDir,
      Buffer.byteLength(expectedRegistry)
    );
    if (registry !== expectedRegistry) {
      throw new Error("VS Code observer registration content did not match its trusted definition");
    }
    const markerInfo = await lstatIfPresent(join(canonicalObserverRoot, OBSERVER_MARKER_FILENAME));
    if (markerInfo) throw new Error("VS Code observer marker existed before the client observation session");
  }
}

async function validateObserverMarker(tempRoot: string, observerRoot: string, markerPath: string): Promise<boolean> {
  const markerInfo = await lstatIfPresent(markerPath);
  if (!markerInfo) return false;
  if (markerPath !== join(observerRoot, OBSERVER_MARKER_FILENAME) || !isWithin(tempRoot, markerPath)
    || !markerInfo.isFile() || markerInfo.isSymbolicLink()
    || markerInfo.size !== Buffer.byteLength(OBSERVER_MARKER_CONTENT)) {
    throw new Error("VS Code observer marker was outside trusted bounds");
  }
  await validateObserverMaterialization(
    tempRoot,
    join(tempRoot, "extensions"),
    observerRoot,
    false
  );
  const canonicalObserverRoot = await realpath(observerRoot);
  const canonicalMarkerPath = await validateContainedRegularFile(
    canonicalObserverRoot,
    [OBSERVER_MARKER_FILENAME],
    Buffer.byteLength(OBSERVER_MARKER_CONTENT)
  );
  const marker = await readBoundedTrustedFile(
    canonicalMarkerPath,
    canonicalObserverRoot,
    Buffer.byteLength(OBSERVER_MARKER_CONTENT)
  );
  if (marker !== OBSERVER_MARKER_CONTENT) {
    throw new Error("VS Code observer marker content was not trusted");
  }
  return true;
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
    await delay(TERMINATION_SETTLE_MS);
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
    if (!/\[file watcher \((?:universal|node\.js|parcel|'node\.js'|'parcel'|chokidar|nsfw)\)\]/.test(line)) continue;
    if (!/(?:request to start watching:|started watching:|starting fs\.watchfile\(\) on|reusing an existing recursive watcher for)/.test(line)) continue;
    if (!rootForms.some((root) => containsBoundedPathReference(line, root))) continue;
    matches += 1;
    if (matches === 64) break;
  }
  return matches;
}

function containsBoundedPathReference(line: string, path: string): boolean {
  let offset = 0;
  while (offset <= line.length - path.length) {
    const index = line.indexOf(path, offset);
    if (index < 0) return false;
    const before = index === 0 ? "" : line[index - 1]!;
    const afterIndex = index + path.length;
    const after = afterIndex === line.length ? "" : line[afterIndex]!;
    const boundedBefore = before === "" || /[\s'"([{:]/.test(before);
    const boundedAfter = after === "" || /[\/\s'"),\]}:]/.test(after);
    if (boundedBefore && boundedAfter) return true;
    offset = index + 1;
  }
  return false;
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
        const truncated = openedInfo.size > maximum;
        const separatorLength = truncated ? 1 : 0;
        const payloadMaximum = maximum - separatorLength;
        const firstLength = truncated ? Math.floor(payloadMaximum / 2) : payloadMaximum;
        const first = Buffer.alloc(firstLength);
        const firstRead = await handle.read(first, 0, firstLength, 0);
        chunks.push(first.subarray(0, firstRead.bytesRead));
        retainedBytes += firstRead.bytesRead;
        if (truncated) {
          chunks.push(Buffer.from("\n"));
          retainedBytes += 1;
        }
        const lastLength = payloadMaximum - firstRead.bytesRead;
        if (lastLength > 0) {
          const last = Buffer.alloc(lastLength);
          const lastRead = await handle.read(last, 0, lastLength, openedInfo.size - lastLength);
          chunks.push(last.subarray(0, lastRead.bytesRead));
          retainedBytes += lastRead.bytesRead;
        }
      } finally {
        await handle.close();
      }
    }
  };

  await visit(canonicalLogsRoot, 0);
  return Buffer.concat(chunks, retainedBytes).toString("utf8");
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(value: FileIdentity): FileIdentity {
  return { dev: value.dev, ino: value.ino };
}

function fileIdentityWithSize(value: FileIdentity & { size: number }): FileIdentity & { size: number } {
  return { ...fileIdentity(value), size: value.size };
}

function sameCanonicalPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function loadOnlyOutput(
  status: ClientRuntimeAdapterOutput["status"],
  clientLoad: ClientRuntimeAdapterOutput["clientLoad"],
  targetClientVersion: string | undefined,
  evidenceItems: ClientRuntimeAdapterOutput["evidence"],
  complete = true
): ClientRuntimeAdapterOutput {
  return {
    status,
    complete,
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
