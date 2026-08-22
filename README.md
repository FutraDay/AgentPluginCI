# Agent Plugin CI

Compiler, validator and compatibility infrastructure for portable Agent Plugins.

## Current phase

Phase 2B adds OpenAPI ingestion while preserving the Phase 2A MCP pipeline and Phase 1 compiler core:

- stable internal `PluginIR`
- generic MCP and HTTP-operation capability representation
- isolated `@agent-plugin-ci/ingest-openapi` package
- OpenAPI 3.0, 3.1 and 3.2 JSON/YAML loading
- local and remote OpenAPI source loading
- bounded internal and external `$ref` resolution
- parameter and request-body normalization into `PluginIR`
- OpenAPI 3.2 `QUERY`, `querystring` and `additionalOperations` support
- deterministic operation-to-skill generation
- document, schema, reference and operation limits
- secure defaults for private networks, insecure HTTP, cross-origin refs and file refs outside the source root
- OpenAPI source support in the CLI
- existing MCP ingestion and compiler behavior preserved

The source pipelines remain:

`MCP source -> PluginIR -> Compiler -> plugin.json / mcp.json / SKILL.md -> Validator`

`OpenAPI source -> PluginIR -> Compiler -> plugin.json / SKILL.md -> Validator`

## Verify

```powershell
cd C:\Users\dupla\Desktop\AgentPluginCI
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Build

Build the original PluginIR fixture:

```powershell
pnpm cli
```

Build from an MCP configuration and explicitly allow stdio discovery:

```powershell
pnpm cli -- --mcp fixtures/mcp/stdio.json --allow-stdio-discovery --name mcp-example
```

Build from a remote MCP URL without capability discovery:

```powershell
pnpm cli -- --mcp https://example.com/mcp --no-discover --name example-plugin
```

Build from a local OpenAPI JSON or YAML document:

```powershell
pnpm cli -- --openapi fixtures/openapi/support.yaml --name support-api
pnpm cli -- --openapi fixtures/openapi/search.json --name search-api
```

Remote OpenAPI URLs use HTTPS and public-network targets by default. Private-network access, insecure HTTP, cross-origin `$ref` loading and external file refs outside the source root require explicit opt-in flags.
