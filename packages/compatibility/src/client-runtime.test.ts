import { describe, expect, it } from "vitest";
import {
  ClientRuntimeAdapterRegistry,
  KNOWN_CLIENT_RUNTIME_TARGETS,
  InvalidClientRuntimeAdapterError,
  UnknownClientRuntimeAdapterError,
  runClientRuntimeHarness,
  type ClientRuntimeAdapter
} from "./client-runtime.js";
import { createSyntheticFixtureClientAdapter } from "./client-runtime-fixture.js";

describe("client runtime harness", () => {
  it("validates adapters and provides deterministic registry lookup boundaries", () => {
    const zeta = adapter("zeta-adapter");
    const alpha = adapter("alpha-adapter");
    const registry = new ClientRuntimeAdapterRegistry([zeta, alpha]);
    expect(registry.list().map((item) => item.adapter.id)).toEqual(["alpha-adapter", "zeta-adapter"]);
    expect(registry.get("alpha-adapter")).toBe(alpha);
    expect(() => registry.get("cursor")).toThrow(UnknownClientRuntimeAdapterError);
    expect(() => new ClientRuntimeAdapterRegistry([alpha, alpha])).toThrow(InvalidClientRuntimeAdapterError);
    expect(() => new ClientRuntimeAdapterRegistry([{ metadata: {}, execute() {} } as unknown as ClientRuntimeAdapter]))
      .toThrow(InvalidClientRuntimeAdapterError);
    expect(() => new ClientRuntimeAdapterRegistry([adapter("unsafe-capability", {
      requiredCapabilities: ["arbitrary-shell" as never]
    })])).toThrow(InvalidClientRuntimeAdapterError);
    const sensitiveMetadata = adapter("sensitive-metadata");
    sensitiveMetadata.metadata.adapter.version = "sk-proj-fixtureSecret123";
    expect(() => new ClientRuntimeAdapterRegistry([sensitiveMetadata])).toThrow(InvalidClientRuntimeAdapterError);
    expect(KNOWN_CLIENT_RUNTIME_TARGETS).toEqual([
      { id: "cursor", name: "Cursor", adapterAvailable: false },
      { id: "vscode-github-copilot", name: "VS Code/GitHub Copilot", adapterAvailable: false }
    ]);
    expect(registry.list().some((item) => item.targetClient.id === "cursor" || item.targetClient.id === "vscode-github-copilot"))
      .toBe(false);
  });

  it("denies execution by default without invoking any adapter lifecycle method", async () => {
    const events: string[] = [];
    const fixture = createSyntheticFixtureClientAdapter({ onLifecycleEvent: (event) => events.push(event) });
    const report = await runClientRuntimeHarness("untrusted-package-label", fixture);
    expect(events).toEqual([]);
    expect(report).toMatchObject({
      synthetic: true,
      execution: { status: "denied", complete: false, finalize: "not-run" },
      packageInstall: "not-assessed",
      clientLoad: "not-assessed",
      interoperability: "not-established"
    });
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-POLICY-001");
  });

  it("rejects unsafe package labels before invoking the adapter", async () => {
    let invoked = false;
    const fixture = adapter("bounded-label-adapter", {
      execute: () => { invoked = true; return output(); }
    });
    await expect(runClientRuntimeHarness("package\nINJECTED", fixture, { allowExecution: true }))
      .rejects.toThrow("outside harness safety bounds");
    await expect(runClientRuntimeHarness("x".repeat(4_097), fixture, { allowExecution: true }))
      .rejects.toThrow("outside harness safety bounds");
    expect(invoked).toBe(false);
  });

  it("rejects stateful adapters without a callable finalizer", async () => {
    for (const capability of ["client-process", "client-filesystem"] as const) {
      const stateful = adapter(`missing-finalize-${capability}`, { requiredCapabilities: [capability] });
      expect(() => new ClientRuntimeAdapterRegistry([stateful])).toThrow(InvalidClientRuntimeAdapterError);
      await expect(runClientRuntimeHarness("package", stateful, {
        allowExecution: true,
        grantedCapabilities: [capability]
      })).rejects.toThrow(InvalidClientRuntimeAdapterError);
    }

    const nonCallable = adapter("non-callable-finalize", { requiredCapabilities: ["client-process"] });
    (nonCallable as unknown as { finalize: unknown }).finalize = "not-a-function";
    expect(() => new ClientRuntimeAdapterRegistry([nonCallable])).toThrow(InvalidClientRuntimeAdapterError);
  });

  it("registers and runs a stateful adapter with finalization when explicitly granted", async () => {
    const events: string[] = [];
    const stateful = adapter("stateful-adapter", {
      requiredCapabilities: ["client-process", "client-filesystem"],
      execute: () => { events.push("execute"); return output(); },
      finalize: (_context, status) => { events.push(`finalize:${status}`); }
    });
    const registry = new ClientRuntimeAdapterRegistry([stateful]);
    expect(registry.get("stateful-adapter")).toBe(stateful);

    const report = await runClientRuntimeHarness("package", stateful, {
      allowExecution: true,
      grantedCapabilities: ["client-process", "client-filesystem"]
    });
    expect(events).toEqual(["execute", "finalize:pass"]);
    expect(report.execution).toEqual({ status: "pass", complete: true, finalize: "complete" });
  });

  it("keeps package-read and network-only adapters valid without finalization", () => {
    expect(() => new ClientRuntimeAdapterRegistry([
      adapter("package-read-only", { requiredCapabilities: ["package-read"] }),
      adapter("network-only", { requiredCapabilities: ["network"] })
    ])).not.toThrow();
  });

  it("requires explicit grants for every declared capability", async () => {
    let invoked = false;
    const protectedAdapter = adapter("protected-adapter", {
      requiredCapabilities: ["client-process"],
      execute: () => { invoked = true; return output(); },
      finalize: () => {}
    });
    const report = await runClientRuntimeHarness("package", protectedAdapter, { allowExecution: true });
    expect(invoked).toBe(false);
    expect(report.execution).toEqual({ status: "denied", complete: false, finalize: "not-run" });
    expect(report.requestedCapabilities).toEqual(["client-process"]);

    let observedRoot: string | undefined;
    const packageReader = adapter("package-reader", {
      requiredCapabilities: ["package-read"],
      execute: (context) => { observedRoot = context.packageRoot; return output(); }
    });
    expect((await runClientRuntimeHarness("package-label", packageReader, {
      allowExecution: true,
      grantedCapabilities: ["package-read"]
    })).execution.status).toBe("pass");
    expect(observedRoot).toBe("package-label");

    const undeclared = await runClientRuntimeHarness("package", adapter("no-network"), {
      allowExecution: true,
      grantedCapabilities: ["network"]
    });
    expect(undeclared.execution.status).toBe("denied");
    expect(JSON.stringify(undeclared)).toContain("APCI-CLIENT-POLICY-003");
  });

  it("collects explicitly synthetic install/load observations without establishing interoperability", async () => {
    const events: string[] = [];
    const fixture = createSyntheticFixtureClientAdapter({
      onLifecycleEvent: (event, status) => events.push(status ? `${event}:${status}` : event)
    });
    const first = await runClientRuntimeHarness("package", fixture, { allowExecution: true });
    const second = await runClientRuntimeHarness("package", createSyntheticFixtureClientAdapter(), { allowExecution: true });
    expect(events).toEqual(["initialize", "execute", "finalize:pass"]);
    expect(first).toMatchObject({
      schemaVersion: "1.0.0",
      evidenceLevel: "client-runtime-observation",
      scope: "client-adapter-harness",
      synthetic: true,
      adapter: { id: "synthetic-fixture", version: "1.0.0-fixture" },
      targetClient: { id: "synthetic-fixture-client", version: "0.0.0-fixture" },
      execution: { status: "pass", complete: true, finalize: "complete" },
      packageInstall: "observed",
      clientLoad: "observed",
      interoperability: "not-established"
    });
    expect(first.note).toContain("does not establish interoperability with any real client");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("times out, aborts, and finalizes the fixture deterministically", async () => {
    const events: string[] = [];
    const fixture = createSyntheticFixtureClientAdapter({
      behavior: "timeout",
      onLifecycleEvent: (event, status) => events.push(status ? `${event}:${status}` : event)
    });
    const report = await runClientRuntimeHarness("package", fixture, { allowExecution: true, timeoutMs: 100 });
    expect(events).toEqual(["initialize", "execute", "finalize:timeout"]);
    expect(report).toMatchObject({
      execution: { status: "timeout", complete: false, finalize: "complete" },
      packageInstall: "unknown",
      clientLoad: "unknown",
      interoperability: "not-established"
    });
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-LIFECYCLE-002");
  });

  it("normalizes adapter exceptions without retaining secrets", async () => {
    const fixture = createSyntheticFixtureClientAdapter({ behavior: "throw" });
    const first = await runClientRuntimeHarness("package", fixture, { allowExecution: true });
    const second = await runClientRuntimeHarness("package", fixture, { allowExecution: true });
    expect(first.execution.status).toBe("fail");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).toContain("APCI-CLIENT-LIFECYCLE-001");
    expect(JSON.stringify(first)).not.toContain("fixture-super-secret-value");
  });

  it("redacts, bounds, sanitizes, and deterministically orders untrusted evidence", async () => {
    const unsafe = await runClientRuntimeHarness(
      "package",
      createSyntheticFixtureClientAdapter({ behavior: "unsafe-evidence" }),
      { allowExecution: true }
    );
    const serialized = JSON.stringify(unsafe);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("\\\\u000aINJECTED");
    expect(serialized).toContain("...[truncated]");
    expect(serialized).not.toContain("fixture-super-secret-value");
    expect(unsafe.evidence.every((item) => item.location.length <= 240 && item.summary.length <= 240)).toBe(true);

    const unsortedAdapter = adapter("order-adapter", {
      execute: () => output([
        { code: "APCI-CLIENT-TEST-002", location: "z", summary: "second" },
        { code: "APCI-CLIENT-TEST-001", location: "a", summary: "first" }
      ])
    });
    const report = await runClientRuntimeHarness("package", unsortedAdapter, { allowExecution: true });
    expect(report.evidence.map((item) => item.code)).toEqual(["APCI-CLIENT-TEST-001", "APCI-CLIENT-TEST-002"]);

    const manyEvidence = adapter("bounded-adapter", {
      execute: () => output(Array.from({ length: 12 }, (_, index) => ({
        code: `APCI-CLIENT-BOUND-${String(index).padStart(3, "0")}`,
        location: "test",
        summary: `item ${index}`
      })))
    });
    const bounded = await runClientRuntimeHarness("package", manyEvidence, { allowExecution: true });
    expect(bounded.evidence).toHaveLength(8);
    expect(bounded.evidence.some((item) => item.code === "APCI-CLIENT-REPORT-001")).toBe(true);
  });

  it("fails closed for malformed adapter output", async () => {
    const fixture = createSyntheticFixtureClientAdapter({ behavior: "malformed-output" });
    const report = await runClientRuntimeHarness("package", fixture, { allowExecution: true });
    expect(report).toMatchObject({
      execution: { status: "unknown", complete: false, finalize: "complete" },
      packageInstall: "unknown",
      clientLoad: "unknown",
      interoperability: "not-established"
    });
    expect(JSON.stringify(report)).toContain("APCI-CLIENT-OUTPUT-001");

    const unsafeEvidence = adapter("unsafe-output-adapter", {
      execute: () => output([{ code: "bad\ncode", location: "test", summary: "unsafe" }])
    });
    const unsafeReport = await runClientRuntimeHarness("package", unsafeEvidence, { allowExecution: true });
    expect(unsafeReport.execution.status).toBe("unknown");
    expect(JSON.stringify(unsafeReport)).toContain("APCI-CLIENT-OUTPUT-001");
    expect(JSON.stringify(unsafeReport)).not.toContain("bad\\ncode");

    const sensitiveVersion = adapter("sensitive-version-output", {
      execute: () => ({ ...output(), targetClientVersion: "sk-proj-fixtureSecret123" })
    });
    const sensitiveVersionReport = await runClientRuntimeHarness("package", sensitiveVersion, { allowExecution: true });
    expect(sensitiveVersionReport.execution.status).toBe("unknown");
    expect(JSON.stringify(sensitiveVersionReport)).not.toContain("fixtureSecret123");
  });

  it("does not accept synthetic or incomplete interoperability claims", async () => {
    const synthetic = await runClientRuntimeHarness("package", createSyntheticFixtureClientAdapter(), { allowExecution: true });
    expect(synthetic.interoperability).toBe("not-established");
    const incomplete = adapter("future-incomplete-adapter", {
      synthetic: false,
      execute: () => ({ ...output(), complete: false })
    });
    expect((await runClientRuntimeHarness("package", incomplete, { allowExecution: true })).interoperability)
      .toBe("not-established");
  });
});

function adapter(
  id: string,
  overrides: {
    synthetic?: boolean;
    requiredCapabilities?: ClientRuntimeAdapter["metadata"]["requiredCapabilities"];
    execute?: ClientRuntimeAdapter["execute"];
    finalize?: ClientRuntimeAdapter["finalize"];
  } = {}
): ClientRuntimeAdapter {
  return {
    metadata: {
      adapter: { id, version: "1.0.0" },
      targetClient: { id: `${id}-client`, name: `${id} client`, version: "1.0.0" },
      synthetic: overrides.synthetic ?? true,
      requiredCapabilities: overrides.requiredCapabilities ?? []
    },
    execute: overrides.execute ?? (() => output()),
    ...(overrides.finalize ? { finalize: overrides.finalize } : {})
  };
}

function output(evidence = [{ code: "APCI-CLIENT-TEST-001", location: "test", summary: "bounded evidence" }]) {
  return {
    status: "pass",
    complete: true,
    packageInstall: "observed",
    clientLoad: "observed",
    interoperability: "established",
    evidence
  } as const;
}
