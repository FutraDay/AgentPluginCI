import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const TOOL_NAME = "phase3f_fixture_echo";
const TOOL_RESULT = "agent-plugin-ci:phase3g-tool-invocation-ok:v1";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

for await (const line of input) {
  if (line.length === 0 || line.length > 1_000_000) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (!request || typeof request !== "object" || request.id === undefined) continue;
  if (request.method === "initialize") {
    const requestedProtocol = typeof request.params?.protocolVersion === "string"
      && request.params.protocolVersion.length <= 32
      ? request.params.protocolVersion
      : "2025-11-25";
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: requestedProtocol,
        capabilities: { tools: {} },
        serverInfo: { name: "agent-plugin-ci-phase3f-fixture", version: "1.0.0" }
      }
    });
    continue;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [{
          name: TOOL_NAME,
          description: "Return deterministic Phase 3G tool invocation evidence.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, openWorldHint: false }
        }]
      }
    });
    continue;
  }
  if (request.method === "tools/call") {
    const argumentsValue = request.params?.arguments;
    if (request.params?.name !== TOOL_NAME
      || !argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)
      || Object.keys(argumentsValue).length !== 0) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: "Invalid deterministic fixture invocation" }
      });
      continue;
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: TOOL_RESULT }]
      }
    });
    continue;
  }
  send({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: "Method not found" }
  });
}
