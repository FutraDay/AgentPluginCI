import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, extname, join, relative, resolve, sep } from "node:path";

export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";

export interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  title: string;
  location: string;
  evidence: string;
  remediation: string;
}

export interface SecuritySummary {
  info: number;
  low: number;
  medium: number;
  high: number;
  critical: number;
  total: number;
  highestSeverity?: SecuritySeverity;
}

export interface SecurityScanResult {
  complete: boolean;
  findings: SecurityFinding[];
  summary: SecuritySummary;
}
export interface SecurityScanInput {
  manifest: unknown;
  mcp?: unknown;
  skills?: Record<string, string>;
}

export interface PackageSecurityScanOptions {
  maxFiles?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxTextBytes?: number;
}

const SEVERITY_ORDER: SecuritySeverity[] = ["info", "low", "medium", "high", "critical"];
const DEFAULT_LIMITS = {
  maxFiles: 2_000,
  maxDepth: 20,
  maxFileBytes: 5_000_000,
  maxTotalBytes: 50_000_000,
  maxTextBytes: 2_000_000
};
const MAX_OBJECT_DEPTH = 64;
const MAX_OBJECT_NODES = 50_000;
const MAX_FINDINGS = 500;
const EXECUTABLE_EXTENSIONS = new Set([".bat", ".cmd", ".com", ".dll", ".exe", ".msi", ".ps1", ".psm1", ".sh"]);
const SENSITIVE_FILE_NAMES = new Set([".env", ".git", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "credentials", "secrets.json"]);
const SENSITIVE_DIRECTORY_NAMES = new Set([".git", ".hg", ".svn", ".ssh", ".gnupg"]);
const TEXT_EXTENSIONS = new Set([
  ".json", ".md", ".txt", ".yaml", ".yml", ".env", ".ini", ".toml", ".xml",
  ".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".pl", ".php",
  ".java", ".go", ".rs", ".cs", ".cfg", ".conf", ".properties"
]);
const SENSITIVE_KEY_RE = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|credential|authorization|auth[_-]?token)/i;
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ }
];

class Collector {
  complete = true;
  readonly findings: SecurityFinding[] = [];
  private readonly seen = new Set<string>();

  add(finding: SecurityFinding): void {
    if (this.findings.length >= MAX_FINDINGS) {
      this.complete = false;
      return;
    }
    const key = `${finding.id}\u0000${finding.location}\u0000${finding.evidence}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.findings.push(finding);
  }

  limit(location: string, evidence: string): void {
    this.complete = false;
    this.add({
      id: "APCI-SEC-020", severity: "high", title: "Security scan limit exceeded",
      location, evidence,
      remediation: "Reduce package size/complexity or raise scanner limits deliberately before relying on the result."
    });
  }
}
export function scanPluginSecurity(input: SecurityScanInput): SecurityScanResult {
  const collector = new Collector();
  scanStructuredSecrets(input.manifest, "plugin.json", collector);
  scanManifestUrls(input.manifest, collector);
  if (input.mcp !== undefined) {
    scanStructuredSecrets(input.mcp, "mcp.json", collector);
    scanMcp(input.mcp, collector);
  }
  for (const [name, content] of Object.entries(input.skills ?? {})) {
    scanTextSecrets(content, `skills/${name}/SKILL.md`, collector);
  }
  return finalize(collector);
}

export async function scanPackageSecurity(
  packageDir: string,
  options: PackageSecurityScanOptions = {}
): Promise<SecurityScanResult> {
  const collector = new Collector();
  const limits = { ...DEFAULT_LIMITS, ...options };
  const root = resolve(packageDir);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) {
    collector.add(symlinkFinding("."));
    collector.complete = false;
    return finalize(collector);
  }
  if (!rootInfo.isDirectory()) throw new Error(`Security scan target must be a directory: ${packageDir}`);
  const realRoot = await realpath(root);
  const state: WalkState = { files: 0, totalBytes: 0, textBytes: 0, texts: new Map() };
  await walkPackage(root, realRoot, "", 0, limits, state, collector);
  scanCapturedPackageFiles(state.texts, collector);
  return finalize(collector);
}

export function severityAtLeast(actual: SecuritySeverity, threshold: SecuritySeverity): boolean {
  return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(threshold);
}
type WalkLimits = typeof DEFAULT_LIMITS;
type WalkState = {
  files: number;
  totalBytes: number;
  textBytes: number;
  texts: Map<string, string>;
};

async function walkPackage(
  dir: string,
  realRoot: string,
  relativeDir: string,
  depth: number,
  limits: WalkLimits,
  state: WalkState,
  collector: Collector
): Promise<void> {
  if (depth > limits.maxDepth) {
    collector.limit(relativeDir || ".", `Directory depth exceeds ${limits.maxDepth}.`);
    return;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  detectCaseCollisions(entries.map((entry) => entry.name), relativeDir || ".", collector);
  for (const entry of entries) {
    if (!collector.complete && state.files >= limits.maxFiles) return;
    const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      collector.add(symlinkFinding(rel));
      continue;
    }
    if (info.isDirectory()) {
      if (SENSITIVE_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
        collector.add({
          id: "APCI-SEC-017", severity: "high", title: "Sensitive artifact included in package",
          location: rel, evidence: `Sensitive directory: ${entry.name}`,
          remediation: "Remove VCS metadata, SSH/GPG material, and other local security state from distributable packages."
        });
        continue;
      }
      await walkPackage(full, realRoot, rel, depth + 1, limits, state, collector);
      continue;
    }
    if (!info.isFile()) continue;
    await inspectFile(full, rel, realRoot, info.size, limits, state, collector);
  }
}
async function inspectFile(
  full: string,
  rel: string,
  realRoot: string,
  size: number,
  limits: WalkLimits,
  state: WalkState,
  collector: Collector
): Promise<void> {
  state.files += 1;
  state.totalBytes += size;
  if (state.files > limits.maxFiles) {
    collector.limit(rel, `Package contains more than ${limits.maxFiles} files.`);
    return;
  }
  if (state.totalBytes > limits.maxTotalBytes) {
    collector.limit(rel, `Package exceeds ${limits.maxTotalBytes} total bytes.`);
    return;
  }
  if (size > limits.maxFileBytes) {
    collector.limit(rel, `File exceeds ${limits.maxFileBytes} bytes and was not inspected.`);
    return;
  }
  const lowerName = basename(rel).toLowerCase();
  if (SENSITIVE_FILE_NAMES.has(lowerName) || /\.(?:pem|key|p12|pfx)$/i.test(lowerName)) {
    collector.add({
      id: "APCI-SEC-017", severity: "high", title: "Sensitive artifact included in package",
      location: rel, evidence: `Sensitive filename: ${basename(rel)}`,
      remediation: "Remove credentials, private keys, environment files, and local configuration from distributable packages."
    });
  }
  if (EXECUTABLE_EXTENSIONS.has(extname(lowerName))) {
    collector.add({
      id: "APCI-SEC-018", severity: "medium", title: "Executable content bundled in package",
      location: rel, evidence: `Executable/script extension: ${extname(lowerName)}`,
      remediation: "Confirm the executable is required, reviewed, pinned, and only launched through an explicitly trusted MCP configuration."
    });
  }
  const wantsText = shouldReadText(rel);
  if (!wantsText) return;
  if (state.textBytes + size > limits.maxTextBytes) {
    collector.limit(rel, `Text inspection budget exceeds ${limits.maxTextBytes} bytes; file was not inspected.`);
    return;
  }
  const realFile = await realpath(full);
  if (!isPathWithin(realRoot, realFile)) {
    collector.add(symlinkFinding(rel));
    return;
  }
  const text = await readFile(full, "utf8");
  state.textBytes += Buffer.byteLength(text);
  state.texts.set(rel.replace(/\\/g, "/"), text);
  scanTextSecrets(text, rel, collector);
}
function shouldReadText(rel: string): boolean {
  const normalized = rel.replace(/\\/g, "/");
  const base = basename(normalized).toLowerCase();
  const isRequired = normalized === "plugin.json" || normalized === "mcp.json" || /(?:^|\/)SKILL\.md$/.test(normalized);
  return isRequired || TEXT_EXTENSIONS.has(extname(base)) || SENSITIVE_FILE_NAMES.has(base);
}

function scanCapturedPackageFiles(texts: Map<string, string>, collector: Collector): void {
  const manifestText = texts.get("plugin.json");
  if (manifestText !== undefined) {
    const manifest = parseStructuredJson(manifestText, "plugin.json", collector);
    if (manifest !== undefined) {
      scanStructuredSecrets(manifest, "plugin.json", collector);
      scanManifestUrls(manifest, collector);
    }
  }
  const mcpText = texts.get("mcp.json");
  if (mcpText !== undefined) {
    const mcp = parseStructuredJson(mcpText, "mcp.json", collector);
    if (mcp !== undefined) {
      scanStructuredSecrets(mcp, "mcp.json", collector);
      scanMcp(mcp, collector);
    }
  }
}
function parseStructuredJson(text: string, location: string, collector: Collector): unknown | undefined {
  try {
    const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return JSON.parse(normalized) as unknown;
  } catch {
    collector.complete = false;
    collector.add({
      id: "APCI-SEC-021", severity: "high", title: "Structured security analysis unavailable",
      location, evidence: `${location} is not valid JSON; targeted checks could not run.`,
      remediation: "Repair the JSON and re-run the security scan before distribution."
    });
    return undefined;
  }
}

function scanManifestUrls(value: unknown, collector: Collector): void {
  if (!isRecord(value)) return;
  for (const field of ["homepage", "repository"] as const) {
    if (typeof value[field] === "string") scanUrl(value[field], `plugin.json/${field}`, false, collector);
  }
  if (isRecord(value.author) && typeof value.author.url === "string") {
    scanUrl(value.author.url, "plugin.json/author/url", false, collector);
  }
}

function scanMcp(value: unknown, collector: Collector): void {
  if (!isRecord(value) || !isRecord(value.mcpServers)) return;
  for (const [serverName, raw] of Object.entries(value.mcpServers)) {
    if (!isRecord(raw)) continue;
    const base = `mcp.json/mcpServers/${serverName}`;
    if (raw.type === "stdio") scanStdioServer(raw, base, collector);
    if ((raw.type === "streamable-http" || raw.type === "sse") && typeof raw.url === "string") {
      scanUrl(raw.url, `${base}/url`, true, collector);
      if (isRecord(raw.headers)) scanHeaders(raw.headers, `${base}/headers`, collector);
    }
  }
}
function scanStdioServer(server: Record<string, unknown>, base: string, collector: Collector): void {
  const command = typeof server.command === "string" ? server.command : "";
  const args = Array.isArray(server.args) ? server.args.filter((item): item is string => typeof item === "string") : [];
  const commandName = basename(command).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, "");

  scanCommandPath(command, `${base}/command`, collector);
  if (isPackageRunner(commandName, args)) {
    collector.add({
      id: "APCI-SEC-009", severity: "high", title: "Package runner may download and execute code",
      location: `${base}/command`, evidence: `Launcher: ${commandName}${args[0] ? ` ${args[0]}` : ""}`,
      remediation: "Use a pinned, locally packaged executable instead of a package runner that can resolve code at runtime."
    });
  }

  if (hasInlineExecution(commandName, args)) {
    collector.add({
      id: "APCI-SEC-010", severity: "high", title: "Inline code execution in MCP launcher",
      location: `${base}/args`, evidence: `Interpreter ${commandName} uses an inline execution switch.`,
      remediation: "Move reviewed code into a plugin-relative file and invoke that file without inline evaluation."
    });
  } else if (isShell(commandName)) {
    collector.add({
      id: "APCI-SEC-011", severity: "medium", title: "Shell used as MCP server launcher",
      location: `${base}/command`, evidence: `Shell executable: ${commandName}`,
      remediation: "Prefer invoking the intended server executable directly rather than routing execution through a shell."
    });
  }

  args.forEach((arg, index) => scanArgumentPath(arg, `${base}/args/${index}`, collector));
  if (typeof server.cwd === "string") scanCwd(server.cwd, `${base}/cwd`, collector);
  if (isRecord(server.env)) scanEnvironment(server.env, `${base}/env`, collector);
}
function scanEnvironment(env: Record<string, unknown>, base: string, collector: Collector): void {
  const highRiskControls = new Set(["NODE_OPTIONS", "PYTHONSTARTUP", "RUBYOPT", "PERL5OPT", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]);
  const mediumRiskControls = new Set([
    "PATH", "PATHEXT", "PYTHONPATH", "NODE_PATH", "RUBYLIB", "PERL5LIB", "DYLD_LIBRARY_PATH",
    "COMSPEC", "SHELL", "HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"
  ]);
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const upper = name.toUpperCase();
    if (highRiskControls.has(upper) || mediumRiskControls.has(upper)) {
      collector.add({
        id: "APCI-SEC-013", severity: highRiskControls.has(upper) ? "high" : "medium",
        title: "Environment variable can influence execution or security boundaries",
        location: `${base}/${name}`, evidence: `${name} is explicitly set; value redacted.`,
        remediation: "Remove overrides that alter executable/module loading, proxying, trust stores, or filesystem roots unless they are strictly required and independently reviewed."
      });
    }
    if (SENSITIVE_KEY_RE.test(name) && !isCredentialPlaceholder(value)) {
      addEmbeddedCredential(`${base}/${name}`, `Sensitive environment variable ${name} contains a literal value.`, collector);
    }
  }
}

function scanHeaders(headers: Record<string, unknown>, base: string, collector: Collector): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    if (/\r|\n/.test(value)) {
      collector.add({
        id: "APCI-SEC-007", severity: "high", title: "HTTP header injection sequence",
        location: `${base}/${name}`, evidence: `${name} contains CR/LF characters; value redacted.`,
        remediation: "Remove control characters and construct headers from validated values only."
      });
    }
    if (/^(host|forwarded|x-forwarded-host|x-original-url|x-rewrite-url|connection|proxy-connection|transfer-encoding)$/i.test(name)) {
      collector.add({
        id: "APCI-SEC-022", severity: "medium", title: "Routing-sensitive MCP header",
        location: `${base}/${name}`, evidence: `${name} can influence HTTP routing or connection semantics; value redacted.`,
        remediation: "Remove routing/proxy headers unless the endpoint explicitly requires them and their effect has been reviewed."
      });
    }
    if (isSensitiveHeader(name) && !isCredentialPlaceholder(value)) {
      collector.add({
        id: "APCI-SEC-008", severity: "high", title: "Embedded credential in MCP header",
        location: `${base}/${name}`, evidence: `${name} contains a literal credential-like value; value redacted.`,
        remediation: "Inject credentials at runtime from a secret store or client configuration instead of embedding them in mcp.json."
      });
    }
  }
}
function scanUrl(raw: string, location: string, isMcpEndpoint: boolean, collector: Collector): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.username || url.password) {
    collector.add({
      id: "APCI-SEC-002", severity: "high", title: "Credential embedded in URL",
      location, evidence: `${redactUrl(url)} contains user information.`,
      remediation: "Remove URL user information and provide credentials through a runtime secret mechanism."
    });
  }
  for (const [name, value] of url.searchParams) {
    if (SENSITIVE_KEY_RE.test(name) && value && !isCredentialPlaceholder(value)) {
      collector.add({
        id: "APCI-SEC-003", severity: "high", title: "Credential-like URL query parameter",
        location, evidence: `Sensitive query parameter ${name} is present; value redacted.`,
        remediation: "Remove credentials from URLs and inject them through a secret store or authenticated client configuration."
      });
    }
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    collector.add({
      id: "APCI-SEC-004", severity: "high", title: "Unencrypted network endpoint",
      location, evidence: `${url.protocol}//${url.host} uses HTTP.`,
      remediation: "Use HTTPS for non-loopback endpoints."
    });
  }
  if (isMcpEndpoint) scanNetworkTarget(url.hostname, location, collector);
}

function scanNetworkTarget(hostname: string, location: string, collector: Collector): void {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const metadataTargets = new Set([
    "169.254.169.254",
    "169.254.170.2",
    "100.100.100.200",
    "fd00:ec2::254",
    "metadata.google.internal",
    "metadata.goog"
  ]);
  if (metadataTargets.has(host)) {
    collector.add({
      id: "APCI-SEC-006", severity: "critical", title: "Cloud metadata service target",
      location, evidence: `Endpoint targets metadata address ${host}.`,
      remediation: "Remove metadata-service endpoints. Never allow an imported plugin to access instance metadata."
    });
    return;
  }
  if (isInternalHost(host)) {
    collector.add({
      id: "APCI-SEC-005", severity: "medium", title: "MCP endpoint targets a local or private network",
      location, evidence: `Endpoint host is local/private: ${host}.`,
      remediation: "Confirm the endpoint is intentionally local/private and enforce client-side network policy before connecting."
    });
  }
}
function scanCommandPath(command: string, location: string, collector: Collector): void {
  if (!command || (!command.includes("/") && !command.includes("\\"))) return;
  const normalized = command.replace(/\\/g, "/");
  const safePluginRelative = command.startsWith("./") && !command.includes("\\") && !normalized.split("/").includes("..");
  if (safePluginRelative) return;
  collector.add({
    id: "APCI-SEC-023", severity: "high", title: "Unsafe MCP executable path",
    location, evidence: "Executable path is absolute, traversing, or outside the plugin-relative command form.",
    remediation: "Use a bare executable name or a non-traversing plugin-relative path beginning with ./"
  });
}

function scanArgumentPath(arg: string, location: string, collector: Collector): void {
  if (!/[\\/]/.test(arg)) return;
  const normalized = arg.replace(/\\/g, "/");
  const candidate = normalized.includes("=") ? normalized.slice(normalized.indexOf("=") + 1) : normalized;
  const absolute = /^(?:[A-Za-z]:\/|\/\/|\/|file:)/i.test(candidate);
  const escapes = candidate.split("/").includes("..");
  const externalVariable = /^(?:~\/|%[^%]+%\/|\$\{(?!PLUGIN_(?:ROOT|DATA)\})[^}]+\}\/)/i.test(candidate);
  if (!absolute && !escapes && !externalVariable) return;
  collector.add({
    id: "APCI-SEC-012", severity: "high", title: "Unsafe path in MCP launcher arguments",
    location,
    evidence: absolute
      ? "Argument contains an absolute filesystem path."
      : escapes
        ? "Argument contains parent-directory traversal."
        : "Argument references a filesystem location outside the declared plugin roots.",
    remediation: "Use plugin-relative paths that remain inside the plugin or plugin-data boundary."
  });
}

function scanCwd(cwd: string, location: string, collector: Collector): void {
  const normalized = cwd.replace(/\\/g, "/");
  const absolute = /^(?:[A-Za-z]:\/|\/\/|\/|file:)/i.test(normalized);
  const escapes = normalized.split("/").includes("..");
  const externalVariable = /^(?:~\/|%[^%]+%\/|\$\{(?!PLUGIN_(?:ROOT|DATA)\})[^}]+\}\/)/i.test(normalized);
  if (!absolute && !escapes && !externalVariable) return;
  collector.add({
    id: "APCI-SEC-014", severity: "high", title: "Unsafe MCP working directory",
    location, evidence: "Working directory is outside the declared plugin/plugin-data boundary or traverses upward.",
    remediation: "Keep cwd within ./, ${PLUGIN_ROOT}, or ${PLUGIN_DATA} without traversing upward."
  });
}

function scanStructuredSecrets(value: unknown, root: string, collector: Collector): void {
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_OBJECT_NODES || current.depth > MAX_OBJECT_DEPTH) {
      collector.limit(current.path, "Object graph exceeds structured security scan limits.");
      return;
    }
    if (typeof current.value === "string") {
      scanTextSecrets(current.value, current.path, collector);
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value as object)) {
      collector.limit(current.path, "Object graph contains a cycle or shared object reference.");
      return;
    }
    seen.add(current.value as object);
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => stack.push({ value: item, path: `${current.path}/${index}`, depth: current.depth + 1 }));
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      const path = `${current.path}/${key}`;
      if (typeof child === "string" && SENSITIVE_KEY_RE.test(key) && !isCredentialPlaceholder(child)) {
        addEmbeddedCredential(path, `Sensitive field ${key} contains a literal value.`, collector);
      }
      stack.push({ value: child, path, depth: current.depth + 1 });
    }
  }
}
function scanTextSecrets(text: string, location: string, collector: Collector): void {
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (!pattern.re.test(text)) continue;
    collector.add({
      id: "APCI-SEC-019", severity: "critical", title: "Secret material embedded in package content",
      location, evidence: `${pattern.name} pattern detected; secret value redacted.`,
      remediation: "Remove the secret, rotate/revoke it, and reference a runtime secret source instead."
    });
  }
}

function addEmbeddedCredential(location: string, evidence: string, collector: Collector): void {
  collector.add({
    id: "APCI-SEC-001", severity: "high", title: "Embedded credential-like value",
    location, evidence: `${evidence} Value redacted.`,
    remediation: "Remove embedded credentials and inject them at runtime from a secret store or client configuration."
  });
}

function detectCaseCollisions(names: string[], location: string, collector: Collector): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const portable = name.toLowerCase();
    const previous = seen.get(portable);
    if (previous && previous !== name) {
      collector.add({
        id: "APCI-SEC-016", severity: "medium", title: "Case-insensitive package path collision",
        location, evidence: `Entries ${previous} and ${name} collide on case-insensitive filesystems.`,
        remediation: "Rename package entries so every path is unique under case-insensitive comparison."
      });
    }
    seen.set(portable, name);
  }
}

function symlinkFinding(location: string): SecurityFinding {
  return {
    id: "APCI-SEC-015", severity: "high", title: "Symbolic link inside plugin package",
    location, evidence: "Package entry is a symbolic link and was not followed.",
    remediation: "Replace symlinks with regular package-contained files/directories and re-run the scan."
  };
}
function isPackageRunner(command: string, args: string[]): boolean {
  if (["npx", "bunx", "uvx"].includes(command)) return true;
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    return ["exec", "x", "dlx"].includes((args[0] ?? "").toLowerCase());
  }
  return false;
}

function hasInlineExecution(command: string, args: string[]): boolean {
  const lowered = args.map((arg) => arg.toLowerCase());
  if (["powershell", "pwsh"].includes(command)) return lowered.some((arg) => ["-command", "-c", "-encodedcommand", "-enc"].includes(arg));
  if (command === "cmd") return lowered.some((arg) => ["/c", "/k"].includes(arg));
  if (["sh", "bash", "zsh", "fish"].includes(command)) return lowered.includes("-c");
  if (["node", "deno", "bun"].includes(command)) return lowered.some((arg) => ["-e", "--eval", "--print", "-p"].includes(arg));
  if (["python", "python3", "py", "ruby", "perl"].includes(command)) return lowered.includes("-c") || lowered.includes("-e");
  return false;
}

function isShell(command: string): boolean {
  return ["powershell", "pwsh", "cmd", "sh", "bash", "zsh", "fish"].includes(command);
}

function isSensitiveHeader(name: string): boolean {
  return /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i.test(name) || SENSITIVE_KEY_RE.test(name);
}

function isCredentialPlaceholder(value: string): boolean {
  return /^\s*(?:(?:bearer|basic)\s+)?\$\{[^}\r\n]+\}\s*$/i.test(value);
}

function redactUrl(url: URL): string {
  const copy = new URL(url.toString());
  if (copy.username) copy.username = "REDACTED";
  if (copy.password) copy.password = "REDACTED";
  for (const key of [...copy.searchParams.keys()]) {
    if (SENSITIVE_KEY_RE.test(key)) copy.searchParams.set(key, "REDACTED");
  }
  return copy.toString();
}
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain" || host === "::1") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return false;
}

function isInternalHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (isLoopback(host) || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const parts = host.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) || parts[0] === 0;
  }
  if (isIP(host) === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
  }
  return false;
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !/^[A-Za-z]:/.test(rel));
}

function finalize(collector: Collector): SecurityScanResult {
  const summary: SecuritySummary = { info: 0, low: 0, medium: 0, high: 0, critical: 0, total: collector.findings.length };
  let highest: SecuritySeverity | undefined;
  for (const finding of collector.findings) {
    summary[finding.severity] += 1;
    if (!highest || severityAtLeast(finding.severity, highest)) highest = finding.severity;
  }
  if (highest) summary.highestSeverity = highest;
  return { complete: collector.complete, findings: collector.findings, summary };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
