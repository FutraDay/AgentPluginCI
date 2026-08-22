import type { PluginIR } from "@agent-plugin-ci/plugin-ir";

export interface OpenApiIngestionWarning {
  code: string;
  message: string;
  operation?: string;
}

export interface OpenApiLoadOptions {
  allowPrivateNetwork?: boolean;
  allowInsecureHttp?: boolean;
  allowCrossOriginRefs?: boolean;
  allowExternalFileRefsOutsideRoot?: boolean;
  timeoutMs?: number;
  maxDocumentBytes?: number;
  maxRedirects?: number;
  maxRefDocuments?: number;
  maxRefDepth?: number;
}

export interface IngestOpenApiOptions extends OpenApiLoadOptions {
  pluginName?: string;
  pluginVersion?: string;
  description?: string;
}

export interface LoadedOpenApiDocument {
  document: unknown;
  source: string;
  sourceType: "file" | "url" | "memory";
}

export interface IngestOpenApiResult {
  ir: PluginIR;
  warnings: OpenApiIngestionWarning[];
}
