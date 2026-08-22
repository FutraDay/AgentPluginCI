# Agent Plugin CI

Compiler, validator and compatibility infrastructure for Agent Plugins 1.0.

## Current phase

Phase 1 establishes the portable compilation core:

- internal `PluginIR`
- Agent Plugins 1.0 constants
- `plugin.json` compiler
- `mcp.json` compiler
- `SKILL.md` generation
- semantic validation
- CLI build path
- reference fixture

## Run

```powershell
cd C:\Users\dupla\Desktop\AgentPluginCI
pnpm install
pnpm typecheck
pnpm test
pnpm cli
```

Generated fixture output is written to `dist/hello-plugin`.
