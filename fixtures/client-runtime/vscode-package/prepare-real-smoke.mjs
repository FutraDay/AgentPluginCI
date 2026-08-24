import { copyFile, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const outputRoot = await realpath(await mkdtemp(join(tmpdir(), "agentplugin-vscode-mcp-smoke-")));

await Promise.all([
  copyFile(join(sourceRoot, "plugin.json"), join(outputRoot, "plugin.json")),
  copyFile(join(sourceRoot, "mcp.json"), join(outputRoot, "mcp.json")),
  copyFile(join(sourceRoot, "vscode-mcp-server.mjs"), join(outputRoot, "vscode-mcp-server.mjs"))
]);

process.stdout.write(`${outputRoot}\n`);
