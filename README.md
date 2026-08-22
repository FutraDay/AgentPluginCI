# Agent Plugin CI

Compiler, validator and compatibility infrastructure for portable Agent Plugins.

## Current phase

Phase 2A adds real MCP source ingestion while preserving the Phase 1 compiler core:

- stable internal `PluginIR`
- generic discovered capability representation
- isolated `@agent-plugin-ci/ingest-mcp` package
- MCP configuration normalization
- MCP SDK v2 tool discovery over stdio, Streamable HTTP and SSE
- deterministic tool-to-skill generation
- untrusted-input limits and metadata sanitization
- secure discovery defaults for stdio, private networks and insecure HTTP
- MCP source support in the CLI

The pipeline remains:

`MCP source -> PluginIR -> Compiler -> plugin.json / mcp.json / SKILL.md -> Validator`

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
pnpm cli -- --mcp fixtures/mcp/stdio.json --allow-stdio-discovery --name mcp-phase2a-e2e --out dist/mcp-phase2a-e2e
```

Build from a remote MCP URL without capability discovery:

```powershell
pnpm cli -- --mcp https://example.com/mcp --no-discover --name example-plugin
```

Stdio execution, private-network discovery and insecure HTTP discovery require explicit opt-in flags.
