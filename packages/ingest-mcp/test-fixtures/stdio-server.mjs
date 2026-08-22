import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({
  name: "agent-plugin-ci-test-server",
  version: "1.0.0"
});

server.registerTool(
  "echo_message",
  { description: "Echo a message" },
  async () => ({ content: [{ type: "text", text: "ok" }] })
);

await server.connect(new StdioServerTransport());
