import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(packageDir, "dist");

await rm(distDir, { recursive: true, force: true });
await build({
  entryPoints: [resolve(packageDir, "src/index.ts")],
  outfile: resolve(distDir, "index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "eof",
  sourcemap: false
});
