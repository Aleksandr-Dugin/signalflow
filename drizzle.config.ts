import { defineConfig } from "drizzle-kit";
import { poolConfig } from "./server/_core/dbConnection";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

// The same resolver the running app uses, so `pnpm db:migrate` can reach a
// TLS-only endpoint (TiDB Cloud) that the app can reach. Passing `url` alone
// would make the migrator fail against a database the server talks to daily.
const { host, port, user, password, database, ssl } = poolConfig(connectionString);

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    host,
    port,
    user,
    password,
    database,
    ...(ssl ? { ssl } : {}),
  },
});
