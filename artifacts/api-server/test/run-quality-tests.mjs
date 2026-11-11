import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = await mkdtemp(join(tmpdir(), "brief-quality-"));
try {
  const out = join(dir, "quality.test.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./brief-quality.test.ts", import.meta.url))],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });
  const result = spawnSync(process.execPath, ["--test", out], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
