import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = await mkdtemp(join(tmpdir(), "email-auth-offline-"));
try {
  const entries = [];
  if (!process.argv.includes("--client-only")) {
    const out = join(dir, "email-auth.test.cjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./email-auth-offline.test.ts", import.meta.url))],
      outfile: out, bundle: true, platform: "node", format: "cjs", target: "node24",
    });
    entries.push(out);
  }
  for (const base of ["/", "/app/"]) {
    for (const enabled of ["false", "true"]) {
      const out = join(dir, `client-${base === "/" ? "root" : "prefix"}-${enabled}.cjs`);
      await build({
        entryPoints: [fileURLToPath(new URL("./email-auth-client.test.ts", import.meta.url))],
        outfile: out, bundle: true, platform: "node", format: "cjs", target: "node24",
        define: {
          "import.meta.env": JSON.stringify({ BASE_URL: base, VITE_EMAIL_AUTH_ENABLED: enabled }),
          TEST_EMAIL_AUTH_BASE: JSON.stringify(base),
        },
      });
      entries.push(out);
    }
  }
  // Do not pass any database, mail or other project credentials to this process.
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...entries], {
    stdio: "inherit", env: { PATH: process.env.PATH, NODE_ENV: "test" },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
