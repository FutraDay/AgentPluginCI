import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { verifyCliPackage, verifyTarballContract } from "./verify-cli-package.mjs";

const sourceManifest = {
  name: "@agent-plugin-ci/cli",
  version: "1.2.3",
  description: "test package",
  private: false,
  type: "module",
  bin: { agentplugin: "dist/index.cjs" },
  files: ["dist"],
  engines: { node: ">=22.13" },
  repository: { type: "git", url: "https://github.com/FutraDay/AgentPluginCI.git", directory: "apps/cli" },
  publishConfig: { access: "public" },
  devDependencies: { "@agent-plugin-ci/compiler": "workspace:*", esbuild: "^0.28.2" },
  scripts: { build: "node scripts/build.mjs", test: "vitest run" }
};

function writeString(buffer, offset, length, value) {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "ascii");
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeString(buffer, offset, length, `${encoded}\0`);
}

function tarEntry(path, contents, { mode = 0o644, type = "0" } = {}) {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, padding]);
}

function packagedManifest(overrides = {}) {
  return {
    ...sourceManifest,
    devDependencies: { "@agent-plugin-ci/compiler": "1.2.3", esbuild: "^0.28.2" },
    ...overrides
  };
}

function archive(entries = [], manifestOverrides = {}) {
  const defaults = [
    tarEntry("package/package.json", JSON.stringify(packagedManifest(manifestOverrides))),
    tarEntry("package/dist/index.cjs", `#!/usr/bin/env node\n${"x".repeat(1200)}`, { mode: 0o755 })
  ];
  return gzipSync(Buffer.concat([...defaults, ...entries, Buffer.alloc(1024)]));
}

test("accepts the exact CLI package contract", () => {
  const result = verifyTarballContract(archive(), sourceManifest, "agent-plugin-ci-cli-1.2.3.tgz");
  assert.deepEqual(result.entries.map((entry) => entry.path).sort(), ["package/dist/index.cjs", "package/package.json"]);
});

test("rejects unexpected files and non-regular archive members", () => {
  assert.throws(
    () => verifyTarballContract(archive([tarEntry("package/source.ts", "leak")]), sourceManifest, "agent-plugin-ci-cli-1.2.3.tgz"),
    /archive contents does not match/
  );
  assert.throws(
    () => verifyTarballContract(gzipSync(Buffer.concat([
      tarEntry("package/package.json", JSON.stringify(packagedManifest())),
      tarEntry("package/dist/index.cjs", "", { mode: 0o755, type: "2" }),
      Buffer.alloc(1024)
    ])), sourceManifest, "agent-plugin-ci-cli-1.2.3.tgz"),
    /is not a regular file/
  );
  assert.throws(
    () => verifyTarballContract(gzipSync(Buffer.concat([
      tarEntry("package/package.json", JSON.stringify(packagedManifest())),
      tarEntry("package/dist/index.cjs", `#!/usr/bin/env node\n${"x".repeat(1200)}`, { mode: 0o4755 }),
      Buffer.alloc(1024)
    ])), sourceManifest, "agent-plugin-ci-cli-1.2.3.tgz"),
    /special permission bits/
  );
});

test("rejects unsafe paths and incorrect release metadata", () => {
  assert.throws(
    () => verifyTarballContract(gzipSync(Buffer.concat([tarEntry("package/../escape", "bad"), Buffer.alloc(1024)])), sourceManifest, "agent-plugin-ci-cli-1.2.3.tgz"),
    /unsafe archive member path/
  );
  const wrongMetadata = gzipSync(Buffer.concat([
    tarEntry("package/package.json", JSON.stringify(packagedManifest({ repository: { type: "git", url: "https://example.com/wrong.git" } }))),
    tarEntry("package/dist/index.cjs", `#!/usr/bin/env node\n${"x".repeat(1200)}`, { mode: 0o755 }),
    Buffer.alloc(1024)
  ]));
  assert.throws(
    () => verifyTarballContract(wrongMetadata, sourceManifest, "agent-plugin-ci-cli-1.2.3.tgz"),
    /metadata field repository/
  );
  assert.throws(
    () => verifyTarballContract(
      archive([], { scripts: { ...sourceManifest.scripts, publish: "node leak.js" } }),
      sourceManifest,
      "agent-plugin-ci-cli-1.2.3.tgz"
    ),
    /publish lifecycle script/
  );
});

test("writes and rechecks one portable checksum while rejecting artifact leakage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentplugin-package-test-"));
  const artifactsDir = join(root, "artifacts");
  const manifestPath = join(root, "package.json");
  await mkdir(artifactsDir);
  await writeFile(manifestPath, JSON.stringify(sourceManifest));
  const bytes = archive();
  await writeFile(join(artifactsDir, "agent-plugin-ci-cli-1.2.3.tgz"), bytes);

  await verifyCliPackage({ artifactsDir, sourceManifestPath: manifestPath, checksumMode: "write" });
  const expected = `${createHash("sha256").update(bytes).digest("hex")}  agent-plugin-ci-cli-1.2.3.tgz\n`;
  assert.equal(await readFile(join(artifactsDir, "SHA256SUMS"), "ascii"), expected);
  await verifyCliPackage({ artifactsDir, sourceManifestPath: manifestPath, checksumMode: "check" });

  await writeFile(
    join(artifactsDir, "SHA256SUMS"),
    `${"0".repeat(64)}  agent-plugin-ci-cli-1.2.3.tgz\n`,
    "ascii"
  );
  await assert.rejects(
    verifyCliPackage({ artifactsDir, sourceManifestPath: manifestPath, checksumMode: "check" }),
    /SHA256SUMS does not exactly match/
  );
  await writeFile(join(artifactsDir, "SHA256SUMS"), expected, "ascii");

  await writeFile(join(artifactsDir, "unexpected.txt"), "leak");
  await assert.rejects(
    verifyCliPackage({ artifactsDir, sourceManifestPath: manifestPath, checksumMode: "check" }),
    /unexpected artifact entry/
  );
});

test("rejects source metadata drift, lifecycle hooks, and case-insensitive duplicates", () => {
  const sourceWithLeak = { ...sourceManifest, config: { accidental: "secret-like-value" } };
  assert.throws(
    () => verifyTarballContract(
      archive([], { config: sourceWithLeak.config }),
      sourceWithLeak,
      "agent-plugin-ci-cli-1.2.3.tgz"
    ),
    /source package metadata fields/
  );

  const sourceWithHook = {
    ...sourceManifest,
    scripts: { ...sourceManifest.scripts, prepack: "node unexpected.js" }
  };
  assert.throws(
    () => verifyTarballContract(
      archive([], { scripts: sourceWithHook.scripts }),
      sourceWithHook,
      "agent-plugin-ci-cli-1.2.3.tgz"
    ),
    /prepack lifecycle script/
  );

  const duplicateCaseArchive = gzipSync(Buffer.concat([
    tarEntry("package/package.json", JSON.stringify(packagedManifest())),
    tarEntry("package/dist/index.cjs", `#!/usr/bin/env node\n${"x".repeat(1200)}`, { mode: 0o755 }),
    tarEntry("package/DIST/index.cjs", "duplicate", { mode: 0o755 }),
    Buffer.alloc(1024)
  ]));
  assert.throws(
    () => verifyTarballContract(duplicateCaseArchive, sourceManifest, "agent-plugin-ci-cli-1.2.3.tgz"),
    /duplicate archive member/
  );
});
