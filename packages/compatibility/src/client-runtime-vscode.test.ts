import { EventEmitter } from "node:events";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runClientRuntimeHarness, type ClientRuntimeAdapterContext } from "./client-runtime.js";
import {
  createVscodeClientRuntimeAdapter,
  VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES,
  type VscodeClientRuntimeDependencies
} from "./client-runtime-vscode.js";

const packageRoots: string[] = [];

afterEach(async () => {
  for (const root of packageRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("VS Code/GitHub Copilot client runtime adapter", () => {
  it("declares the real target and all conservative opt-in capabilities", () => {
    const adapter = createVscodeClientRuntimeAdapter({ executablePath: process.execPath });
    expect(adapter.metadata).toEqual({
      adapter: { id: "vscode-github-copilot", version: "1.0.0" },
      targetClient: { id: "vscode-github-copilot", name: "VS Code/GitHub Copilot" },
      synthetic: false,
      requiredCapabilities: ["package-read", "client-process", "client-filesystem", "network"]
    });
    expect(VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES).toEqual(adapter.metadata.requiredCapabilities);
  });

  it("uses direct bounded process invocations, isolated settings, genuine load evidence, and deterministic cleanup", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, {
      clientOutput: `trace token=fixture-secret-value ${"x".repeat(200_000)}`,
      logOutput: `Agent plugin discovery read ${join(packageRoot, "plugin.json")}`,
      environment: {
        PATH: process.env.PATH,
        SystemRoot: "C:\\malicious-system-root",
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "wayland-fixture",
        XAUTHORITY: "C:\\sensitive\\xauthority",
        GITHUB_TOKEN: "must-not-be-inherited",
        NPM_TOKEN: "also-must-not-be-inherited"
      }
    });
    const adapter = createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    });
    const report = await runClientRuntimeHarness(packageRoot, adapter, {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report).toMatchObject({
      synthetic: false,
      targetClient: { id: "vscode-github-copilot", version: "1.117.2" },
      execution: { status: "pass", complete: true, finalize: "complete" },
      packageInstall: "not-observed",
      clientLoad: "observed",
      mcpStartup: "not-assessed",
      mcpHandshake: "not-assessed",
      toolExposure: "not-assessed",
      interoperability: "not-established"
    });
    expect(JSON.stringify(report)).not.toContain("fixture-secret-value");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-LOAD-001");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-REGISTER-001");

    const vscodeInvocations = fake.invocations.filter((item) => item.executable === process.execPath);
    expect(vscodeInvocations).toHaveLength(2);
    expect(vscodeInvocations[0]!.args).toContain("--version");
    expect(vscodeInvocations[1]!.args).toContain("--wait");
    for (const invocation of fake.invocations) {
      expect(invocation.options.shell).toBe(false);
      expect(Array.isArray(invocation.args)).toBe(true);
    }
    const main = vscodeInvocations[1]!;
    expect(main.options.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(main.options.env).not.toHaveProperty("NPM_TOKEN");
    expect(main.options.env).not.toHaveProperty("XAUTHORITY");
    expect(main.options.env.DISPLAY).toBe(":99");
    expect(main.options.env.WAYLAND_DISPLAY).toBe("wayland-fixture");
    expect(main.options.env.HOME).toContain("agentplugin-vscode-");
    expect(main.options.env.USERPROFILE).toBe(main.options.env.HOME);
    const userDataIndex = main.args.indexOf("--user-data-dir");
    const userDataDir = main.args[userDataIndex + 1]!;
    const settings = JSON.parse(await fake.settingsReads[0]!) as Record<string, unknown>;
    expect(settings).toMatchObject({
      "chat.plugins.enabled": true,
      "chat.mcp.access": "none",
      "chat.plugins.marketplaces": [],
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "workbench.enableExperiments": false
    });
    expect(settings["chat.pluginLocations"]).toEqual({ [packageRoot]: true });
    expect(await stat(join(userDataDir, "..")).catch(() => undefined)).toBeUndefined();

    const context = contextFor(packageRoot);
    await adapter.finalize?.(context, "pass");
    await adapter.finalize?.(context, "pass");
  });

  it("uses the fixed trusted Windows cleanup executable despite a malicious SystemRoot", async () => {
    const packageRoot = await createPackage();
    const executablePath = join(packageRoot, "fixture-code.exe");
    await writeFile(executablePath, "fixture", "utf8");
    const fake = fakeRuntime(packageRoot, {
      platform: "win32",
      environment: {
        PATH: "C:\\malicious-path",
        SystemRoot: "C:\\malicious-system-root",
        WINDIR: "C:\\malicious-windir"
      }
    });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.execution).toEqual({ status: "pass", complete: true, finalize: "complete" });
    const cleanupInvocations = fake.invocations.filter((item) => item.args.includes("/pid"));
    expect(cleanupInvocations).toHaveLength(1);
    expect(cleanupInvocations[0]!.executable).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(cleanupInvocations[0]!.options.shell).toBe(false);
  });

  it("fails closed when the fixed trusted Windows cleanup executable cannot spawn", async () => {
    const packageRoot = await createPackage();
    const executablePath = join(packageRoot, "fixture-code.exe");
    await writeFile(executablePath, "fixture", "utf8");
    const fake = fakeRuntime(packageRoot, {
      platform: "win32",
      cleanupSpawnFailure: true,
      tempDirectory: packageRoot
    });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.execution).toEqual({ status: "fail", complete: false, finalize: "failed" });
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-LIFECYCLE-001");
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-LIFECYCLE-003");
  });

  it("fails closed when client output does not prove discovery or reading", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, {
      clientOutput: `settings mention ${packageRoot} plugin.json token=do-not-retain-this-secret`
    });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });
    expect(report).toMatchObject({
      execution: { status: "unknown", complete: true, finalize: "complete" },
      packageInstall: "not-observed",
      clientLoad: "not-observed",
      interoperability: "not-established"
    });
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-VSCODE-LOAD-002");
    expect(JSON.stringify(report)).not.toContain("do-not-retain-this-secret");
  });

  it("does not classify plugin-location registration as genuine client loading", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, {
      clientOutput: `Registered chat plugin location ${packageRoot} plugin.json`
    });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.execution).toEqual({ status: "unknown", complete: true, finalize: "complete" });
    expect(report.clientLoad).toBe("not-observed");
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-VSCODE-LOAD-002");
  });

  it("reports a bounded directly obtained version and refuses unrecognized version output", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, { versionOutput: "not-a-version\ncredential=hidden-value\n" });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });
    expect(report.targetClient.version).toBeUndefined();
    expect(report.execution).toEqual({ status: "unknown", complete: true, finalize: "complete" });
    expect(report.clientLoad).toBe("unknown");
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-VSCODE-VERSION-002");
    expect(JSON.stringify(report)).not.toContain("hidden-value");
    expect(fake.invocations.filter((item) => item.executable === process.execPath)).toHaveLength(1);
  });

  it("denies missing capabilities before validation or process execution", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot);
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: "relative-code.exe",
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: ["package-read", "client-process", "client-filesystem"]
    });
    expect(report.execution).toEqual({ status: "denied", complete: false, finalize: "not-run" });
    expect(report.requestedCapabilities).toEqual(["client-filesystem", "client-process", "network", "package-read"]);
    expect(fake.invocations).toEqual([]);
  });

  it("validates the executable and package manifest without leaking rejected paths", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot);
    const relativeExecutable = "relative-token=private-value-code.exe";
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: relativeExecutable,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES]
    });
    expect(report.execution.status).toBe("fail");
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-LIFECYCLE-001");
    expect(JSON.stringify(report)).not.toContain("private-value");
    expect(fake.invocations).toEqual([]);

    expect(() => createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 99
    })).toThrow("observation window");
  });

  it("rejects a symlinked package root without traversing or launching the client", async () => {
    const packageRoot = await createPackage();
    const linkParent = await mkdtemp(join(tmpdir(), "agentplugin-vscode-link-"));
    packageRoots.push(linkParent);
    const linkedRoot = join(linkParent, "linked-package");
    await symlink(packageRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const fake = fakeRuntime(packageRoot);
    const report = await runClientRuntimeHarness(linkedRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES]
    });
    expect(report.execution.status).toBe("fail");
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-LIFECYCLE-001");
    expect(fake.invocations).toEqual([]);
  });

  it("rejects a nested package directory symlink before launching the client", async (testContext) => {
    const packageRoot = await createPackage();
    const externalSkill = await mkdtemp(join(tmpdir(), "agentplugin-vscode-external-skill-"));
    packageRoots.push(externalSkill);
    await writeFile(join(externalSkill, "SKILL.md"), "external skill contents", "utf8");
    mkdirSync(join(packageRoot, "skills"), { recursive: true });
    try {
      await symlink(
        externalSkill,
        join(packageRoot, "skills", "linked-skill"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      if (isSymlinkPrivilegeError(error)) {
        testContext.skip();
        return;
      }
      throw error;
    }

    const fake = fakeRuntime(packageRoot);
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES]
    });

    expect(report.execution.status).toBe("fail");
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-LIFECYCLE-001");
    expect(fake.invocations).toEqual([]);
  });

  it("does not follow a log directory symlink outside isolated client state", async (testContext) => {
    const packageRoot = await createPackage();
    const externalLogs = await mkdtemp(join(tmpdir(), "agentplugin-vscode-external-logs-"));
    packageRoots.push(externalLogs);
    await writeFile(
      join(externalLogs, "trace.log"),
      `Agent plugin discovery read ${join(packageRoot, "plugin.json")}`,
      "utf8"
    );
    const fake = fakeRuntime(packageRoot, {
      clientOutput: "client started without qualifying package evidence",
      externalLogDirectory: externalLogs
    });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });
    const linkError = fake.logLinkErrors[0];
    if (linkError) {
      if (isSymlinkPrivilegeError(linkError)) {
        testContext.skip();
        return;
      }
      throw linkError;
    }

    expect(report.execution).toEqual({ status: "unknown", complete: true, finalize: "complete" });
    expect(report.clientLoad).toBe("not-observed");
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-VSCODE-LOAD-002");
  });

  it("honors harness abort, cleans the client process tree, and removes isolated state", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, { clientOutput: "client started without qualifying evidence" });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 1_000,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 100
    });
    expect(report.execution).toEqual({ status: "timeout", complete: false, finalize: "complete" });
    expect(fake.terminatedPids.length).toBeGreaterThan(0);
    const main = fake.invocations.find((item) => item.args.includes("--wait"));
    expect(main).toBeDefined();
    expect(await stat(main!.options.cwd as string).catch(() => undefined)).toBeUndefined();
  });
});

interface Invocation {
  executable: string;
  args: string[];
  options: Parameters<VscodeClientRuntimeDependencies["spawn"]>[2];
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  #finished = false;

  constructor(readonly pid: number) {
    super();
  }

  finish(code = 0): void {
    if (this.#finished) return;
    this.#finished = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, null);
  }

  kill(): boolean {
    this.finish(null as unknown as number);
    return true;
  }
}

function fakeRuntime(
  packageRoot: string,
  options: {
    versionOutput?: string;
    clientOutput?: string;
    logOutput?: string;
    externalLogDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    cleanupSpawnFailure?: boolean;
    tempDirectory?: string;
  } = {}
): {
  dependencies: Partial<VscodeClientRuntimeDependencies>;
  invocations: Invocation[];
  settingsReads: Array<Promise<string>>;
  terminatedPids: number[];
  logLinkErrors: unknown[];
} {
  const invocations: Invocation[] = [];
  const settingsReads: Array<Promise<string>> = [];
  const children = new Map<number, FakeChild>();
  const terminatedPids: number[] = [];
  const logLinkErrors: unknown[] = [];
  let nextPid = 4_000;
  const dependencies: Partial<VscodeClientRuntimeDependencies> = {
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.tempDirectory ? { tempDirectory: () => options.tempDirectory! } : {}),
    environment: options.environment ?? {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GITHUB_TOKEN: "must-not-be-inherited"
    },
    spawn(executable, rawArgs, spawnOptions) {
      const args = [...rawArgs];
      const child = new FakeChild(nextPid++);
      children.set(child.pid, child);
      invocations.push({ executable, args, options: spawnOptions });
      if (options.cleanupSpawnFailure && executable === "C:\\Windows\\System32\\taskkill.exe") {
        throw new Error("fixture cleanup spawn failure");
      }
      if (args.includes("--version")) {
        queueMicrotask(() => {
          child.stdout.write(options.versionOutput ?? "1.117.2\nfixture-commit\nx64\n");
          child.finish(0);
        });
      } else if (executable.toLowerCase().endsWith("taskkill.exe")) {
        queueMicrotask(() => {
          const pid = Number(args[args.indexOf("/pid") + 1]);
          terminatedPids.push(pid);
          children.get(pid)?.finish(0);
          child.finish(0);
        });
      } else {
        const userDataIndex = args.indexOf("--user-data-dir");
        const userDataDir = args[userDataIndex + 1]!;
        settingsReads.push(readFile(join(userDataDir, "User", "settings.json"), "utf8"));
        if (options.logOutput) {
          const logDirectory = join(userDataDir, "logs", "fixture-session");
          mkdirSync(logDirectory, { recursive: true });
          writeFileSync(join(logDirectory, "trace.log"), options.logOutput, "utf8");
        }
        if (options.externalLogDirectory) {
          const logsRoot = join(userDataDir, "logs");
          mkdirSync(logsRoot, { recursive: true });
          try {
            symlinkSync(
              options.externalLogDirectory,
              join(logsRoot, "external-session"),
              process.platform === "win32" ? "junction" : "dir"
            );
          } catch (error) {
            logLinkErrors.push(error);
          }
        }
        queueMicrotask(() => child.stderr.write(options.clientOutput ??
          `Agent plugin watcher discovered ${join(packageRoot, "plugin.json")}`));
      }
      return child as never;
    },
    killProcess(pid) {
      const target = Math.abs(pid);
      terminatedPids.push(target);
      children.get(target)?.finish(0);
    }
  };
  return { dependencies, invocations, settingsReads, terminatedPids, logLinkErrors };
}

async function createPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentplugin-vscode-package-"));
  packageRoots.push(root);
  await writeFile(join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "vscode-fixture"
  }), "utf8");
  return await import("node:fs/promises").then(({ realpath }) => realpath(root));
}

function contextFor(packageRoot: string): ClientRuntimeAdapterContext {
  return {
    packageRoot,
    signal: new AbortController().signal,
    grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES]
  };
}

function isSymlinkPrivilegeError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "EPERM" || error.code === "EACCES");
}
