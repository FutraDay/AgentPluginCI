import { copyFile, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const outputRoot = await realpath(await mkdtemp(join(tmpdir(), "agentplugin-vscode-mcp-smoke-")));
const serverPath = join(outputRoot, "vscode-mcp-server.mjs");

await Promise.all([
  copyFile(join(sourceRoot, "plugin.json"), join(outputRoot, "plugin.json")),
  copyFile(join(sourceRoot, "vscode-mcp-server.mjs"), serverPath)
]);
await writeFile(join(outputRoot, "mcp.json"), `${JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    "phase3f-fixture": {
      type: "stdio",
      command: "node",
      args: [serverPath]
    }
  }
}, null, 2)}\n`, "utf8");

process.stdout.write(`${outputRoot}\n`);
