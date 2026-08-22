import type {
  CapabilityDefinition,
  CapabilityParameterDefinition,
  CapabilityRequestBodyDefinition,
  JsonObject,
  PluginIdentity,
  SkillDefinition
} from "@agent-plugin-ci/plugin-ir";
import { parseOpenApiText, loadOpenApiSource } from "./loader.js";
import { OpenApiRefResolver } from "./refs.js";
import type { IngestOpenApiOptions, IngestOpenApiResult, LoadedOpenApiDocument, OpenApiIngestionWarning } from "./types.js";

const FIXED_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"] as const;
const MAX_OPERATIONS = 1000;
const MAX_PARAMETERS_PER_OPERATION = 200;
const MAX_CONTENT_TYPES = 50;
const MAX_SCHEMA_BYTES = 100_000;
const MAX_SCHEMA_DEPTH = 20;
const HTTP_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export async function ingestOpenApiSource(source: string, options: IngestOpenApiOptions = {}): Promise<IngestOpenApiResult> {
  const loaded = await loadOpenApiSource(source, options);
  return ingestLoadedDocument(loaded, options);
}

export async function ingestOpenApiDocument(input: unknown, options: IngestOpenApiOptions = {}): Promise<IngestOpenApiResult> {
  let serialized: string;
  try {
    const value = JSON.stringify(input);
    if (value === undefined) throw new Error("value is not JSON-serializable");
    serialized = value;
  } catch (error) {
    throw new Error(`In-memory OpenAPI document is not JSON-serializable: ${errorMessage(error)}`);
  }
  const maxBytes = options.maxDocumentBytes ?? 2_000_000;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error(`OpenAPI document exceeds ${maxBytes} bytes`);
  const loaded: LoadedOpenApiDocument = { document: parseOpenApiText(serialized, "in-memory OpenAPI document"), source: "memory://openapi", sourceType: "memory" };
  return ingestLoadedDocument(loaded, options);
}

async function ingestLoadedDocument(loaded: LoadedOpenApiDocument, options: IngestOpenApiOptions): Promise<IngestOpenApiResult> {
  const root = asRecord(loaded.document, "OpenAPI document must be an object");
  const version = boundedString(root.openapi, "OpenAPI version", 64);
  if (!/^3\.(0|1|2)\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Unsupported OpenAPI version ${version}; supported published 3.x feature sets are 3.0, 3.1, and 3.2`);
  }
  const info = asRecord(root.info, "OpenAPI document requires an info object");
  const title = cleanText(boundedString(info.title, "OpenAPI info.title", 256), 256);
  const sourceVersion = cleanText(boundedString(info.version, "OpenAPI info.version", 128), 128);
  const warnings: OpenApiIngestionWarning[] = [];
  const identity = normalizeIdentity(root, info, title, sourceVersion, options, warnings);
  const paths = asRecord(root.paths, "OpenAPI ingestion requires a paths object");
  const resolver = new OpenApiRefResolver(loaded, options);
  const capabilities: CapabilityDefinition[] = [];
  const skills: SkillDefinition[] = [];
  const usedSkillNames = new Set<string>();
  const apiName = cleanText(title, 128);

  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (!path.startsWith("/")) continue;
    if (path.length > 2048) throw new Error("OpenAPI path exceeds 2048 characters");
    const resolvedPath = await resolver.resolveRecord(rawPathItem);
    const pathItem = resolvedPath.record;
    const operationEntries = operationEntriesForPath(pathItem, version);
    for (const [method, rawOperation] of operationEntries) {
      if (capabilities.length >= MAX_OPERATIONS) throw new Error(`OpenAPI document exceeds ${MAX_OPERATIONS} operations`);
      const operation = asRecord(rawOperation, `OpenAPI operation ${method} ${path} must be an object`);
      const normalized = await normalizeOperation({
        apiName, method, path, operation, pathItem, root, version,
        context: resolvedPath.context, resolver, warnings, usedSkillNames
      });
      capabilities.push(normalized.capability);
      skills.push(normalized.skill);
    }
  }
  if (capabilities.length === 0) throw new Error("OpenAPI document contains no supported operations");

  return { ir: { identity, skills, mcpServers: [], capabilities }, warnings };
}

function operationEntriesForPath(pathItem: Record<string, unknown>, version: string): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const method of FIXED_METHODS) {
    if (method === "query" && !version.startsWith("3.2.")) continue;
    if (pathItem[method] !== undefined) entries.push([method.toUpperCase(), pathItem[method]]);
  }
  if (version.startsWith("3.2.") && pathItem.additionalOperations !== undefined) {
    const additional = asRecord(pathItem.additionalOperations, "OpenAPI 3.2 additionalOperations must be an object");
    for (const [method, operation] of Object.entries(additional)) {
      if (!HTTP_TOKEN_RE.test(method) || method.length > 32) throw new Error(`OpenAPI additional operation has invalid HTTP method: ${method}`);
      if (FIXED_METHODS.some((fixed) => fixed.toUpperCase() === method.toUpperCase())) throw new Error(`OpenAPI additionalOperations duplicates fixed method ${method}`);
      entries.push([method, operation]);
    }
  }
  return entries;
}

interface NormalizeOperationInput {
  apiName: string;
  method: string;
  path: string;
  operation: Record<string, unknown>;
  pathItem: Record<string, unknown>;
  root: Record<string, unknown>;
  version: string;
  context: LoadedOpenApiDocument;
  resolver: OpenApiRefResolver;
  warnings: OpenApiIngestionWarning[];
  usedSkillNames: Set<string>;
}

async function normalizeOperation(input: NormalizeOperationInput): Promise<{ capability: CapabilityDefinition; skill: SkillDefinition }> {
  const { apiName, method, path, operation, pathItem, root, version, context, resolver, warnings, usedSkillNames } = input;
  const operationKey = `${method} ${path}`;
  const operationId = optionalCleanText(operation.operationId, 128, `OpenAPI ${operationKey} operationId`);
  const summary = optionalCleanText(operation.summary, 500, `OpenAPI ${operationKey} summary`);
  const description = optionalCleanText(operation.description, 1000, `OpenAPI ${operationKey} description`);
  const parameters = await normalizeParameters(pathItem.parameters, operation.parameters, resolver, context, warnings, operationKey, version);
  const requestBody = operation.requestBody === undefined ? undefined : await normalizeRequestBody(operation.requestBody, resolver, context, operationKey);
  const baseUrl = normalizeServerUrl(operation.servers ?? pathItem.servers ?? root.servers, warnings, operationKey, context);
  const name = operationId ?? `${method} ${path}`;
  const source = {
    type: "openapi" as const,
    api: apiName,
    method,
    path,
    ...(operationId ? { operationId } : {}),
    ...(baseUrl ? { baseUrl } : {})
  };
  const capability: CapabilityDefinition = {
    id: `openapi:${method}:${path}`,
    kind: "http-operation",
    name,
    description: summary ?? description ?? `${method} ${path}`,
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    source
  };
  return { capability, skill: makeSkill(capability, usedSkillNames) };
}

function normalizeIdentity(
  root: Record<string, unknown>, info: Record<string, unknown>, title: string, sourceVersion: string,
  options: IngestOpenApiOptions, warnings: OpenApiIngestionWarning[]
): PluginIdentity {
  const name = normalizePluginName(options.pluginName ?? title);
  const description = options.description !== undefined
    ? cleanText(boundedString(options.description, "plugin description", 1000), 1000)
    : optionalCleanText(info.description, 1000, "OpenAPI info.description");
  const version = options.pluginVersion !== undefined
    ? cleanText(boundedString(options.pluginVersion, "plugin version", 128), 128)
    : sourceVersion;
  const contact = isRecord(info.contact) ? info.contact : undefined;
  const license = isRecord(info.license) ? info.license : undefined;
  const externalDocs = isRecord(root.externalDocs) ? root.externalDocs : undefined;
  const authorName = contact && typeof contact.name === "string" ? cleanText(contact.name, 256) : undefined;
  const homepageCandidate = externalDocs?.url ?? contact?.url;
  const homepage = typeof homepageCandidate === "string" ? normalizeMetadataUrl(homepageCandidate, warnings, "homepage") : undefined;
  const licenseText = license && typeof license.identifier === "string"
    ? cleanText(license.identifier, 128)
    : license && typeof license.name === "string" ? cleanText(license.name, 128) : undefined;
  const keywords = normalizeTags(root.tags);
  return {
    name,
    version,
    ...(description ? { description } : {}),
    ...(authorName ? { authorName } : {}),
    ...(homepage ? { homepage } : {}),
    ...(licenseText ? { license: licenseText } : {}),
    ...(keywords.length ? { keywords } : {})
  };
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const name = cleanText(item.name, 64);
    if (name && !result.includes(name)) result.push(name);
  }
  return result;
}

async function normalizeParameters(
  pathRaw: unknown, operationRaw: unknown, resolver: OpenApiRefResolver, context: LoadedOpenApiDocument,
  warnings: OpenApiIngestionWarning[], operationKey: string, version: string
): Promise<CapabilityParameterDefinition[]> {
  const merged = new Map<string, CapabilityParameterDefinition>();
  for (const rawList of [pathRaw, operationRaw]) {
    if (rawList === undefined) continue;
    if (!Array.isArray(rawList)) throw new Error(`OpenAPI ${operationKey} parameters must be an array`);
    for (const rawParameter of rawList) {
      const resolved = await resolver.resolveRecord(rawParameter, context);
      const parameter = await normalizeParameter(resolved.record, resolved.context, resolver, warnings, operationKey, version);
      if (!parameter) continue;
      const key = `${parameter.in}:${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`;
      merged.set(key, parameter);
      if (merged.size > MAX_PARAMETERS_PER_OPERATION) throw new Error(`OpenAPI ${operationKey} exceeds ${MAX_PARAMETERS_PER_OPERATION} parameters`);
    }
  }
  const parameters = [...merged.values()];
  const querystring = parameters.filter((parameter) => parameter.in === "querystring");
  if (querystring.length > 1) throw new Error(`OpenAPI ${operationKey} cannot define more than one querystring parameter`);
  if (querystring.length && parameters.some((parameter) => parameter.in === "query")) {
    throw new Error(`OpenAPI ${operationKey} cannot mix query and querystring parameters`);
  }
  return parameters;
}

async function normalizeParameter(
  raw: Record<string, unknown>, context: LoadedOpenApiDocument, resolver: OpenApiRefResolver,
  warnings: OpenApiIngestionWarning[], operationKey: string, version: string
): Promise<CapabilityParameterDefinition | undefined> {
  const name = cleanText(boundedString(raw.name, `OpenAPI ${operationKey} parameter name`, 128), 128);
  const location = boundedString(raw.in, `OpenAPI ${operationKey} parameter location`, 32);
  if (!isParameterLocation(location)) throw new Error(`OpenAPI ${operationKey} has unsupported parameter location ${location}`);
  if (location === "querystring") {
    if (!version.startsWith("3.2.")) throw new Error(`OpenAPI ${operationKey} querystring parameters require OpenAPI 3.2`);
    if (raw.content === undefined || raw.schema !== undefined) throw new Error(`OpenAPI ${operationKey} querystring parameter ${name} must use content, not schema`);
  }
  if (location === "header" && /^(accept|content-type|authorization)$/i.test(name)) {
    warnings.push({ code: "IGNORED_RESERVED_HEADER", message: `Ignored reserved header parameter ${name}`, operation: operationKey });
    return undefined;
  }
  let required = raw.required === true;
  if (location === "path" && !required) {
    required = true;
    warnings.push({ code: "PATH_PARAMETER_FORCED_REQUIRED", message: `Path parameter ${name} was normalized to required`, operation: operationKey });
  }
  if (raw.schema !== undefined && raw.content !== undefined) throw new Error(`OpenAPI ${operationKey} parameter ${name} cannot define both schema and content`);
  let schema: JsonObject | undefined;
  if (raw.schema !== undefined) schema = sanitizeSchema(raw.schema, `OpenAPI ${operationKey} parameter ${name} schema`);
  else if (raw.content !== undefined) schema = await schemaFromContent(raw.content, resolver, context, `OpenAPI ${operationKey} parameter ${name}`);
  const description = optionalCleanText(raw.description, 500, `OpenAPI ${operationKey} parameter ${name} description`);
  return { name, in: location, required, ...(description ? { description } : {}), ...(schema ? { schema } : {}) };
}

async function normalizeRequestBody(
  raw: unknown, resolver: OpenApiRefResolver, context: LoadedOpenApiDocument, operationKey: string
): Promise<CapabilityRequestBodyDefinition> {
  const resolved = await resolver.resolveRecord(raw, context);
  const body = resolved.record;
  const content = asRecord(body.content, `OpenAPI ${operationKey} requestBody requires content`);
  const entries = Object.entries(content).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) throw new Error(`OpenAPI ${operationKey} requestBody content must not be empty`);
  if (entries.length > MAX_CONTENT_TYPES) throw new Error(`OpenAPI ${operationKey} requestBody exceeds ${MAX_CONTENT_TYPES} content types`);
  const normalizedContent: CapabilityRequestBodyDefinition["content"] = [];
  for (const [mediaType, rawMedia] of entries) {
    const normalizedMediaType = cleanText(mediaType, 128);
    if (!normalizedMediaType) throw new Error(`OpenAPI ${operationKey} requestBody contains an empty media type`);
    const media = await resolver.resolveRecord(rawMedia, resolved.context);
    const schema = media.record.schema === undefined ? undefined : sanitizeSchema(media.record.schema, `OpenAPI ${operationKey} ${mediaType} request schema`);
    normalizedContent.push({ mediaType: normalizedMediaType, ...(schema ? { schema } : {}) });
  }
  const description = optionalCleanText(body.description, 500, `OpenAPI ${operationKey} requestBody description`);
  return { required: body.required === true, ...(description ? { description } : {}), content: normalizedContent };
}

async function schemaFromContent(
  raw: unknown, resolver: OpenApiRefResolver, context: LoadedOpenApiDocument, label: string
): Promise<JsonObject | undefined> {
  const content = asRecord(raw, `${label} content must be an object`);
  const entries = Object.entries(content).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;
  if (entries.length > 1) throw new Error(`${label} content must contain exactly one media type`);
  const [mediaType, rawMedia] = entries[0]!;
  const media = await resolver.resolveRecord(rawMedia, context);
  if (media.record.schema === undefined) return undefined;
  return sanitizeSchema(media.record.schema, `${label} ${mediaType} schema`);
}

function sanitizeSchema(raw: unknown, label: string): JsonObject {
  if (raw === true) return {};
  if (raw === false) return { not: {} };
  if (!isRecord(raw)) throw new Error(`${label} must be an object or boolean JSON Schema`);
  rejectUnsafeSchema(raw, label, 0);
  let json: string;
  try { json = JSON.stringify(raw); }
  catch { throw new Error(`${label} is not JSON-serializable`); }
  if (Buffer.byteLength(json, "utf8") > MAX_SCHEMA_BYTES) throw new Error(`${label} exceeds ${MAX_SCHEMA_BYTES} bytes`);
  return JSON.parse(json) as JsonObject;
}

function rejectUnsafeSchema(value: unknown, label: string, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`${label} exceeds maximum nesting depth ${MAX_SCHEMA_DEPTH}`);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectUnsafeSchema(item, label, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`${label} contains unsafe key: ${key}`);
    rejectUnsafeSchema(child, label, depth + 1);
  }
}

function makeSkill(capability: CapabilityDefinition, used: Set<string>): SkillDefinition {
  if (capability.source.type !== "openapi") throw new Error("OpenAPI skill generation received a non-OpenAPI capability");
  const source = capability.source;
  const base = skillSlug(source.operationId ?? `${source.method}-${source.path}`) || "api-operation";
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base.slice(0, Math.max(1, 61 - String(suffix).length))}-${suffix++}`;
  used.add(name);
  const lines = [
    `Use the OpenAPI operation ${source.method} ${JSON.stringify(source.path)} when it matches the user's request.`
  ];
  if (source.baseUrl) lines.push(`Use the documented API server ${JSON.stringify(source.baseUrl)}.`);
  if (capability.parameters?.length) {
    const parameterText = capability.parameters.map((parameter) => `${parameter.required ? "required" : "optional"} ${parameter.in} ${JSON.stringify(parameter.name)}`).join("; ");
    lines.push(`Parameters: ${parameterText}.`);
  } else {
    lines.push("No operation parameters are declared in the imported OpenAPI description.");
  }
  if (capability.requestBody) {
    const contentTypes = capability.requestBody.content.map((item) => JSON.stringify(item.mediaType)).join(", ");
    lines.push(`Request body: ${capability.requestBody.required ? "required" : "optional"}; accepted content types: ${contentTypes}.`);
  }
  lines.push("Validate required inputs against the normalized schemas. Do not invent credentials, authentication values, or missing required inputs.");
  return {
    name,
    description: cleanText(capability.description ?? `${source.method} ${source.path}`, 500),
    instructions: lines.join("\n\n")
  };
}

function normalizeServerUrl(
  raw: unknown, warnings: OpenApiIngestionWarning[], operationKey: string, context: LoadedOpenApiDocument
): string | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || !isRecord(raw[0]) || typeof raw[0].url !== "string") {
    warnings.push({ code: "SERVER_URL_OMITTED", message: "Could not normalize the operation server URL", operation: operationKey });
    return undefined;
  }
  const value = cleanText(raw[0].url, 2048);
  if (!value || value.includes("{")) {
    warnings.push({ code: "SERVER_URL_TEMPLATE_OMITTED", message: "Templated OpenAPI server URL was not embedded in the capability", operation: operationKey });
    return undefined;
  }
  try {
    const url = /^https?:\/\//i.test(value)
      ? new URL(value)
      : context.sourceType === "url" ? new URL(value, context.source) : undefined;
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error("unsupported protocol");
    if (url.username || url.password || url.hash) throw new Error("credentials or fragment are not allowed");
    return url.toString();
  } catch {
    warnings.push({ code: "SERVER_URL_OMITTED", message: `Invalid or non-HTTP(S) server URL was omitted: ${value}`, operation: operationKey });
    return undefined;
  }
}

function normalizeMetadataUrl(raw: string, warnings: OpenApiIngestionWarning[], label: string): string | undefined {
  const value = cleanText(raw, 2048);
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("unsafe URL");
    return url.toString();
  } catch {
    warnings.push({ code: "METADATA_URL_OMITTED", message: `Invalid ${label} URL was omitted` });
    return undefined;
  }
}

function isParameterLocation(value: string): value is CapabilityParameterDefinition["in"] {
  return value === "path" || value === "query" || value === "querystring" || value === "header" || value === "cookie";
}

function normalizePluginName(value: string): string {
  const result = value.toLowerCase().trim().replace(/[^a-z0-9.-]+/g, "-").replace(/\.{2,}/g, ".").replace(/-{2,}/g, "-").slice(0, 100).replace(/^-+|-+$/g, "");
  if (!result) throw new Error("Unable to derive a valid plugin name from OpenAPI metadata");
  return result;
}

function skillSlug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function boundedString(raw: unknown, label: string, max: number): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} must be a non-empty string`);
  if (raw.length > max) throw new Error(`${label} exceeds ${max} characters`);
  if (/\0/.test(raw)) throw new Error(`${label} contains a NUL character`);
  return raw;
}

function optionalCleanText(raw: unknown, max: number, label: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = cleanText(boundedString(raw, label, Math.max(max * 4, max)), max);
  return value || undefined;
}

function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function asRecord(raw: unknown, message: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(message);
  return raw as Record<string, unknown>;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === "object" && !Array.isArray(raw);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
