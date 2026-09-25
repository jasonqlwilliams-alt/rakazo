import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";
import { guardPrismaCommand } from "./src/database-guard.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(here, "../../.env");
if (existsSync(rootEnv)) config({ path: rootEnv });
config();

// No fallback URL: a command without DATABASE_URL must fail, not guess a database.
await guardPrismaCommand(process.argv.slice(2), process.env);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
