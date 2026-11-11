import { defineConfig } from "drizzle-kit";
import path from "node:path";

// generate only: no connection string, no access to either database.
export default defineConfig({
  dialect: "postgresql",
  schema: path.resolve(__dirname, "verified-email.schema.ts"),
  // drizzle-kit 0.31 snapshot loader prepends "./"; out must be relative to lib/db.
  out: "../../generated-artifacts/email-auth-schema-review",
});
