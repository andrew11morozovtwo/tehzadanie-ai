import { defineConfig } from "drizzle-kit";
import path from "node:path";

// Offline baseline for source-to-source review, NOT an introspection or migration.
export default defineConfig({
  dialect: "postgresql",
  schema: path.resolve(__dirname, "../src/schema/index.ts"),
  out: "../../generated-artifacts/email-auth-schema-review",
});
