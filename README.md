# Agent Plugin CI

Agent Plugin CI builds and validates portable Agent Plugins from real integration sources.

> **v0.1 Developer Preview** — MCP ingestion, OpenAPI ingestion, deterministic `PluginIR` normalization, Agent Plugins 1.0 compilation, validation, security scanning, static compatibility testing, and a distribution-ready CLI.

The core architecture is intentionally fixed:

`Source -> PluginIR -> Compiler -> Official Validation -> Security Scan -> Compatibility Testing -> Package`

No source ingestion path compiles directly into `plugin.json`.

## Supported in v0.1

- MCP configuration files and MCP URLs
- optional MCP SDK v2 capability/tool discovery
- OpenAPI 3.0, 3.1, and 3.2 JSON/YAML files
- remote OpenAPI specifications with secure defaults
- deterministic skill generation from discovered capabilities
- `plugin.json`, optional `mcp.json`, and `skills/*/SKILL.md` output
- package validation from the CLI
- deterministic package security scanning with stable findings and CI severity policy
- versioned static compatibility profiles for Agent Plugins 1.0 portable core, Cursor, and VS Code/GitHub Copilot
- machine-readable JSON results for CI
- bundled npm CLI package
- GitHub CI and tagged release packaging

Markdown/docs/repository ingestion, runtime client adapters, compatibility matrices backed by runtime evidence, certification, hosted builds, and the web application are intentionally deferred until after v0.1.

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

The published npm `0.1.0` package predates Phase 2I security scanning and Phase 2J compatibility testing. The `scan` and `compat` commands documented below are currently available from the repository build and will ship with a subsequent published CLI release.

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

## Scan package security

Security scanning is deliberately separate from schema validation. It does not execute plugin code or MCP servers.

```powershell
node apps/cli/dist/index.cjs scan dist/support-api
node apps/cli/dist/index.cjs scan dist/support-api --fail-on medium
node apps/cli/dist/index.cjs scan dist/support-api --fail-on none --json
```

The default policy fails on `high` or `critical` findings. `--fail-on none` keeps the scan report-only. Findings include stable IDs, severity, location, redacted evidence, and remediation guidance. Builds also run an in-memory report-only scan so new security findings are surfaced without changing existing build success semantics.

## Check static compatibility

Compatibility testing consumes a compiled Agent Plugins package; it does not ingest arbitrary sources, execute plugin code, install the package into a client, or launch MCP servers.

```powershell
node apps/cli/dist/index.cjs compat dist/support-api
node apps/cli/dist/index.cjs compat dist/support-api --profile cursor-agent-plugins-1.0
node apps/cli/dist/index.cjs compat dist/support-api --all --json
```

The default profile is `agent-plugins-1.0-portable-core`. Built-in client profiles are evidence-backed by first-party documentation for Cursor and VS Code/GitHub Copilot. Reports contain versioned profile and test IDs, bounded evidence, deterministic summaries, completeness, an explicit `static-inspection` evidence level, and `runtimeVerified: false`. Passing means statically eligible under the selected profile; client installation and MCP handshake evidence remain `not-assessed`, so the report never claims proven runtime interoperability. This phase confirms bounded, regular `skills/*/SKILL.md` discovery paths but does not validate `SKILL.md` document semantics, which is reported as a warning rather than silently treated as proven. Builds surface the portable-core result in report-only mode without changing successful build exit semantics.

## Machine-readable CI output

Add `--json` to `build`, `validate`, `scan`, or `compat` to emit one JSON object on stdout.

```powershell
node apps/cli/dist/index.cjs build --openapi fixtures/openapi/search.json --name search-api --out dist/search-api --json
node apps/cli/dist/index.cjs validate dist/search-api --json
node apps/cli/dist/index.cjs scan dist/search-api --json
node apps/cli/dist/index.cjs compat dist/search-api --all --json
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

The Phase 2I scanner additionally checks package content without executing it, including embedded credentials, dangerous MCP launchers and inline execution, unsafe paths and working directories, execution-control environment variables, credential/routing-sensitive headers, private or metadata-service endpoints, symlinks, case-insensitive path collisions, sensitive local artifacts, executable content, and bounded filesystem/object traversal. Scan-limit or structured-analysis failures are reported explicitly rather than treated as clean results.

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
