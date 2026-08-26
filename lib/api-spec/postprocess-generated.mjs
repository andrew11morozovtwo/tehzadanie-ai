import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const generatedZodApi = resolve(root, "lib", "api-zod", "src", "generated", "api.ts");
const zodIndex = resolve(root, "lib", "api-zod", "src", "index.ts");

const source = await readFile(generatedZodApi, "utf8");
await writeFile(
  generatedZodApi,
  source.replace("import * as zod from 'zod';", "import * as zod from 'zod/v4';"),
);
await writeFile(zodIndex, 'export * from "./generated/api";\n');