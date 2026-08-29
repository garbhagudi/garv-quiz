import { neon, neonConfig } from "@neondatabase/serverless";

type NeonClient = ReturnType<typeof neon>;

/**
 * The app is misconfigured — a wrong or missing environment variable, not a bad
 * request. `route()` reports these verbatim instead of flattening them into
 * "something went wrong", because the person who can fix it needs to read it.
 */
export class ConfigError extends Error {
  readonly isConfigError = true;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

let client: NeonClient | null = null;

function connect(): NeonClient {
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url)
    throw new ConfigError(
      "DATABASE_URL is not set. Add your Neon pooled connection string to .env.local " +
        "(locally) or to the Vercel project's environment variables, then redeploy.",
    );

  // Local development only. The driver otherwise derives its endpoint from the
  // connection string as `https://<host>/sql`, which pins it to port 443 and to
  // whatever the hostname resolves to. Setting this points it at a Postgres-over-
  // HTTP endpoint you run yourself (see `npm run dev:local`). Never set it in
  // production — Neon's own endpoint is the right one there.
  const endpoint = process.env.DATABASE_HTTP_ENDPOINT;
  if (endpoint) neonConfig.fetchEndpoint = endpoint;

  assertUsableConnectionString(url, endpoint);

  client = neon(url);
  return client;
}

/**
 * This driver speaks SQL over HTTPS, not the Postgres wire protocol, so a
 * connection string pointing at a Postgres server on this machine cannot work —
 * the driver would ask `https://localhost/sql` for it. Left unchecked that
 * surfaces much later as a bare "fetch failed", which says nothing useful, so
 * catch it here and name the actual fix.
 */
function assertUsableConnectionString(url: string, endpoint: string | undefined) {
  let host: string;
  try {
    const parsed = new URL(url);
    if (!/^postgres(ql)?:$/.test(parsed.protocol))
      throw new ConfigError(
        `DATABASE_URL should start with "postgresql://" but starts with "${parsed.protocol}". ` +
          `Check for a stray "DATABASE_URL=" inside the value itself.`,
      );
    host = parsed.hostname;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(
      "DATABASE_URL is not a valid connection string. It should look like:\n" +
        "  postgresql://user:password@ep-something-pooler.region.aws.neon.tech/neondb?sslmode=require",
    );
  }

  // With DATABASE_HTTP_ENDPOINT set, the host in the URL is not dialled at all,
  // so a local-looking host is expected and fine.
  if (endpoint) return;

  const isLocal =
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host);

  if (isLocal)
    throw new ConfigError(
      `DATABASE_URL points at "${host}", a database on this machine, but this app talks to ` +
        `Postgres over HTTPS rather than the usual port-5432 protocol — so it cannot reach it.\n\n` +
        `For local development, use:  docker compose up -d  &&  npm run dev:local\n` +
        `That sets up the connection for you. Keep DATABASE_URL for your Neon string, ` +
        `which is what "npm run dev" and Vercel use.`,
    );
}

/**
 * Tagged-template query helper backed by Neon's HTTP driver.
 *
 *   const rows = await sql`SELECT * FROM organizations WHERE id = ${id}`;
 *
 * Interpolations are always sent as bound parameters, never string-concatenated,
 * so this is safe against injection. There is no connection pool to manage —
 * each call is one HTTPS request, which is what makes it work on Vercel.
 *
 * The connection is created on first use rather than at import time, so a
 * missing DATABASE_URL surfaces as a clear error on the request that needs the
 * database instead of breaking the build.
 */
export const sql = new Proxy(function noop() {} as unknown as NeonClient, {
  apply: (_target, _thisArg, args: unknown[]) =>
    (connect() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_target, prop: string | symbol) =>
    (connect() as unknown as Record<string | symbol, unknown>)[prop],
}) as NeonClient;
