import type {
  ClientRuntimeAdapter,
  ClientRuntimeAdapterContext,
  ClientRuntimeAdapterOutput,
  ClientRuntimeExecutionStatus
} from "./client-runtime.js";

export const SYNTHETIC_FIXTURE_CLIENT_ADAPTER_ID = "synthetic-fixture";

export type SyntheticFixtureBehavior = "success" | "timeout" | "throw" | "unsafe-evidence" | "malformed-output";
export type SyntheticFixtureLifecycleEvent = "initialize" | "execute" | "finalize";

export interface SyntheticFixtureClientAdapterOptions {
  behavior?: SyntheticFixtureBehavior;
  onLifecycleEvent?: (event: SyntheticFixtureLifecycleEvent, status?: ClientRuntimeExecutionStatus) => void;
}

/** Test-only adapter. It never launches a process, reads the package, or contacts a client. */
export function createSyntheticFixtureClientAdapter(
  options: SyntheticFixtureClientAdapterOptions = {}
): ClientRuntimeAdapter {
  const behavior = options.behavior ?? "success";
  return {
    metadata: {
      adapter: { id: SYNTHETIC_FIXTURE_CLIENT_ADAPTER_ID, version: "1.0.0-fixture" },
      targetClient: { id: "synthetic-fixture-client", name: "Synthetic Fixture Client", version: "0.0.0-fixture" },
      synthetic: true,
      requiredCapabilities: []
    },
    initialize() {
      options.onLifecycleEvent?.("initialize");
    },
    async execute(context: ClientRuntimeAdapterContext): Promise<unknown> {
      options.onLifecycleEvent?.("execute");
      if (behavior === "timeout") {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("fixture aborted")), { once: true });
        });
      }
      if (behavior === "throw") throw new Error("token=fixture-super-secret-value");
      if (behavior === "malformed-output") return { status: "pass", complete: "yes" };
      if (behavior === "unsafe-evidence") {
        return successOutput([
          {
            code: "APCI-CLIENT-FIXTURE-UNSAFE-001",
            location: "fixture\nINJECTED",
            summary: "token=fixture-super-secret-value"
          },
          {
            code: "APCI-CLIENT-FIXTURE-UNSAFE-002",
            location: "synthetic-fixture/bounds",
            summary: "x".repeat(1_000)
          }
        ]);
      }
      return successOutput([
        {
          code: "APCI-CLIENT-FIXTURE-INSTALL-001",
          location: "synthetic-fixture/install",
          summary: "Synthetic fixture emitted a package install observation; no real package was installed."
        },
        {
          code: "APCI-CLIENT-FIXTURE-LOAD-001",
          location: "synthetic-fixture/load",
          summary: "Synthetic fixture emitted a client load observation; no real client was launched."
        }
      ]);
    },
    finalize(_context, status) {
      options.onLifecycleEvent?.("finalize", status);
    }
  };
}

function successOutput(evidence: ClientRuntimeAdapterOutput["evidence"]): ClientRuntimeAdapterOutput {
  return {
    status: "pass",
    complete: true,
    packageInstall: "observed",
    clientLoad: "observed",
    mcpStartup: "not-assessed",
    mcpHandshake: "not-assessed",
    toolExposure: "not-assessed",
    toolInvocation: "not-assessed",
    interoperability: "not-established",
    targetClientVersion: "0.0.0-fixture",
    evidence
  };
}
