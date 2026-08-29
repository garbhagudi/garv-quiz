/**
 * Run the app locally against Postgres in Docker.
 *
 *   docker compose up -d
 *   npm run dev:local
 *
 * The app talks to Postgres over HTTPS rather than the usual port-5432 protocol,
 * because that is what works on Vercel. This starts a small translator in front
 * of your container, runs `npm run db:setup` against it, then starts `next dev`.
 *
 * Everything above the driver is the real application — same routes, same SQL,
 * same sessions as production. When you are ready to use Neon instead, put
 * DATABASE_URL and SESSION_SECRET in `.env.local` and run `npm run dev`.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startNeonEmulator, postgresBackend } from "./neon-http-emulator.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 3001 so this can run beside the GGIRHR quiz on 3000.
const port = Number(process.env.PORT ?? 3001);

// Must match docker-compose.yml.
const pgPort = Number(process.env.LOCAL_PG_PORT ?? 5433);
const PG_URL =
  process.env.LOCAL_PG_URL ?? `postgres://quiz:quiz@127.0.0.1:${pgPort}/garv_quiz`;

// The translator listens here; any spare port will do.
const bridgePort = Number(process.env.LOCAL_BRIDGE_PORT ?? 5452);

const ADMIN = {
  email: process.env.SEED_ADMIN_EMAIL ?? "admin@garbhagudi.com",
  password: process.env.SEED_ADMIN_PASSWORD ?? "LocalDevPassword!2026",
  name: process.env.SEED_ADMIN_NAME ?? "Local Admin",
};

// A fixed secret so your sign-in survives a restart. Local only — production
// reads SESSION_SECRET from the environment.
const SESSION_SECRET =
  process.env.SESSION_SECRET ?? "local-development-session-secret-do-not-use-in-production-01";

const line = (s = "") => console.log(s);

/* ------------------------- connect to the container ---------------------- */

line();
line(`  Connecting to Postgres at 127.0.0.1:${pgPort} …`);

let backend;
try {
  backend = await postgresBackend(PG_URL);
  await backend.query("SELECT 1");
} catch (e) {
  line();
  line(`  Could not reach Postgres at 127.0.0.1:${pgPort}.`);
  line(`  ${e.message}`);
  line();
  line("  Start it with:");
  line("    docker compose up -d");
  line();
  line("  If your container uses a different port, user or password, set:");
  line('    LOCAL_PG_URL="postgres://user:password@127.0.0.1:5433/dbname"');
  line();
  process.exit(1);
}

let emulator;
try {
  emulator = await startNeonEmulator({ backend, port: bridgePort });
} catch (e) {
  if (e.code === "EADDRINUSE") {
    line();
    line(`  Port ${bridgePort} is already in use. Either stop what is holding it, or:`);
    line(`    LOCAL_BRIDGE_PORT=${bridgePort + 1} npm run dev:local`);
    line();
    process.exit(1);
  }
  throw e;
}

line("  Connected.");

const childEnv = {
  ...process.env,
  // The connection string is only parsed for its shape; the endpoint below is
  // what actually gets called.
  DATABASE_URL: PG_URL,
  DATABASE_HTTP_ENDPOINT: emulator.endpoint,
  SESSION_SECRET,
  SEED_ADMIN_EMAIL: ADMIN.email,
  SEED_ADMIN_PASSWORD: ADMIN.password,
  SEED_ADMIN_NAME: ADMIN.name,
};

/* --------------------- run the normal setup script ---------------------- */

await new Promise((resolve, reject) => {
  const setup = spawn(process.execPath, [join(root, "scripts", "setup-db.mjs")], {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
  });
  setup.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`db:setup exited with code ${code}`)),
  );
});

/* ----------------------------- next dev --------------------------------- */

const next = spawn(
  process.execPath,
  [join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(port)],
  { cwd: root, env: childEnv, stdio: "inherit" },
);

line();
line("  ────────────────────────────────────────────────────────────");
line(`  Students   http://localhost:${port}          then the code: demo`);
line(`  Staff      http://localhost:${port}/admin/login`);
line(`             ${ADMIN.email}`);
line(`             ${ADMIN.password}`);
line("  ────────────────────────────────────────────────────────────");
line("  Data lives in the Docker volume. `docker compose down -v` wipes it.");
line("  Ctrl-C to stop.");
line();

/* ------------------------------ shutdown -------------------------------- */

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  next.kill();
  await emulator.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
next.on("exit", shutdown);
