import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import type { LoadedOpenApiDocument, OpenApiLoadOptions } from "./types.js";

const DEFAULT_MAX_DOCUMENT_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_PARSE_DEPTH = 64;
const MAX_PARSE_NODES = 100_000;

export async function loadOpenApiSource(source: string, options: OpenApiLoadOptions = {}): Promise<LoadedOpenApiDocument> {
  if (/^https?:\/\//i.test(source)) return loadRemote(source, options);
  return loadFile(source, options);
}

export function parseOpenApiText(text: string, source = "OpenAPI document"): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const document = parseDocument(text, { strict: true, uniqueKeys: true, prettyErrors: true });
    if (document.errors.length) throw new Error(`${source} is not valid JSON or YAML: ${document.errors[0]!.message}`);
    parsed = document.toJS({ maxAliasCount: 50 });
  }
  return sanitizeParsedValue(parsed, source);
}

async function loadFile(source: string, options: OpenApiLoadOptions): Promise<LoadedOpenApiDocument> {
  const path = resolve(source);
  const info = await stat(path);
  const maxBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  if (!info.isFile()) throw new Error(`OpenAPI source is not a file: ${path}`);
  if (info.size > maxBytes) throw new Error(`OpenAPI document exceeds ${maxBytes} bytes`);
  const text = await readFile(path, "utf8");
  return { document: parseOpenApiText(text, path), source: path, sourceType: "file" };
}

async function loadRemote(source: string, options: OpenApiLoadOptions): Promise<LoadedOpenApiDocument> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = new URL(source);
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    await assertSafeRemoteUrl(current, options);
    const response = await fetchWithTimeout(current, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`OpenAPI URL redirect from ${current.hostname} is missing Location`);
      if (redirects === maxRedirects) throw new Error(`OpenAPI URL exceeds ${maxRedirects} redirects`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`OpenAPI URL returned HTTP ${response.status}`);
    const text = await readBoundedResponse(response, options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES);
    return { document: parseOpenApiText(text, current.toString()), source: current.toString(), sourceType: "url" };
  }
  throw new Error("OpenAPI URL redirect handling failed");
}

async function fetchWithTimeout(url: URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: "manual", signal: controller.signal, headers: { accept: "application/json, application/yaml, text/yaml, text/plain, */*" } });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`OpenAPI fetch timed out for ${url.hostname}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new Error(`OpenAPI document exceeds ${maxBytes} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`OpenAPI document exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function assertSafeRemoteUrl(url: URL, options: OpenApiLoadOptions = {}): Promise<void> {
  if (url.protocol === "http:" && !options.allowInsecureHttp) throw new Error(`Refusing insecure HTTP OpenAPI fetch for ${url.hostname}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OpenAPI URL must use HTTP(S)");
  if (url.username || url.password) throw new Error("OpenAPI URL must not contain credentials");
  if (url.hash) throw new Error("OpenAPI fetch URL must not contain a fragment");
  if (options.allowPrivateNetwork) return;
  if (isPrivateHostName(url.hostname)) throw new Error(`Refusing private-network OpenAPI fetch for ${url.hostname}`);
  if (isIP(url.hostname)) {
    if (isPrivateIp(url.hostname)) throw new Error(`Refusing private-network OpenAPI fetch for ${url.hostname}`);
    return;
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error(`Refusing OpenAPI fetch because ${url.hostname} resolves to a private or unavailable address`);
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

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function sanitizeParsedValue(value: unknown, source: string): unknown {
  const state = { nodes: 0 };
  return sanitizeNode(value, source, 0, state);
}

function sanitizeNode(value: unknown, source: string, depth: number, state: { nodes: number }): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_PARSE_NODES) throw new Error(`${source} exceeds ${MAX_PARSE_NODES} parsed nodes`);
  if (depth > MAX_PARSE_DEPTH) throw new Error(`${source} exceeds maximum nesting depth ${MAX_PARSE_DEPTH}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${source} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeNode(item, source, depth + 1, state));
  if (!value || typeof value !== "object") throw new Error(`${source} contains a non-JSON value`);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`${source} contains unsafe key: ${key}`);
    result[key] = sanitizeNode(child, source, depth + 1, state);
  }
  return result;
}
