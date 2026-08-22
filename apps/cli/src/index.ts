import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePlugin } from "@agent-plugin-ci/compiler";
import type { PluginIR } from "@agent-plugin-ci/plugin-ir";
import { validateCompiledPlugin } from "@agent-plugin-ci/validator";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const inputPath = resolve(process.argv[2] ?? join(repoRoot, "fixtures/hello/plugin-ir.json"));
const outDir = resolve(process.argv[3] ?? join(repoRoot, "dist/hello-plugin"));
const ir = JSON.parse(await readFile(inputPath, "utf8")) as PluginIR;
const compiled = compilePlugin(ir);
const result = validateCompiledPlugin(compiled.manifest, compiled.mcp);

if (!result.ok) {
  console.error("VALIDATION_FAILED");
  for (const error of result.errors) console.error(`- ${error}`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "plugin.json"), JSON.stringify(compiled.manifest, null, 2) + "\n");
if (compiled.mcp) await writeFile(join(outDir, "mcp.json"), JSON.stringify(compiled.mcp, null, 2) + "\n");

for (const [name, content] of Object.entries(compiled.skills)) {
  const skillPath = join(outDir, "skills", name, "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, content);
}

console.log(`BUILD_OK ${outDir}`);
console.log(`PLUGIN ${String(compiled.manifest.name)}`);
console.log(`SKILLS ${Object.keys(compiled.skills).length}`);
console.log(`MCP_SERVERS ${ir.mcpServers.length}`);
console.log("AGENT_PLUGINS_1_0_VALIDATION_PASS");
