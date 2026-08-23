import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runClientRuntimeHarness, type ClientRuntimeAdapterContext } from "./client-runtime.js";
import {
  createVscodeClientRuntimeAdapter,
  VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES,
  type VscodeClientRuntimeDependencies
} from "./client-runtime-vscode.js";

const packageRoots: string[] = [];
const OBSERVER_DIRECTORY = "agent-plugin-ci.agent-plugin-ci-runtime-observer-1.0.0";
const OBSERVER_MARKER_FILENAME = "consumer-surface-exercised.marker";
const OBSERVER_MARKER_CONTENT = "agent-plugin-ci:consumer-surface-exercised:v1\n";
const OBSERVER_MCP_EVIDENCE_FILENAME = "client-mediated-mcp-evidence.json";
const EXPECTED_MCP_SERVER_NAME = "agent-plugin-ci-phase3f-fixture";
const EXPECTED_MCP_TOOL_NAME = "phase3f_fixture_echo";
const EXPECTED_MCP_TOOL_RESULT = "agent-plugin-ci:phase3g-tool-invocation-ok:v1";
const EXPECTED_VSCODE_MCP_TOOL_ID = "mcp_agent-plugin-_phase3f_fixture_echo";

afterEach(async () => {
  for (const root of packageRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("VS Code/GitHub Copilot client runtime adapter", () => {
  it("declares the real target and all conservative opt-in capabilities", () => {
    const adapter = createVscodeClientRuntimeAdapter({ executablePath: process.execPath });
    expect(adapter.metadata).toEqual({
      adapter: { id: "vscode-github-copilot", version: "1.5.0" },
      targetClient: { id: "vscode-github-copilot", name: "VS Code/GitHub Copilot" },
      synthetic: false,
      requiredCapabilities: ["package-read", "client-process", "client-filesystem", "network"]
    });
    expect(VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES).toEqual(adapter.metadata.requiredCapabilities);
  });

  it("serves the deterministic repository MCP fixture through a bounded direct process", async () => {
    const responses = await runDeterministicFixtureExchange();
    expect(responses).toHaveLength(3);
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: { name: EXPECTED_MCP_SERVER_NAME, version: "1.0.0" }
      }
    });
    expect(responses[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: EXPECTED_MCP_TOOL_NAME, annotations: { readOnlyHint: true, openWorldHint: false } }] }
    });
    expect(responses[2]).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: EXPECTED_MCP_TOOL_RESULT }] }
    });
  });

  it("keeps client-mediated MCP denied independently of the generic client lifecycle", async () => {
    const packageRoot = await createPackage({ mcpServerName: "phase3f-fixture" });
    const fake = fakeRuntime(packageRoot);
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      allowMcpRuntime: true,
      dependencies: fake.dependencies
    }), {
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES]
    });

    expect(report.execution).toEqual({ status: "denied", complete: false, finalize: "not-run" });
    expect(report.mcpStartup).toBe("not-assessed");
    expect(report.toolInvocation).toBe("not-assessed");
    expect(fake.invocations).toEqual([]);
  });

  it("reports exactly attributable client-mediated startup, handshake, tool exposure, and tool invocation", async () => {
    const serverName = "phase3f-fixture";
    const packageRoot = await createPackage({ mcpServerName: serverName });
    const fake = fakeRuntime(packageRoot, {
      versionOutput: "1.131.0\nfixture-commit\nx64\n",
      mcpEvidence: validMcpEvidence(packageRoot, serverName)
    });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      allowMcpRuntime: true,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report).toMatchObject({
      execution: { status: "pass", complete: true, finalize: "complete" },
      packageInstall: "not-observed",
      clientLoad: "observed",
      mcpStartup: "observed",
      mcpHandshake: "observed",
      toolExposure: "observed",
      toolInvocation: "observed",
      interoperability: "scoped-established",
      interoperabilityScope: "named-client-version-mcp-tool-path"
    });
    expect(report.note).toContain("Package installation is a separate observation");
    expect(report.note).toContain("No general or universal client interoperability is claimed");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-MCP-OBSERVED-001");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-TOOL-INVOKED-001");
    const settings = JSON.parse(await fake.settingsReads[0]!) as Record<string, unknown>;
    expect(settings["chat.mcp.access"]).toBe("all");
    expect(settings["chat.mcp.autostart"]).toBe("never");
    const observerManifest = JSON.parse(await fake.observerManifestReads[0]!) as Record<string, unknown>;
    expect(observerManifest.enabledApiProposals).toEqual(["chatParticipantAdditions"]);
    const observerSource = await fake.observerSourceReads[0]!;
    expect(observerSource).toContain('executeCommand("workbench.mcp.startServer", serverId');
    expect(observerSource).toContain("LanguageModelToolMCPSource");
    expect(observerSource).toContain("waitForLiveTools: true");
    expect(observerSource).toContain("vscode.lm.invokeTool(eligibleTools[0].name, {");
    expect(observerSource).toContain("toolInvocationToken: undefined");
    expect(observerSource).toContain(EXPECTED_VSCODE_MCP_TOOL_ID);
    expect(observerSource).not.toContain("selectChatModels");
    expect(JSON.stringify(report)).not.toContain(packageRoot);
  });

  it("rejects malformed or ambiguous client-mediated MCP observer evidence", async () => {
    const serverName = "phase3f-fixture";
    const packageRoot = await createPackage({ mcpServerName: serverName });
    for (const mcpEvidence of [
      "{not-json",
      validMcpEvidence(packageRoot, serverName, {
        tools: [
          { name: "duplicate-secret-value", sourceLabel: serverName, sourceName: EXPECTED_MCP_SERVER_NAME },
          { name: "duplicate-secret-value", sourceLabel: serverName, sourceName: EXPECTED_MCP_SERVER_NAME }
        ],
        invocation: { attempted: false, completed: false, resultMatched: false }
      }),
      validMcpEvidence(packageRoot, serverName, {
        tools: [{
          name: EXPECTED_VSCODE_MCP_TOOL_ID,
          sourceLabel: serverName,
          sourceName: "raw-source-secret-value"
        }]
      })
    ]) {
      const fake = fakeRuntime(packageRoot, { mcpEvidence });
      const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
        executablePath: process.execPath,
        observationWindowMs: 100,
        allowMcpRuntime: true,
        dependencies: fake.dependencies
      }), {
        allowExecution: true,
        grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
        timeoutMs: 2_000
      });
      expect(report.execution).toEqual({ status: "fail", complete: false, finalize: "complete" });
      expect(report.mcpHandshake).toBe("unknown");
      expect(report.toolExposure).toBe("unknown");
      expect(report.toolInvocation).toBe("unknown");
      expect(report.interoperability).toBe("not-established");
      expect(report.interoperabilityScope).toBe("none");
      expect(JSON.stringify(report)).not.toContain("secret-value");
    }
  });

  it("keeps exposure observed while classifying bounded non-successful invocations", async () => {
    const serverName = "phase3f-fixture";
    const packageRoot = await createPackage({ mcpServerName: serverName });
    const cases = [
      {
        evidence: validMcpEvidence(packageRoot, serverName, {
          tools: [
            { name: EXPECTED_VSCODE_MCP_TOOL_ID, sourceLabel: serverName, sourceName: EXPECTED_MCP_SERVER_NAME },
            { name: "second_matching_tool", sourceLabel: serverName, sourceName: EXPECTED_MCP_SERVER_NAME }
          ],
          invocation: { attempted: false, completed: false, resultMatched: false }
        }),
        summary: "No uniquely eligible newly exposed tool was invoked."
      },
      {
        evidence: validMcpEvidence(packageRoot, serverName, {
          tools: [{ name: "wrong_client_tool_id", sourceLabel: serverName, sourceName: EXPECTED_MCP_SERVER_NAME }],
          invocation: { attempted: false, completed: false, resultMatched: false }
        }),
        summary: "No uniquely eligible newly exposed tool was invoked."
      },
      {
        evidence: validMcpEvidence(packageRoot, serverName, {
          invocation: { attempted: true, completed: false, resultMatched: false }
        }),
        summary: "VS Code did not complete the bounded tool invocation; arbitrary client/tool error details were discarded."
      },
      {
        evidence: validMcpEvidence(packageRoot, serverName, {
          invocation: { attempted: true, completed: true, resultMatched: false }
        }),
        summary: "VS Code completed the bounded tool invocation, but the exact deterministic result did not match."
      }
    ];

    for (const fixtureCase of cases) {
      const fake = fakeRuntime(packageRoot, { mcpEvidence: fixtureCase.evidence });
      const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
        executablePath: process.execPath,
        observationWindowMs: 100,
        allowMcpRuntime: true,
        dependencies: fake.dependencies
      }), {
        allowExecution: true,
        grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
        timeoutMs: 2_000
      });
      expect(report.execution).toEqual({ status: "unknown", complete: true, finalize: "complete" });
      expect(report.toolExposure).toBe("observed");
      expect(report.toolInvocation).toBe("not-observed");
      expect(report.interoperability).toBe("not-established");
      expect(report.interoperabilityScope).toBe("none");
      expect(report.evidence).toContainEqual(expect.objectContaining({
        code: "APCI-CLIENT-VSCODE-TOOL-INVOKED-002",
        summary: fixtureCase.summary
      }));
    }
  });

  it("fails closed on malformed or ambiguous invocation evidence without retaining raw values", async () => {
    const serverName = "phase3f-fixture";
    const packageRoot = await createPackage({ mcpServerName: serverName });
    const secret = "raw-invocation-secret-value";
    for (const mcpEvidence of [
      validMcpEvidence(packageRoot, serverName, {
        invocation: { attempted: true, completed: false, resultMatched: true }
      }),
      validMcpEvidence(packageRoot, serverName, {
        invocation: { attempted: true, completed: true, resultMatched: true, rawResult: secret }
      }),
      validMcpEvidence(packageRoot, serverName, {
        tools: [
          { name: EXPECTED_VSCODE_MCP_TOOL_ID, sourceLabel: serverName, sourceName: EXPECTED_MCP_SERVER_NAME },
          { name: "ambiguous_second_tool", sourceLabel: serverName, sourceName: EXPECTED_MCP_SERVER_NAME }
        ],
        invocation: { attempted: true, completed: true, resultMatched: true }
      })
    ]) {
      const fake = fakeRuntime(packageRoot, { mcpEvidence });
      const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
        executablePath: process.execPath,
        observationWindowMs: 100,
        allowMcpRuntime: true,
        dependencies: fake.dependencies
      }), {
        allowExecution: true,
        grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
        timeoutMs: 2_000
      });
      expect(report.execution).toEqual({ status: "fail", complete: false, finalize: "complete" });
      expect(report.toolExposure).toBe("unknown");
      expect(report.toolInvocation).toBe("unknown");
      expect(report.interoperability).toBe("not-established");
      expect(report.interoperabilityScope).toBe("none");
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(JSON.stringify(report)).not.toContain("rawResult");
      expect(JSON.stringify(report)).not.toContain("ambiguous_second_tool");
    }
  });

  it("makes no MCP lifecycle claim when the trusted observer produces no MCP evidence", async () => {
    const packageRoot = await createPackage({ mcpServerName: "phase3f-fixture" });
    const fake = fakeRuntime(packageRoot);
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      allowMcpRuntime: true,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });
    expect(report.clientLoad).toBe("observed");
    expect(report.mcpStartup).toBe("unknown");
    expect(report.mcpHandshake).toBe("unknown");
    expect(report.toolExposure).toBe("unknown");
    expect(report.toolInvocation).toBe("unknown");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-TOOL-INVOKED-003");
    expect(report.interoperability).toBe("not-established");
    expect(report.interoperabilityScope).toBe("none");
  });

  it("uses the validated bundled Windows CLI for version and a strictly derived shadow executable for GUI loading", async () => {
    const packageRoot = await createPackage();
    const installation = await createWindowsVscodeInstallation();
    const installationEntriesBefore = await readdir(installation.installationRoot);
    const executableLinksBefore = (await stat(installation.executablePath)).nlink;
    let shadowInspection: {
      executablePath: string;
      executableIdentityMatches: boolean;
      executableSizeMatches: boolean;
      executableIsRegularNonSymlink: boolean;
      junctionIsSymlink: boolean;
      junctionRawTarget: string;
      junctionRealTarget: string;
    } | undefined;
    const fake = fakeRuntime(packageRoot, {
      platform: "win32",
      bundledVersionOutput: "1.118.0\nfixture-commit\nx64\n",
      directVersionOutput: "",
      onGuiSpawn(executablePath) {
        const sourceInfo = statSync(installation.executablePath);
        const shadowInfo = lstatSync(executablePath);
        const junctionPath = join(dirname(executablePath), installation.versionDirectoryName);
        const junctionInfo = lstatSync(junctionPath);
        shadowInspection = {
          executablePath,
          executableIdentityMatches: sourceInfo.dev === shadowInfo.dev && sourceInfo.ino === shadowInfo.ino,
          executableSizeMatches: sourceInfo.size === shadowInfo.size,
          executableIsRegularNonSymlink: shadowInfo.isFile() && !shadowInfo.isSymbolicLink(),
          junctionIsSymlink: junctionInfo.isSymbolicLink(),
          junctionRawTarget: readlinkSync(junctionPath),
          junctionRealTarget: realpathSync(junctionPath)
        };
      }
    });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: installation.executablePath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report).toMatchObject({
      adapter: { version: "1.5.0" },
      targetClient: { version: "1.118.0" },
      execution: { status: "pass", complete: true, finalize: "complete" },
      packageInstall: "not-observed",
      clientLoad: "observed",
      mcpStartup: "not-assessed",
      mcpHandshake: "not-assessed",
      toolExposure: "not-assessed",
      toolInvocation: "not-assessed",
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    const installedExecutableInvocations = fake.invocations.filter(
      (item) => item.executable === installation.executablePath
    );
    expect(installedExecutableInvocations).toHaveLength(1);
    const versionInvocation = installedExecutableInvocations[0]!;
    expect(versionInvocation.args[0]).toBe(installation.cliPath);
    expect(versionInvocation.args).toContain("--version");
    expect(versionInvocation.options.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(versionInvocation.options.shell).toBe(false);
    const loadInvocation = fake.invocations.find((item) => item.args.includes("--wait"))!;
    expect(loadInvocation.executable).not.toBe(installation.executablePath);
    expect(loadInvocation.executable).toBe(shadowInspection?.executablePath);
    expect(basename(loadInvocation.executable)).toBe("Code.exe");
    expect(basename(dirname(loadInvocation.executable))).toBe("client-shadow");
    expect(loadInvocation.args[0]).toBe(join(
      dirname(loadInvocation.executable),
      installation.versionDirectoryName,
      "resources",
      "app",
      "out",
      "cli.js"
    ));
    expect(loadInvocation.args).toContain("--wait");
    expect(loadInvocation.args).not.toContain(installation.cliPath);
    expect(loadInvocation.options.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(shadowInspection).toMatchObject({
      executableIdentityMatches: true,
      executableSizeMatches: true,
      executableIsRegularNonSymlink: true,
      junctionIsSymlink: true,
      junctionRealTarget: installation.versionDirectory
    });
    const rawTarget = shadowInspection!.junctionRawTarget;
    expect(resolve(isAbsolute(rawTarget) ? rawTarget : join(dirname(loadInvocation.executable), rawTarget)))
      .toBe(resolve(installation.versionDirectory));
    expect(await readdir(installation.installationRoot)).toEqual(installationEntriesBefore);
    expect((await stat(installation.executablePath)).nlink).toBe(executableLinksBefore);
    expect(JSON.stringify(report)).toContain("validated bundled CLI entrypoint");
  });

  it("falls back to the validated installed executable when the shadow hardlink cannot be created", async () => {
    const packageRoot = await createPackage();
    const installation = await createWindowsVscodeInstallation();
    const installationEntriesBefore = await readdir(installation.installationRoot);
    const executableLinksBefore = (await stat(installation.executablePath)).nlink;
    const fake = fakeRuntime(packageRoot, { platform: "win32" });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: installation.executablePath,
      observationWindowMs: 100,
      dependencies: {
        ...fake.dependencies,
        async linkFile() {
          throw new Error("fixture hardlink failure");
        }
      }
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.clientLoad).toBe("observed");
    const loadInvocation = fake.invocations.find((item) => item.args.includes("--wait"))!;
    expect(loadInvocation.executable).toBe(installation.executablePath);
    expect(loadInvocation.args[0]).toBe("--user-data-dir");
    expect(loadInvocation.options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(await readdir(installation.installationRoot)).toEqual(installationEntriesBefore);
    expect((await stat(installation.executablePath)).nlink).toBe(executableLinksBefore);
  });

  it("rejects a non-hardlinked shadow executable and falls back without launching it", async () => {
    const packageRoot = await createPackage();
    const installation = await createWindowsVscodeInstallation();
    const fake = fakeRuntime(packageRoot, { platform: "win32" });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: installation.executablePath,
      observationWindowMs: 100,
      dependencies: {
        ...fake.dependencies,
        async linkFile(existingPath, newPath) {
          await symlink(existingPath, newPath, "file");
        }
      }
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.clientLoad).toBe("observed");
    expect(fake.invocations.find((item) => item.args.includes("--wait"))?.executable)
      .toBe(installation.executablePath);
  });

  it("rejects a shadow junction aimed anywhere except the exact validated version directory", async (testContext) => {
    const packageRoot = await createPackage();
    const installation = await createWindowsVscodeInstallation();
    const wrongTarget = await mkdtemp(join(tmpdir(), "agentplugin-vscode-wrong-shadow-target-"));
    packageRoots.push(wrongTarget);
    const sentinelPath = join(wrongTarget, "must-remain.txt");
    await writeFile(sentinelPath, "preserved", "utf8");
    const fake = fakeRuntime(packageRoot, { platform: "win32" });
    let linkError: unknown;
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: installation.executablePath,
      observationWindowMs: 100,
      dependencies: {
        ...fake.dependencies,
        async createJunction(_target, path) {
          try {
            await symlink(wrongTarget, path, "junction");
          } catch (error) {
            linkError = error;
            throw error;
          }
        }
      }
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });
    if (isSymlinkPrivilegeError(linkError)) {
      testContext.skip();
      return;
    }

    expect(report.clientLoad).toBe("observed");
    expect(fake.invocations.find((item) => item.args.includes("--wait"))?.executable)
      .toBe(installation.executablePath);
    expect(await readFile(sentinelPath, "utf8")).toBe("preserved");
  });

  it("rejects a malformed launcher and falls back without executing adjacent scripts or claiming load", async () => {
    const packageRoot = await createPackage();
    const installation = await createWindowsVscodeInstallation();
    await writeFile(
      installation.launcherPath,
      '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\..\\outside\\malicious.js" %*\r\n',
      "utf8"
    );
    const fake = fakeRuntime(packageRoot, { platform: "win32", directVersionOutput: "not-a-version\n" });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: installation.executablePath,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.execution).toEqual({ status: "unknown", complete: true, finalize: "complete" });
    expect(report.clientLoad).toBe("unknown");
    expect(report.targetClient.version).toBeUndefined();
    const clientInvocations = fake.invocations.filter((item) => item.executable === installation.executablePath);
    expect(clientInvocations).toHaveLength(1);
    expect(clientInvocations[0]!.args[0]).toBe("--user-data-dir");
    expect(clientInvocations[0]!.args.some((arg) => arg.endsWith(".js"))).toBe(false);
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-VSCODE-VERSION-002");
    expect(JSON.stringify(report)).not.toContain("outside");
  });

  it("uses direct version fallback when the validated bundled CLI output is unrecognized", async () => {
    const packageRoot = await createPackage();
    const installation = await createWindowsVscodeInstallation();
    const fake = fakeRuntime(packageRoot, {
      platform: "win32",
      bundledVersionOutput: "mutex probe emitted no version\n",
      directVersionOutput: "1.118.1\nfixture-commit\nx64\n"
    });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: installation.executablePath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.targetClient.version).toBe("1.118.1");
    expect(report.clientLoad).toBe("observed");
    expect(report.mcpHandshake).toBe("not-assessed");
    expect(report.toolInvocation).toBe("not-assessed");
    expect(report.interoperability).toBe("not-established");
    const clientInvocations = fake.invocations.filter((item) => item.executable === installation.executablePath);
    expect(clientInvocations).toHaveLength(2);
    expect(clientInvocations[0]!.args[0]).toBe(installation.cliPath);
    expect(clientInvocations[1]!.args[0]).toBe("--user-data-dir");
    const loadInvocation = fake.invocations.find((item) => item.args.includes("--wait"))!;
    expect(loadInvocation.executable).not.toBe(installation.executablePath);
    expect(basename(dirname(loadInvocation.executable))).toBe("client-shadow");
    expect(JSON.stringify(report)).toContain("bounded direct executable invocation");
    expect(JSON.stringify(report)).not.toContain("mutex probe");
  });

  it("rejects an oversized Windows launcher before bounded direct-version fallback", async () => {
    const packageRoot = await createPackage();
    const installation = await createWindowsVscodeInstallation();
    await writeFile(installation.launcherPath, "x".repeat(8 * 1024 + 1), "utf8");
    const fake = fakeRuntime(packageRoot, { platform: "win32", directVersionOutput: "unrecognized\n" });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: installation.executablePath,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.execution.status).toBe("unknown");
    expect(report.clientLoad).toBe("unknown");
    expect(fake.invocations.filter((item) => item.executable === installation.executablePath)).toHaveLength(1);
    expect(fake.invocations.some((item) => item.args.some((arg) => arg.endsWith("cli.js")))).toBe(false);
  });

  it("rejects a symlinked bundled CLI and never invokes its target", async (testContext) => {
    const packageRoot = await createPackage();
    const installation = await createWindowsVscodeInstallation();
    const externalRoot = await mkdtemp(join(tmpdir(), "agentplugin-vscode-external-cli-"));
    packageRoots.push(externalRoot);
    const externalCli = join(externalRoot, "cli.js");
    await writeFile(externalCli, "malicious fixture", "utf8");
    await rm(installation.cliPath);
    try {
      await symlink(externalCli, installation.cliPath, "file");
    } catch (error) {
      if (isSymlinkPrivilegeError(error)) {
        testContext.skip();
        return;
      }
      throw error;
    }
    const fake = fakeRuntime(packageRoot, { platform: "win32", directVersionOutput: "not-a-version\n" });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: installation.executablePath,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.clientLoad).toBe("unknown");
    expect(fake.invocations.some((item) => item.args.includes(installation.cliPath))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("external-cli");
  });

  it("rejects a symlinked active version directory and never prepares a shadow launcher", async (testContext) => {
    const packageRoot = await createPackage();
    const installation = await createWindowsVscodeInstallation();
    const externalVersion = await mkdtemp(join(tmpdir(), "agentplugin-vscode-external-version-"));
    packageRoots.push(externalVersion);
    mkdirSync(join(externalVersion, "resources", "app", "out"), { recursive: true });
    await writeFile(join(externalVersion, "resources", "app", "out", "cli.js"), "external fixture CLI", "utf8");
    await rm(installation.versionDirectory, { recursive: true });
    try {
      await symlink(externalVersion, installation.versionDirectory, "junction");
    } catch (error) {
      if (isSymlinkPrivilegeError(error)) {
        testContext.skip();
        return;
      }
      throw error;
    }
    const fake = fakeRuntime(packageRoot, {
      platform: "win32",
      directVersionOutput: "1.118.2\nfixture-commit\nx64\n"
    });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: installation.executablePath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.targetClient.version).toBe("1.118.2");
    expect(report.clientLoad).toBe("observed");
    expect(fake.invocations.some((item) => item.args.includes(installation.cliPath))).toBe(false);
    expect(fake.invocations.find((item) => item.args.includes("--wait"))?.executable)
      .toBe(installation.executablePath);
  });

  it("uses direct bounded process invocations, isolated settings, genuine load evidence, and deterministic cleanup", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, {
      clientOutput: `trace token=fixture-secret-value ${"x".repeat(200_000)}`,
      logOutput: `[File Watcher (universal)] Request to start watching: ${packageRoot} (excludes: <none>)`,
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
      toolInvocation: "not-assessed",
      interoperability: "not-established"
    });
    expect(JSON.stringify(report)).not.toContain("fixture-secret-value");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-LOAD-001");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-REGISTER-001");

    const vscodeInvocations = fake.invocations.filter((item) => item.executable === process.execPath);
    expect(vscodeInvocations).toHaveLength(2);
    expect(vscodeInvocations[0]!.args).toContain("--version");
    expect(vscodeInvocations[1]!.args).toContain("--wait");
    const logIndex = vscodeInvocations[1]!.args.indexOf("--log");
    expect(vscodeInvocations[1]!.args[logIndex + 1]).toBe("trace");
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
    const developmentPathIndex = main.args.indexOf("--extensionDevelopmentPath");
    expect(main.args[developmentPathIndex + 1]).toBe(join(
      userDataDir,
      "..",
      "extensions",
      OBSERVER_DIRECTORY
    ));
    expect(main.args[developmentPathIndex + 1]).not.toBe(packageRoot);
    const extensionsIndex = main.args.indexOf("--extensions-dir");
    const extensionsDir = main.args[extensionsIndex + 1]!;
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
    const observerManifest = JSON.parse(await fake.observerManifestReads[0]!) as Record<string, unknown>;
    const observerRegistry = JSON.parse(await fake.observerRegistryReads[0]!) as unknown[];
    const observerSource = await fake.observerSourceReads[0]!;
    expect(observerManifest).toMatchObject({
      name: "agent-plugin-ci-runtime-observer",
      publisher: "agent-plugin-ci",
      version: "1.0.0",
      main: "./extension.js",
      activationEvents: ["*"]
    });
    expect(observerManifest).not.toHaveProperty("dependencies");
    expect(observerRegistry).toEqual([{
      identifier: { id: "agent-plugin-ci.agent-plugin-ci-runtime-observer" },
      version: "1.0.0",
      location: {
        $mid: 1,
        path: decodeURIComponent(pathToFileURL(join(extensionsDir, OBSERVER_DIRECTORY)).pathname),
        scheme: "file"
      },
      relativeLocation: OBSERVER_DIRECTORY
    }]);
    expect(observerSource).toContain('executeCommand("aiCustomization.openManagementEditor")');
    expect(observerSource).toContain(OBSERVER_MARKER_FILENAME);
    expect(observerSource).not.toContain(packageRoot);
    expect(observerSource).not.toMatch(/https?:|fetch\(|request\(|readFile|stat\(|watch\(/);
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
      clientOutput: `settings mention ${packageRoot} plugin.json token=do-not-retain-this-secret`,
      logOutput: null
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
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-VSCODE-LOAD-002");
    expect(JSON.stringify(report)).not.toContain("do-not-retain-this-secret");
  });

  it("does not classify plugin-location registration as genuine client loading", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, {
      clientOutput: `Registered chat plugin location ${packageRoot} plugin.json`,
      logOutput: null
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

  it("does not classify the trusted observer source or activation marker alone as client loading", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, { logOutput: null });
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
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-OBSERVER-001");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-LOAD-002");
  });

  it("makes no loading claim without observer activation even when a watcher-shaped path record exists", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, {
      observerActivation: false,
      logOutput: `[File Watcher (universal)] Request to start watching: ${packageRoot} (excludes: <none>)`
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

    expect(report.execution).toEqual({ status: "unknown", complete: false, finalize: "complete" });
    expect(report.clientLoad).toBe("unknown");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-OBSERVER-002");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-LOAD-003");
    expect(report.evidence.map((item) => item.code)).not.toContain("APCI-CLIENT-VSCODE-LOAD-001");
  });

  it("rejects path echoes and process-output watcher text after observer activation", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, {
      clientOutput: `[File Watcher (universal)] Request to start watching: ${packageRoot} (excludes: <none>)`,
      logOutput: `configuration echo load watch plugin.json ${packageRoot}`
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

    expect(report.clientLoad).toBe("not-observed");
    expect(report.evidence.map((item) => item.code)).toContain("APCI-CLIENT-VSCODE-LOAD-002");
  });

  it("requires an exact bounded package path in trusted watcher records", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, {
      logOutput: `[File Watcher (universal)] Request to start watching: ${packageRoot}-echo (excludes: <none>)`
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

    expect(report.clientLoad).toBe("not-observed");
    expect(report.evidence.map((item) => item.code)).not.toContain("APCI-CLIENT-VSCODE-LOAD-001");
  });

  it("does not synthesize a watcher record across an omitted oversized-log middle", async () => {
    const packageRoot = await createPackage();
    const prefix = "[File Watcher (universal)] Request to start watching: ";
    const perFileLimit = 128 * 1024;
    const priorRetainedHalf = perFileLimit / 2;
    const firstHalf = `${"x".repeat(priorRetainedHalf - prefix.length - 1)}\n${prefix}`;
    const omittedMiddle = "!";
    const suffix = `${packageRoot} (excludes: <none>)`;
    const oversizedLog = `${firstHalf}${omittedMiddle}${suffix}${"y".repeat(
      perFileLimit + 1 - firstHalf.length - omittedMiddle.length - suffix.length
    )}`;
    const fake = fakeRuntime(packageRoot, { logOutput: oversizedLog });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.clientLoad).toBe("not-observed");
    expect(report.evidence.map((item) => item.code)).not.toContain("APCI-CLIENT-VSCODE-LOAD-001");
  });

  it("fails before GUI launch if observer source changes after trusted materialization", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, { tamperObserverSourceDuringVersion: true });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.execution).toEqual({ status: "fail", complete: false, finalize: "complete" });
    expect(report.clientLoad).toBe("unknown");
    expect(fake.invocations.filter((item) => item.executable === process.execPath)).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("tampered observer source");
  });

  it("rejects an altered or oversized observer activation marker", async () => {
    const packageRoot = await createPackage();
    const fake = fakeRuntime(packageRoot, { observerMarkerContent: `${OBSERVER_MARKER_CONTENT}unexpected` });
    const report = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      dependencies: fake.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });

    expect(report.execution).toEqual({ status: "fail", complete: false, finalize: "complete" });
    expect(report.clientLoad).toBe("unknown");
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-LIFECYCLE-001");
    expect(JSON.stringify(report)).not.toContain("unexpected");
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
    expect(report.toolInvocation).toBe("not-assessed");
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-VSCODE-VERSION-002");
    expect(JSON.stringify(report)).not.toContain("hidden-value");
    expect(fake.invocations.filter((item) => item.executable === process.execPath)).toHaveLength(1);
  });

  it("fails closed when MCP is enabled but the target version or client load is unavailable", async () => {
    const serverName = "phase3f-fixture";
    const packageRoot = await createPackage({ mcpServerName: serverName });
    const unavailableVersion = fakeRuntime(packageRoot, {
      versionOutput: "unrecognized-version\nraw-version-secret-value\n"
    });
    const versionReport = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      allowMcpRuntime: true,
      dependencies: unavailableVersion.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });
    expect(versionReport).toMatchObject({
      execution: { status: "unknown", complete: true, finalize: "complete" },
      packageInstall: "not-observed",
      clientLoad: "unknown",
      mcpStartup: "unknown",
      mcpHandshake: "unknown",
      toolExposure: "unknown",
      toolInvocation: "unknown",
      interoperability: "not-established",
      interoperabilityScope: "none"
    });
    expect(unavailableVersion.invocations.some((item) => item.args.includes("--wait"))).toBe(false);
    expect(JSON.stringify(versionReport)).not.toContain("raw-version-secret-value");

    const unavailableClient = fakeRuntime(packageRoot, {
      observerActivation: false,
      mcpEvidence: validMcpEvidence(packageRoot, serverName)
    });
    const clientReport = await runClientRuntimeHarness(packageRoot, createVscodeClientRuntimeAdapter({
      executablePath: process.execPath,
      observationWindowMs: 100,
      allowMcpRuntime: true,
      dependencies: unavailableClient.dependencies
    }), {
      allowExecution: true,
      grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES],
      timeoutMs: 2_000
    });
    expect(clientReport.clientLoad).toBe("unknown");
    expect(clientReport.mcpStartup).toBe("unknown");
    expect(clientReport.toolExposure).toBe("unknown");
    expect(clientReport.toolInvocation).toBe("unknown");
    expect(clientReport.interoperability).toBe("not-established");
    expect(clientReport.interoperabilityScope).toBe("none");
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
      `[File Watcher (universal)] Request to start watching: ${packageRoot} (excludes: <none>)`,
      "utf8"
    );
    const fake = fakeRuntime(packageRoot, {
      clientOutput: "client started without qualifying package evidence",
      logOutput: null,
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

async function runDeterministicFixtureExchange(): Promise<unknown[]> {
  const fixturePath = fileURLToPath(new URL(
    "../../../fixtures/client-runtime/vscode-package/vscode-mcp-server.mjs",
    import.meta.url
  ));
  const maximumOutputBytes = 64 * 1024;
  const timeoutMs = 2_000;
  return await new Promise<unknown[]>((resolveExchange, rejectExchange) => {
    const child = nodeSpawn(process.execPath, [fixturePath], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectExchange(new Error("Deterministic MCP fixture exceeded its bounded timeout"));
    }, timeoutMs);
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      rejectExchange(new Error(message));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        fail("Deterministic MCP fixture exceeded its bounded stdout allowance");
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > maximumOutputBytes) {
        fail("Deterministic MCP fixture exceeded its bounded stderr allowance");
      }
    });
    child.once("error", () => fail("Deterministic MCP fixture failed to launch"));
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectExchange(new Error("Deterministic MCP fixture did not exit successfully"));
        return;
      }
      try {
        const responses = Buffer.concat(output, outputBytes)
          .toString("utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown);
        resolveExchange(responses);
      } catch {
        rejectExchange(new Error("Deterministic MCP fixture emitted malformed JSON"));
      }
    });
    child.stdin.end([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } }
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: EXPECTED_MCP_TOOL_NAME, arguments: {} }
      }),
      ""
    ].join("\n"), "utf8");
  });
}

function fakeRuntime(
  packageRoot: string,
  options: {
    versionOutput?: string;
    bundledVersionOutput?: string;
    directVersionOutput?: string;
    clientOutput?: string;
    logOutput?: string | null;
    externalLogDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    cleanupSpawnFailure?: boolean;
    tempDirectory?: string;
    observerActivation?: boolean;
    observerMarkerContent?: string;
    mcpEvidence?: unknown | string;
    tamperObserverSourceDuringVersion?: boolean;
    onGuiSpawn?: (executable: string, args: readonly string[]) => void;
  } = {}
): {
  dependencies: Partial<VscodeClientRuntimeDependencies>;
  invocations: Invocation[];
  settingsReads: Array<Promise<string>>;
  observerManifestReads: Array<Promise<string>>;
  observerRegistryReads: Array<Promise<string>>;
  observerSourceReads: Array<Promise<string>>;
  terminatedPids: number[];
  logLinkErrors: unknown[];
} {
  const invocations: Invocation[] = [];
  const settingsReads: Array<Promise<string>> = [];
  const observerManifestReads: Array<Promise<string>> = [];
  const observerRegistryReads: Array<Promise<string>> = [];
  const observerSourceReads: Array<Promise<string>> = [];
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
          if (options.tamperObserverSourceDuringVersion) {
            const extensionsIndex = args.indexOf("--extensions-dir");
            const extensionsDir = args[extensionsIndex + 1]!;
            writeFileSync(
              join(extensionsDir, OBSERVER_DIRECTORY, "extension.js"),
              "tampered observer source",
              "utf8"
            );
          }
          const bundledCliInvocation = args[0]?.endsWith("cli.js") ?? false;
          child.stdout.write(
            (bundledCliInvocation ? options.bundledVersionOutput : options.directVersionOutput)
              ?? options.versionOutput
              ?? "1.117.2\nfixture-commit\nx64\n"
          );
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
        options.onGuiSpawn?.(executable, args);
        const userDataIndex = args.indexOf("--user-data-dir");
        const userDataDir = args[userDataIndex + 1]!;
        const extensionsIndex = args.indexOf("--extensions-dir");
        const extensionsDir = args[extensionsIndex + 1]!;
        const observerRoot = join(extensionsDir, OBSERVER_DIRECTORY);
        settingsReads.push(readFile(join(userDataDir, "User", "settings.json"), "utf8"));
        observerManifestReads.push(readFile(join(observerRoot, "package.json"), "utf8"));
        observerRegistryReads.push(readFile(join(extensionsDir, "extensions.json"), "utf8"));
        observerSourceReads.push(readFile(join(observerRoot, "extension.js"), "utf8"));
        if (options.observerActivation !== false) {
          writeFileSync(
            join(observerRoot, OBSERVER_MARKER_FILENAME),
            options.observerMarkerContent ?? OBSERVER_MARKER_CONTENT,
            "utf8"
          );
        }
        if (options.mcpEvidence !== undefined) {
          writeFileSync(
            join(observerRoot, OBSERVER_MCP_EVIDENCE_FILENAME),
            typeof options.mcpEvidence === "string"
              ? options.mcpEvidence
              : JSON.stringify(options.mcpEvidence),
            "utf8"
          );
        }
        const logOutput = options.logOutput === undefined
          ? `[File Watcher (universal)] Request to start watching: ${packageRoot} (excludes: <none>)`
          : options.logOutput;
        if (logOutput !== null) {
          const logDirectory = join(userDataDir, "logs", "fixture-session");
          mkdirSync(logDirectory, { recursive: true });
          writeFileSync(join(logDirectory, "trace.log"), logOutput, "utf8");
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
  return {
    dependencies,
    invocations,
    settingsReads,
    observerManifestReads,
    observerRegistryReads,
    observerSourceReads,
    terminatedPids,
    logLinkErrors
  };
}

async function createPackage(options: { mcpServerName?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentplugin-vscode-package-"));
  packageRoots.push(root);
  await writeFile(join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "vscode-fixture"
  }), "utf8");
  if (options.mcpServerName) {
    const mcpConfig = JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        [options.mcpServerName]: {
          type: "stdio",
          command: "node",
          args: [join(root, "fixture-server.mjs")]
        }
      }
    });
    await writeFile(join(root, "mcp.json"), mcpConfig, "utf8");
    await writeFile(join(root, "fixture-server.mjs"), "// controlled test fixture\n", "utf8");
  }
  return await realpath(root);
}

async function createWindowsVscodeInstallation(): Promise<{
  installationRoot: string;
  executablePath: string;
  launcherPath: string;
  cliPath: string;
  versionDirectoryName: string;
  versionDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agentplugin-vscode-installation-"));
  packageRoots.push(root);
  const versionDirectory = "e4c7e7b1d6";
  const executablePath = join(root, "Code.exe");
  const launcherPath = join(root, "bin", "code.cmd");
  const cliPath = join(root, versionDirectory, "resources", "app", "out", "cli.js");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, versionDirectory, "resources", "app", "out"), { recursive: true });
  await writeFile(executablePath, "fixture executable", "utf8");
  await writeFile(cliPath, "fixture bundled CLI", "utf8");
  await writeFile(
    launcherPath,
    [
      "@echo off",
      "setlocal",
      "set VSCODE_DEV=",
      "set ELECTRON_RUN_AS_NODE=1",
      `"%~dp0..\\Code.exe" "%~dp0..\\${versionDirectory}\\resources\\app\\out\\cli.js" %*`,
      "IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%",
      "endlocal",
      ""
    ].join("\r\n"),
    "utf8"
  );
  return {
    installationRoot: await realpath(root),
    executablePath: await realpath(executablePath),
    launcherPath: await realpath(launcherPath),
    cliPath: await realpath(cliPath),
    versionDirectoryName: versionDirectory,
    versionDirectory: await realpath(join(root, versionDirectory))
  };
}

function contextFor(packageRoot: string): ClientRuntimeAdapterContext {
  return {
    packageRoot,
    signal: new AbortController().signal,
    grantedCapabilities: [...VSCODE_CLIENT_RUNTIME_REQUIRED_CAPABILITIES]
  };
}

function validMcpEvidence(
  packageRoot: string,
  serverName: string,
  options: {
    tools?: Array<{ name: string; sourceLabel: string; sourceName: string }>;
    matchingToolCount?: number;
    newlyExposedToolCount?: number;
    invocation?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  } = {}
) {
  const tools = options.tools ?? [{
    name: EXPECTED_VSCODE_MCP_TOOL_ID,
    sourceLabel: serverName,
    sourceName: EXPECTED_MCP_SERVER_NAME
  }];
  return {
    schemaVersion: "1.1.0",
    expectedServerLabel: serverName,
    expectedServerName: EXPECTED_MCP_SERVER_NAME,
    expectedToolName: EXPECTED_MCP_TOOL_NAME,
    serverId: `plugin.${pathToFileURL(packageRoot).href}.${serverName}`,
    startCommandCompleted: true,
    matchingToolCount: options.matchingToolCount ?? tools.length,
    newlyExposedToolCount: options.newlyExposedToolCount ?? tools.length,
    tools,
    invocation: options.invocation ?? { attempted: true, completed: true, resultMatched: true },
    ...options.extra
  };
}

function isSymlinkPrivilegeError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "EPERM" || error.code === "EACCES");
}
