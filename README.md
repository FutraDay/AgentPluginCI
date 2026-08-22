# Agent Plugin CI

Agent Plugin CI builds and validates portable Agent Plugins from real integration sources.

> **v0.1 Developer Preview** — MCP ingestion, OpenAPI ingestion, deterministic `PluginIR` normalization, Agent Plugins 1.0 compilation, validation, and a distribution-ready CLI.

The core architecture is intentionally fixed:

`Source -> PluginIR -> Compiler -> Validator -> Package`

No source ingestion path compiles directly into `plugin.json`.

## Supported in v0.1

- MCP configuration files and MCP URLs
- optional MCP SDK v2 capability/tool discovery
- OpenAPI 3.0, 3.1, and 3.2 JSON/YAML files
- remote OpenAPI specifications with secure defaults
- deterministic skill generation from discovered capabilities
- `plugin.json`, optional `mcp.json`, and `skills/*/SKILL.md` output
- package validation from the CLI
- machine-readable JSON results for CI
- bundled npm CLI package
- GitHub CI and tagged release packaging

Markdown/docs/repository ingestion, compatibility matrices, certification, hosted builds, and the web application are intentionally deferred until after v0.1.

## Quick start

Requirements:

- Node.js 22.13+
- pnpm 11.2.2 for repository development

From the repository:

```powershell
cd C:\Users\dupla\Desktop\AgentPluginCI
pnpm install
pnpm build
node apps/cli/dist/index.cjs --help
```

The v0.1.0 Developer Preview is published publicly as `@agent-plugin-ci/cli`. Install it globally with:

```powershell
npm install -g @agent-plugin-ci/cli@0.1.0
agentplugin --version
```

The installed executable name is `agentplugin`.

## Build from MCP

Build an MCP configuration without executing its stdio server:

```powershell
node apps/cli/dist/index.cjs build --mcp fixtures/mcp/stdio.json --no-discover --name mcp-example --out dist/mcp-example
```

To discover stdio tools, execution must be explicitly enabled:

```powershell
node apps/cli/dist/index.cjs build --mcp fixtures/mcp/stdio.json --allow-stdio-discovery --name mcp-example --out dist/mcp-example --force
```

Remote MCP URL builds are supported. Capability discovery is enabled by default, while private-network and insecure HTTP targets remain blocked unless explicitly allowed.

```powershell
node apps/cli/dist/index.cjs build --mcp https://example.com/mcp --no-discover --name example-plugin
```

## Build from OpenAPI

```powershell
node apps/cli/dist/index.cjs build --openapi fixtures/openapi/support.yaml --name support-api --out dist/support-api
node apps/cli/dist/index.cjs build --openapi fixtures/openapi/search.json --name search-api --out dist/search-api
```

Remote OpenAPI sources use HTTPS and public-network targets by default. Private-network access, insecure HTTP, cross-origin `$ref` loading, and external file refs outside the source root require explicit opt-in flags.

## Validate a package

```powershell
node apps/cli/dist/index.cjs validate dist/support-api
```

Validation accepts either a package directory or its `plugin.json` path. Exit code `0` means valid; exit code `1` means the package, input, build, or security check failed; exit code `2` means the CLI invocation itself is invalid.

## Machine-readable CI output

Add `--json` to `build` or `validate` to emit one JSON object on stdout.

```powershell
node apps/cli/dist/index.cjs build --openapi fixtures/openapi/search.json --name search-api --out dist/search-api --json
node apps/cli/dist/index.cjs validate dist/search-api --json
```

## Output structure

A successful build writes only the portable plugin package:

```text
<output>/
  plugin.json
  mcp.json                 # MCP builds only
  skills/
    <skill-name>/
      SKILL.md
```

The CLI refuses to replace a non-empty output directory unless `--force` is supplied. Even with `--force`, replacement is limited to directories that match Agent Plugin CI's generated package shape: a valid `plugin.json`, optional valid `mcp.json`, and generated `skills/<name>/SKILL.md` entries only. Extra files, unexpected directories, symbolic links, malformed generated files, unsafe skill names, and case-insensitive skill-name collisions cause replacement to be refused. The invocation directory, its ancestors, and symbolic-link output roots are also protected.

## Security baseline

Imported sources are untrusted. v0.1 keeps these behaviors deny-by-default:

- stdio MCP process execution
- private-network MCP/OpenAPI access
- insecure HTTP targets
- cross-origin remote OpenAPI `$ref` targets
- OpenAPI file refs outside the source root
- oversized MCP/OpenAPI/schema inputs
- unsafe schema keys and excessive nesting where implemented by ingestion packages

Inline MCP environment values are normalized to environment-variable placeholders rather than copied into generated `mcp.json`.

Use the `--allow-*` flags only for sources you trust and only when the target workflow requires them.
## Development verification

Before a launch-hardening checkpoint can pass:

```powershell
cd C:\Users\dupla\Desktop\AgentPluginCI
pnpm typecheck
pnpm test
pnpm build
pnpm pack:cli
git diff --check
git status
```

`pnpm verify` runs typechecking, the full test suite, and all workspace builds.

## Release packaging

The CLI package is configured at version `0.1.0` with the executable name `agentplugin`. `pnpm pack:cli` creates the npm tarball under `artifacts/`.

GitHub Actions performs the same verification on pushes and pull requests, including MCP, OpenAPI and raw PluginIR CLI smoke builds plus an install-and-run test of the packed npm tarball. Tags matching `v*` run the full verification pipeline, require the tag to match the CLI package version, install and smoke-test the release tarball, and create a GitHub release containing that artifact.

Actual npm publication is intentionally not automated until the npm organization/package ownership and publishing credentials are configured. That keeps the repository release-ready without introducing a secret or account dependency into v0.1 hardening.
