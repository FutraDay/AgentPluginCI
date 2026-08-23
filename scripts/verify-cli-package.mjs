import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const MAX_ENTRY_COUNT = 16;
const REPOSITORY_URL = "https://github.com/FutraDay/AgentPluginCI.git";
const EXPECTED_PACKAGE_NAME = "@agent-plugin-ci/cli";
const EXPECTED_ENTRIES = new Map([
  ["package/package.json", 0o644],
  ["package/dist/index.cjs", 0o755]
]);
const EXPECTED_MANIFEST_FIELDS = [
  "name",
  "version",
  "description",
  "private",
  "type",
  "bin",
  "files",
  "engines",
  "repository",
  "publishConfig",
  "devDependencies",
  "scripts"
];
const FORBIDDEN_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish"
];

function fail(message) {
  throw new Error(`CLI package verification failed: ${message}`);
}

function readTarString(buffer, offset, length, label) {
  const field = buffer.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const valueBytes = nul === -1 ? field : field.subarray(0, nul);
  if ([...valueBytes].some((byte) => byte < 0x20 || byte > 0x7e)) {
    fail(`${label} contains unsupported bytes`);
  }
  if (nul !== -1 && field.subarray(nul).some((byte) => byte !== 0)) {
    fail(`${label} contains data after its terminator`);
  }
  return valueBytes.toString("ascii");
}

function readTarOctal(buffer, offset, length, label) {
  const raw = buffer.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(raw)) fail(`${label} is not a valid octal field`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is outside the supported range`);
  return value;
}

function tarHeaderChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

function validateMemberPath(path) {
  if (
    path.length === 0 ||
    path.length > 256 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !path.startsWith("package/")
  ) {
    fail(`unsafe archive member path ${JSON.stringify(path)}`);
  }
}

export function inspectTarball(archive) {
  if (!Buffer.isBuffer(archive)) fail("archive input must be a Buffer");
  if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
    fail(`compressed archive size must be between 1 and ${MAX_ARCHIVE_BYTES} bytes`);
  }

  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch {
    fail("archive is not a bounded, valid gzip stream");
  }

  const entries = [];
  const seenPaths = new Set();
  const seenCaseInsensitivePaths = new Set();
  let offset = 0;
  let foundEndMarker = false;

  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      const trailer = tar.subarray(offset);
      if (trailer.length < TAR_BLOCK_BYTES * 2 || trailer.some((byte) => byte !== 0)) {
        fail("archive has an invalid end marker or trailing data");
      }
      foundEndMarker = true;
      break;
    }

    if (entries.length >= MAX_ENTRY_COUNT) fail(`archive contains more than ${MAX_ENTRY_COUNT} members`);

    const storedChecksum = readTarOctal(header, 148, 8, "tar header checksum");
    if (storedChecksum !== tarHeaderChecksum(header)) fail("archive member has an invalid tar header checksum");

    const magic = header.subarray(257, 263).toString("ascii");
    if (magic !== "ustar\0" && magic !== "ustar ") fail("archive member is not in the supported ustar format");

    const name = readTarString(header, 0, 100, "archive member name");
    const prefix = readTarString(header, 345, 155, "archive member prefix");
    const path = prefix ? `${prefix}/${name}` : name;
    validateMemberPath(path);

    const foldedPath = path.toLowerCase();
    if (seenPaths.has(path) || seenCaseInsensitivePaths.has(foldedPath)) {
      fail(`duplicate archive member ${JSON.stringify(path)}`);
    }
    seenPaths.add(path);
    seenCaseInsensitivePaths.add(foldedPath);

    const typeFlag = header[156];
    if (typeFlag !== 0 && typeFlag !== 0x30) {
      fail(`archive member ${JSON.stringify(path)} is not a regular file`);
    }

    const size = readTarOctal(header, 124, 12, `size for ${path}`);
    const mode = readTarOctal(header, 100, 8, `mode for ${path}`) & 0o7777;
    if ((mode & 0o7000) !== 0) fail(`archive member ${JSON.stringify(path)} has special permission bits`);
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (dataEnd > tar.length || nextOffset > tar.length) fail(`archive member ${JSON.stringify(path)} is truncated`);
    if (tar.subarray(dataEnd, nextOffset).some((byte) => byte !== 0)) {
      fail(`archive member ${JSON.stringify(path)} has non-zero padding`);
    }

    entries.push({ path, mode, size, contents: Buffer.from(tar.subarray(dataStart, dataEnd)) });
    offset = nextOffset;
  }

  if (!foundEndMarker) fail("archive is missing its tar end marker");
  return entries;
}

function assertJsonEqual(actual, expected, label) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)])
      );
    }
    return value;
  };
  if (JSON.stringify(canonicalize(actual)) !== JSON.stringify(canonicalize(expected))) {
    fail(`${label} does not match the release contract`);
  }
}

function expectedTarballName(name, version) {
  if (name !== EXPECTED_PACKAGE_NAME) fail(`source package name must be ${EXPECTED_PACKAGE_NAME}`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    fail("source package version is not a supported semantic version");
  }
  return `agent-plugin-ci-cli-${version}.tgz`;
}

export function verifyTarballContract(archive, sourceManifest, filename) {
  const expectedFilename = expectedTarballName(sourceManifest.name, sourceManifest.version);
  if (filename !== expectedFilename) fail(`tarball must be named ${expectedFilename}`);

  const entries = inspectTarball(archive);
  const actualPaths = entries.map((entry) => entry.path).sort();
  const expectedPaths = [...EXPECTED_ENTRIES.keys()].sort();
  assertJsonEqual(actualPaths, expectedPaths, "archive contents");

  for (const entry of entries) {
    const expectedMode = EXPECTED_ENTRIES.get(entry.path);
    if (entry.mode !== expectedMode) {
      fail(`${entry.path} must have mode ${expectedMode.toString(8)}, received ${entry.mode.toString(8)}`);
    }
  }

  const manifestEntry = entries.find((entry) => entry.path === "package/package.json");
  const executableEntry = entries.find((entry) => entry.path === "package/dist/index.cjs");
  if (manifestEntry.size === 0 || manifestEntry.size > 64 * 1024) {
    fail("package/package.json must be between 1 byte and 64 KiB");
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestEntry.contents));
  } catch {
    fail("package/package.json is not valid JSON");
  }

  const requiredMetadata = {
    name: EXPECTED_PACKAGE_NAME,
    version: sourceManifest.version,
    description: sourceManifest.description,
    private: false,
    type: "module",
    bin: { agentplugin: "dist/index.cjs" },
    files: ["dist"],
    engines: { node: ">=22.13" },
    repository: { type: "git", url: REPOSITORY_URL, directory: "apps/cli" },
    publishConfig: { access: "public" }
  };
  for (const [field, expected] of Object.entries(requiredMetadata)) {
    assertJsonEqual(sourceManifest[field], expected, `source package metadata field ${field}`);
    assertJsonEqual(manifest[field], expected, `package metadata field ${field}`);
  }

  for (const lifecycle of FORBIDDEN_LIFECYCLE_SCRIPTS) {
    if (sourceManifest.scripts?.[lifecycle] !== undefined || manifest.scripts?.[lifecycle] !== undefined) {
      fail(`published package must not declare the ${lifecycle} lifecycle script`);
    }
  }

  assertJsonEqual(Object.keys(sourceManifest).sort(), [...EXPECTED_MANIFEST_FIELDS].sort(), "source package metadata fields");
  assertJsonEqual(Object.keys(manifest).sort(), [...EXPECTED_MANIFEST_FIELDS].sort(), "package metadata fields");
  const expectedDevDependencies = Object.fromEntries(
    Object.entries(sourceManifest.devDependencies ?? {}).map(([name, value]) => [
      name,
      typeof value === "string" && value.startsWith("workspace:") ? sourceManifest.version : value
    ])
  );
  assertJsonEqual(manifest.devDependencies ?? {}, expectedDevDependencies, "package development metadata");
  assertJsonEqual(manifest.scripts ?? {}, sourceManifest.scripts ?? {}, "package scripts");

  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
    if (field in manifest) fail(`published package must not declare ${field}`);
  }
  if (executableEntry.size < 1024 || !executableEntry.contents.subarray(0, 20).toString("utf8").startsWith("#!/usr/bin/env node\n")) {
    fail("packaged CLI is unexpectedly small or missing its Node.js shebang");
  }

  return { filename: expectedFilename, manifest, entries };
}

function checksumLine(archive, filename) {
  return `${createHash("sha256").update(archive).digest("hex")}  ${filename}\n`;
}

export async function verifyCliPackage({
  artifactsDir = resolve("artifacts"),
  sourceManifestPath = resolve("apps/cli/package.json"),
  checksumMode = "write"
} = {}) {
  if (checksumMode !== "write" && checksumMode !== "check") fail("checksum mode must be write or check");

  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const filename = expectedTarballName(sourceManifest.name, sourceManifest.version);
  const allowedNames = new Set([filename, "SHA256SUMS"]);
  const artifactsStat = await lstat(artifactsDir);
  if (!artifactsStat.isDirectory() || artifactsStat.isSymbolicLink()) {
    fail("artifacts path must be a regular directory, not a symbolic link");
  }
  const directoryEntries = await readdir(artifactsDir, { withFileTypes: true });
  for (const entry of directoryEntries) {
    if (!entry.isFile() || !allowedNames.has(entry.name)) {
      fail(`unexpected artifact entry ${JSON.stringify(entry.name)}`);
    }
  }
  if (!directoryEntries.some((entry) => entry.name === filename)) fail(`missing expected tarball ${filename}`);

  const archivePath = join(artifactsDir, filename);
  const archive = await readFile(archivePath);
  verifyTarballContract(archive, sourceManifest, basename(archivePath));

  const expectedChecksum = checksumLine(archive, filename);
  const checksumPath = join(artifactsDir, "SHA256SUMS");
  if (checksumMode === "write") {
    await writeFile(checksumPath, expectedChecksum, { encoding: "ascii", mode: 0o644 });
  } else {
    const actualChecksum = await readFile(checksumPath);
    const expectedBytes = Buffer.from(expectedChecksum, "ascii");
    if (actualChecksum.length !== expectedBytes.length || !timingSafeEqual(actualChecksum, expectedBytes)) {
      fail("SHA256SUMS does not exactly match the verified tarball");
    }
  }

  return { filename, checksum: expectedChecksum.slice(0, 64), entries: [...EXPECTED_ENTRIES.keys()] };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) fail(`unsupported argument ${JSON.stringify(args.find((arg) => arg !== "--check"))}`);
  const result = await verifyCliPackage({ checksumMode: args.includes("--check") ? "check" : "write" });
  process.stdout.write(`PACKAGE_OK ${result.filename} sha256=${result.checksum} entries=${result.entries.length}\n`);
}
