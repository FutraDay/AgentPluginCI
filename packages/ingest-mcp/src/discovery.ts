import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { JsonObject, McpServerDefinition } from "@agent-plugin-ci/plugin-ir";
import type { DiscoveredMcpTool, McpToolDiscoverer } from "./types.js";

export interface SdkMcpDiscoveryOptions {
  allowStdio?: boolean;
  allowPrivateNetwork?: boolean;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
}

export function createSdkMcpToolDiscoverer(options: SdkMcpDiscoveryOptions = {}): McpToolDiscoverer {
  return { discover: (server) => discoverWithSdk(server, options) };
}

async function discoverWithSdk(server: McpServerDefinition, options: SdkMcpDiscoveryOptions): Promise<DiscoveredMcpTool[]> {
  const client = new Client({ name: "agent-plugin-ci", version: "0.1.0" });
  const timeoutMs = options.timeoutMs ?? 10_000;
  const transport = await createTransport(server, options);
  try {
    await withTimeout(client.connect(transport), timeoutMs, `MCP connect timed out for ${server.name}`);
    const result = await withTimeout(client.listTools(), timeoutMs, `MCP tools/list timed out for ${server.name}`);
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema as JsonObject } : {})
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function createTransport(server: McpServerDefinition, options: SdkMcpDiscoveryOptions) {
  if (server.transport === "stdio") {
    if (!options.allowStdio) throw new Error(`Refusing to execute MCP stdio server ${server.name}; allowStdio must be explicitly enabled`);
    if (!server.command) throw new Error(`MCP stdio server ${server.name} has no command`);
    const env = resolveEnvironment(server.env);
    return new StdioClientTransport({ command: server.command, args: server.args, ...(env ? { env } : {}) });
  }

  if (!server.url) throw new Error(`MCP remote server ${server.name} has no URL`);
  await assertSafeRemoteUrl(server.url, options);
  const url = new URL(server.url);
  return server.transport === "sse" ? new SSEClientTransport(url) : new StreamableHTTPClientTransport(url);
}

async function assertSafeRemoteUrl(rawUrl: string, options: SdkMcpDiscoveryOptions): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol === "http:" && !options.allowInsecureHttp) throw new Error(`Refusing insecure HTTP MCP discovery for ${url.hostname}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MCP discovery URL must use HTTP(S)");
  if (options.allowPrivateNetwork) return;

  if (isPrivateHostName(url.hostname)) throw new Error(`Refusing private-network MCP discovery for ${url.hostname}`);
  if (isIP(url.hostname)) {
    if (isPrivateIp(url.hostname)) throw new Error(`Refusing private-network MCP discovery for ${url.hostname}`);
    return;
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error(`Refusing MCP discovery because ${url.hostname} resolves to a private or unavailable address`);
  }
}

function isPrivateHostName(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local");
}

function isPrivateIp(address: string): boolean {
  if (address.includes(":")) {
    const value = address.toLowerCase();
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value);
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function resolveEnvironment(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = process.env[key];
    if (value !== undefined) resolved[key] = value;
  }
  return Object.keys(resolved).length ? resolved : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
