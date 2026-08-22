import type { McpServerDefinition, McpTransport } from "@agent-plugin-ci/plugin-ir";
import type { IngestionWarning, NormalizedMcpConfig } from "./types.js";

const MAX_SERVERS = 50;
const MAX_ARGS = 100;
const MAX_ENV = 100;
const MAX_STRING = 4096;

export function normalizeMcpConfig(input: unknown): NormalizedMcpConfig {
  const root = asRecord(input, "MCP configuration must be a JSON object");
  const rawServers = asRecord(root.mcpServers, "MCP configuration requires an mcpServers object");
  const entries = Object.entries(rawServers);
  if (entries.length === 0) throw new Error("MCP configuration must contain at least one server");
  if (entries.length > MAX_SERVERS) throw new Error(`MCP configuration exceeds ${MAX_SERVERS} servers`);

  const warnings: IngestionWarning[] = [];
  const servers = entries.map(([name, raw]) => normalizeServer(name, raw, warnings));
  return { servers, warnings };
}

export function mcpConfigFromUrl(url: string, name = "mcp-server"): unknown {
  return { mcpServers: { [name]: { type: "streamable-http", url } } };
}

function normalizeServer(name: string, raw: unknown, warnings: IngestionWarning[]): McpServerDefinition {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error("MCP server names must use only letters, numbers, dot, underscore, or hyphen");
  const value = asRecord(raw, `MCP server ${name} must be an object`);
  const hasCommand = typeof value.command === "string";
  const hasUrl = typeof value.url === "string";
  if (hasCommand === hasUrl) throw new Error(`MCP server ${name} must define exactly one of command or url`);

  const transport = normalizeTransport(value.type, hasCommand);
  if (transport === "stdio" && !hasCommand) throw new Error(`MCP stdio server ${name} requires command`);
  if (transport !== "stdio" && !hasUrl) throw new Error(`MCP remote server ${name} requires url`);

  if (transport === "stdio") return normalizeStdio(name, value, warnings);
  return normalizeRemote(name, transport, value);
}

function normalizeTransport(raw: unknown, hasCommand: boolean): McpTransport {
  if (raw === undefined) return hasCommand ? "stdio" : "streamable-http";
  if (raw === "stdio") return "stdio";
  if (raw === "streamable-http" || raw === "http") return "streamable-http";
  if (raw === "sse") return "sse";
  throw new Error(`Unsupported MCP transport: ${String(raw)}`);
}

function normalizeStdio(name: string, value: Record<string, unknown>, warnings: IngestionWarning[]): McpServerDefinition {
  const command = boundedString(value.command, `MCP stdio server ${name} command`, 1024);
  const args = value.args === undefined ? undefined : stringArray(value.args, `MCP stdio server ${name} args`, MAX_ARGS);
  const env = value.env === undefined ? undefined : normalizeEnv(name, value.env, warnings);
  return { name, transport: "stdio", command, ...(args?.length ? { args } : {}), ...(env ? { env } : {}) };
}

function normalizeRemote(name: string, transport: "streamable-http" | "sse", value: Record<string, unknown>): McpServerDefinition {
  const rawUrl = boundedString(value.url, `MCP remote server ${name} url`, 2048);
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error(`MCP remote server ${name} requires an absolute URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`MCP remote server ${name} URL must use HTTP(S)`);
  if (url.username || url.password) throw new Error(`MCP remote server ${name} URL must not contain credentials`);
  if (url.hash) throw new Error(`MCP remote server ${name} URL must not contain a fragment`);
  return { name, transport, url: url.toString() };
}

function normalizeEnv(name: string, raw: unknown, warnings: IngestionWarning[]): Record<string, string> {
  const value = asRecord(raw, `MCP stdio server ${name} env must be an object`);
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV) throw new Error(`MCP stdio server ${name} exceeds ${MAX_ENV} environment variables`);
  const result: Record<string, string> = {};
  for (const [key, envValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`MCP stdio server ${name} has invalid environment variable name: ${key}`);
    boundedString(envValue, `MCP stdio server ${name} env ${key}`, MAX_STRING);
    result[key] = `\${${key}}`;
    if (envValue !== result[key]) warnings.push({ code: "ENV_VALUE_REDACTED", message: `Environment value for ${key} was replaced with a variable placeholder`, server: name });
  }
  return result;
}

function stringArray(raw: unknown, label: string, max: number): string[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array`);
  if (raw.length > max) throw new Error(`${label} exceeds ${max} entries`);
  return raw.map((value, index) => boundedString(value, `${label}[${index}]`, MAX_STRING));
}

function boundedString(raw: unknown, label: string, max: number): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} must be a non-empty string`);
  if (raw.length > max) throw new Error(`${label} exceeds ${max} characters`);
  if (/\0/.test(raw)) throw new Error(`${label} contains a NUL character`);
  return raw;
}

function asRecord(raw: unknown, message: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(message);
  return raw as Record<string, unknown>;
}
