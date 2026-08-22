import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePlugin } from "@agent-plugin-ci/compiler";
import { createSdkMcpToolDiscoverer, ingestMcpConfig, mcpConfigFromUrl } from "@agent-plugin-ci/ingest-mcp";
import type { PluginIR } from "@agent-plugin-ci/plugin-ir";
import { validateCompiledPlugin } from "@agent-plugin-ci/validator";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const invocationRoot = resolve(process.env.INIT_CWD ?? process.cwd());
process.chdir(invocationRoot);
const args = process.argv.slice(2);
const mcpIndex = args.indexOf("--mcp");

let ir: PluginIR;
let outDir: string;

if (mcpIndex >= 0) {
  const source = args[mcpIndex + 1];
  if (!source || source.startsWith("--")) throw new Error("--mcp requires a configuration path or MCP URL");
  const pluginName = optionValue(args, "--name");
  const out = optionValue(args, "--out");
  const discover = !args.includes("--no-discover");
  const config = /^https?:\/\//i.test(source) ? mcpConfigFromUrl(source, deriveServerName(source)) : await readMcpConfig(source);
  const discoverer = discover ? createSdkMcpToolDiscoverer({
    allowStdio: args.includes("--allow-stdio-discovery"),
    allowPrivateNetwork: args.includes("--allow-private-network"),
    allowInsecureHttp: args.includes("--allow-insecure-http")
  }) : undefined;
  const result = await ingestMcpConfig(config, { pluginName, discoverer });
  ir = result.ir;
  outDir = resolve(out ?? join(repoRoot, "dist", ir.identity.name));
  for (const warning of result.warnings) console.warn(`WARNING ${warning.code}${warning.server ? ` [${warning.server}]` : ""}: ${warning.message}`);
} else {
  const inputPath = resolve(args[0] ?? join(repoRoot, "fixtures/hello/plugin-ir.json"));
  outDir = resolve(args[1] ?? join(repoRoot, "dist/hello-plugin"));
  ir = JSON.parse(await readFile(inputPath, "utf8")) as PluginIR;
}

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

async function readMcpConfig(path: string): Promise<unknown> {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (info.size > 1_000_000) throw new Error("MCP configuration exceeds 1 MB safety limit");
  return JSON.parse(await readFile(absolute, "utf8")) as unknown;
}

function optionValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function deriveServerName(source: string): string {
  try {
    const host = new URL(source).hostname.replace(/^www\./, "");
    return host.split(".")[0] || "mcp-server";
  } catch {
    return "mcp-server";
  }
}
