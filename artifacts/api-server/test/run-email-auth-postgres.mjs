import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.env.EMAIL_AUTH_ENABLED !== "true" || process.env.EMAIL_AUTH_MAIL_MODE !== "disabled") {
  throw new Error("Requires explicitly enabled dev auth with real delivery disabled");
}
const dir = await mkdtemp(join(tmpdir(), "auth-dev-postgres-"));
try {
  const out = join(dir, "postgres-test.cjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./email-auth-postgres.test.ts", import.meta.url))],
    outfile: out, bundle: true, platform: "node", format: "cjs", target: "node24",
  });
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", out], {
    stdio: "inherit", env: {
      PATH: process.env.PATH, NODE_ENV: "test", AUTH_DEV_TESTS_APPROVED: "true",
      DATABASE_URL: process.env.DATABASE_URL, SESSION_SECRET: process.env.SESSION_SECRET,
      AUTH_PUBLIC_URL: process.env.AUTH_PUBLIC_URL,
      AUTH_BROWSER_FIXTURE_FILE: join(process.cwd(), "generated-artifacts/email-auth-browser-fixture.json"),
    },
  });
  process.exitCode = result.status ?? 1;
} finally { await rm(dir, { recursive: true, force: true }); }
