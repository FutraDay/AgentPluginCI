import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { LoadedOpenApiDocument, OpenApiLoadOptions } from "./types.js";
import { loadOpenApiSource } from "./loader.js";

const DEFAULT_MAX_REF_DOCUMENTS = 20;
const DEFAULT_MAX_REF_DEPTH = 20;
const MAX_REF_LENGTH = 2048;

export interface ResolvedOpenApiRecord {
  record: Record<string, unknown>;
  context: LoadedOpenApiDocument;
}

export class OpenApiRefResolver {
  private readonly documents = new Map<string, LoadedOpenApiDocument>();
  private readonly rootDirectory?: string;

  constructor(private readonly root: LoadedOpenApiDocument, private readonly options: OpenApiLoadOptions = {}) {
    this.documents.set(root.source, root);
    if (root.sourceType === "file") this.rootDirectory = dirname(root.source);
  }

  async resolveRecord(value: unknown, context = this.root, depth = 0, chain = new Set<string>()): Promise<ResolvedOpenApiRecord> {
    const record = asRecord(value, "OpenAPI reference target must be an object");
    if (record.$ref === undefined) return { record, context };
    if (typeof record.$ref !== "string" || !record.$ref.trim()) throw new Error("OpenAPI $ref must be a non-empty string");
    if (record.$ref.length > MAX_REF_LENGTH) throw new Error(`OpenAPI $ref exceeds ${MAX_REF_LENGTH} characters`);
    return this.resolveReference(record.$ref, context, depth, chain);
  }

  private async resolveReference(ref: string, context: LoadedOpenApiDocument, depth: number, chain: Set<string>): Promise<ResolvedOpenApiRecord> {
    const maxDepth = this.options.maxRefDepth ?? DEFAULT_MAX_REF_DEPTH;
    if (depth >= maxDepth) throw new Error(`OpenAPI $ref exceeds maximum depth ${maxDepth}`);
    const { location, fragment } = splitReference(ref);
    const targetContext = location ? await this.loadReferencedDocument(location, context) : context;
    const key = `${targetContext.source}#${fragment}`;
    if (chain.has(key)) throw new Error(`OpenAPI $ref cycle detected at ${key}`);
    const nextChain = new Set(chain);
    nextChain.add(key);
    const target = resolveJsonPointer(targetContext.document, fragment);
    return this.resolveRecord(target, targetContext, depth + 1, nextChain);
  }

  private async loadReferencedDocument(location: string, context: LoadedOpenApiDocument): Promise<LoadedOpenApiDocument> {
    let target: string;
    if (context.sourceType === "url") {
      const base = new URL(context.source);
      const resolvedUrl = new URL(location, base);
      if (resolvedUrl.protocol !== "http:" && resolvedUrl.protocol !== "https:") throw new Error("Remote OpenAPI $ref must use HTTP(S)");
      if (!this.options.allowCrossOriginRefs && resolvedUrl.origin !== base.origin) {
        throw new Error(`Refusing cross-origin OpenAPI $ref from ${base.origin} to ${resolvedUrl.origin}`);
      }
      resolvedUrl.hash = "";
      target = resolvedUrl.toString();
    } else if (context.sourceType === "file") {
      if (/^https?:\/\//i.test(location)) {
        if (!this.options.allowCrossOriginRefs) throw new Error("Refusing remote OpenAPI $ref from a local document");
        const url = new URL(location);
        url.hash = "";
        target = url.toString();
      } else {
        target = resolve(dirname(context.source), decodeURIComponent(location));
        if (!this.options.allowExternalFileRefsOutsideRoot && this.rootDirectory) {
          const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(this.rootDirectory), realpath(target)]);
          if (!isWithin(canonicalRoot, canonicalTarget)) {
            throw new Error(`Refusing OpenAPI $ref outside root directory: ${target}`);
          }
          target = canonicalTarget;
        }
      }
    } else {
      throw new Error("External OpenAPI $ref is not allowed for in-memory documents");
    }

    const cached = this.documents.get(target);
    if (cached) return cached;
    const maxDocuments = this.options.maxRefDocuments ?? DEFAULT_MAX_REF_DOCUMENTS;
    if (this.documents.size - 1 >= maxDocuments) throw new Error(`OpenAPI $ref exceeds ${maxDocuments} external documents`);
    const loaded = await loadOpenApiSource(target, this.options);
    this.documents.set(loaded.source, loaded);
    return loaded;
  }
}

function splitReference(ref: string): { location: string; fragment: string } {
  const hashIndex = ref.indexOf("#");
  if (hashIndex < 0) return { location: ref, fragment: "" };
  return { location: ref.slice(0, hashIndex), fragment: ref.slice(hashIndex + 1) };
}

function resolveJsonPointer(document: unknown, fragment: string): unknown {
  if (!fragment) return document;
  let pointer: string;
  try { pointer = decodeURIComponent(fragment); }
  catch { throw new Error(`OpenAPI $ref has invalid percent encoding: #${fragment}`); }
  if (!pointer.startsWith("/")) throw new Error(`OpenAPI $ref fragment must be a JSON Pointer: #${fragment}`);
  let current: unknown = document;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) throw new Error(`OpenAPI $ref array index is invalid: ${token}`);
      const index = Number(token);
      if (index >= current.length) throw new Error(`OpenAPI $ref target does not exist: #${fragment}`);
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, token)) {
      throw new Error(`OpenAPI $ref target does not exist: #${fragment}`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
