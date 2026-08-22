import { validateHeaderName, validateHeaderValue } from "node:http";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import {
  MCP_JSON_SCHEMA,
  PLUGIN_JSON_SCHEMA
} from "@agent-plugin-ci/spec-agent-plugins-v1";

const MAX_VALIDATION_DEPTH = 64;
const MAX_VALIDATION_NODES = 50_000;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatePluginSchema = ajv.compile(PLUGIN_JSON_SCHEMA);
const validateMcpSchema = ajv.compile(MCP_JSON_SCHEMA);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateCompiledPlugin(manifest: unknown, mcp?: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const manifestLimitError = validateInputShape(manifest, "plugin.json");
  if (manifestLimitError) {
    errors.push(manifestLimitError);
  } else {
    validatePluginSchema(manifest);
    classifyPluginSchemaErrors(validatePluginSchema.errors ?? [], errors, warnings);
  }

  if (mcp !== undefined) {
    const mcpLimitError = validateInputShape(mcp, "mcp.json");
    if (mcpLimitError) {
      errors.push(mcpLimitError);
    } else {
      validateMcpSchema(mcp);
      for (const error of validateMcpSchema.errors ?? []) {
        errors.push(formatSchemaError("mcp.json", error));
      }
      validateMcpSemantics(mcp, errors);
    }
  }

  return {
    ok: errors.length === 0,
    errors: dedupe(errors),
    warnings: dedupe(warnings)
  };
}

function classifyPluginSchemaErrors(schemaErrors: ErrorObject[], errors: string[], warnings: string[]): void {
  for (const error of schemaErrors) {
    if (error.instancePath === "" && error.keyword === "additionalProperties") {
      const property = String((error.params as { additionalProperty?: unknown }).additionalProperty ?? "unknown");
      warnings.push(`plugin.json unknown top-level field: ${property}`);
      continue;
    }
    if (error.instancePath === "/extensions" && error.keyword === "type") {
      warnings.push("plugin.json extensions must be an object and will be ignored");
      continue;
    }
    errors.push(formatSchemaError("plugin.json", error));
  }
}

function formatSchemaError(file: string, error: ErrorObject): string {
  const location = error.instancePath ? `${file}${error.instancePath}` : file;
  if (error.keyword === "required") {
    const field = String((error.params as { missingProperty?: unknown }).missingProperty ?? "unknown");
    return `${location} missing required field: ${field}`;
  }
  if (error.keyword === "additionalProperties") {
    const field = String((error.params as { additionalProperty?: unknown }).additionalProperty ?? "unknown");
    return `${location} unknown field: ${field}`;
  }
  if (error.keyword === "const") {
    const expected = (error.params as { allowedValue?: unknown }).allowedValue;
    return `${location} must equal ${JSON.stringify(expected)}`;
  }
  if (error.keyword === "type") {
    const expected = String((error.params as { type?: unknown }).type ?? "the required type");
    return `${location} must be ${expected}`;
  }
  if (error.keyword === "minLength") return `${location} must not be empty`;
  if (error.keyword === "maxLength") {
    const limit = String((error.params as { limit?: unknown }).limit ?? "the schema limit");
    return `${location} must be at most ${limit} characters`;
  }
  if (error.keyword === "pattern") return `${location} does not match the Agent Plugins 1.0 pattern`;
  return `${location} ${error.message ?? `failed schema keyword ${error.keyword}`}`;
}

function validateMcpSemantics(value: unknown, errors: string[]): void {
  if (!isRecord(value) || !isRecord(value.mcpServers)) return;

  for (const [name, raw] of Object.entries(value.mcpServers)) {
    if (!isRecord(raw)) continue;

    if (raw.type === "stdio" && typeof raw.command === "string" && !isValidCommand(raw.command)) {
      errors.push(`MCP stdio server ${name} command must be a bare executable name or plugin-relative path beginning with ./`);
    }

    if (raw.type === "stdio" && typeof raw.cwd === "string" && !isLexicallyContainedCwd(raw.cwd)) {
      errors.push(`MCP stdio server ${name} cwd must remain within its declared plugin or plugin-data root`);
    }
    if ((raw.type === "streamable-http" || raw.type === "sse") && typeof raw.url === "string") {
      validateRemoteUrl(name, raw.url, errors);
      if (isRecord(raw.headers)) validateHeaders(name, raw.headers, errors);
    }
  }
}

function validateRemoteUrl(name: string, rawUrl: string, errors: string[]): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    errors.push(`MCP remote server ${name} requires an absolute HTTP(S) url`);
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    errors.push(`MCP remote server ${name} requires an absolute HTTP(S) url`);
    return;
  }
  if (url.username || url.password) errors.push(`MCP remote server ${name} url must not contain user information`);
  if (url.hash) errors.push(`MCP remote server ${name} url must not contain a fragment`);
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    errors.push(`MCP remote server ${name} must use HTTPS unless the endpoint is loopback`);
  }
}

function validateHeaders(name: string, headers: Record<string, unknown>, errors: string[]): void {
  const seen = new Set<string>();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const normalized = headerName.toLowerCase();
    if (seen.has(normalized)) {
      errors.push(`MCP remote server ${name} contains duplicate header name with different casing: ${headerName}`);
    }
    seen.add(normalized);

    try {
      validateHeaderName(headerName);
    } catch {
      errors.push(`MCP remote server ${name} contains invalid HTTP header name: ${headerName}`);
    }
    if (typeof headerValue === "string") {
      try {
        validateHeaderValue(headerName, headerValue);
      } catch {
        errors.push(`MCP remote server ${name} contains invalid HTTP header value for: ${headerName}`);
      }
    }
  }
}

function isValidCommand(command: string): boolean {
  if (!command) return false;
  if (command.startsWith("./")) return !command.includes("\\") && !escapesRelativeRoot(command);
  return !command.includes("/") && !command.includes("\\") && command !== "." && command !== "..";
}

function escapesRelativeRoot(path: string): boolean {
  let depth = 0;
  for (const segment of path.slice(2).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) return true;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return false;
}

function isLexicallyContainedCwd(cwd: string): boolean {
  if (cwd.includes("\\")) return false;
  if (cwd.startsWith("./")) return !escapesRelativeRoot(cwd);

  for (const root of ["${PLUGIN_ROOT}", "${PLUGIN_DATA}"]) {
    if (cwd === root) return true;
    if (cwd.startsWith(`${root}/`)) return !escapesAnchoredPath(cwd.slice(root.length + 1));
  }
  return false;
}

function escapesAnchoredPath(path: string): boolean {
  let depth = 0;
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) return true;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return false;
}
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

function validateInputShape(value: unknown, label: string): string | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;

  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_VALIDATION_NODES) return `${label} exceeds the validation node limit`;
    if (current.depth > MAX_VALIDATION_DEPTH) return `${label} exceeds the validation depth limit`;
    if (current.value === null || typeof current.value !== "object") continue;

    const objectValue = current.value as object;
    if (seen.has(objectValue)) return `${label} must be a JSON tree without cyclic or shared object references`;
    seen.add(objectValue);

    const children = Array.isArray(current.value) ? current.value : Object.values(current.value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
