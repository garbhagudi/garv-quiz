/**
 * A local stand-in for Neon's SQL-over-HTTP endpoint.
 *
 * The app talks to Postgres over HTTPS rather than the usual port-5432 protocol,
 * because that is what works on Vercel. A database on your own machine speaks
 * port 5432, so this sits between the two and translates. The app itself needs
 * no changes: `DATABASE_HTTP_ENDPOINT` points the driver here instead of at Neon.
 *
 * Two backends:
 *   postgresBackend(url)  a real Postgres - your Docker container (npm run dev:local)
 *   pgliteBackend()       Postgres compiled to WebAssembly, in this process,
 *                         needing nothing installed (the test scripts)
 *
 * Development tooling only. None of this ships to Vercel.
 *
 * Protocol (from @neondatabase/serverless):
 *   POST /sql  {query, params}                  -> {fields:[{name,dataTypeID}], rows:[[...]]}
 *   POST /sql  {queries:[{query,params}, ...]}  -> {results:[ ...same... ]}
 *   errors                                      -> HTTP 400 {message}
 * With `Neon-Array-Mode: true` and `Neon-Raw-Text-Output: true`, rows come back
 * as arrays of text, which the driver then parses itself.
 */
import { createServer } from "node:http";

/** Values must reach the driver as the raw text Postgres produced, not as JS values. */
const asText = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "boolean") return v ? "t" : "f";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/* ------------------------- backend: real Postgres ------------------------ */

/**
 * Talks to a Postgres server - your Docker container. Type parsing is disabled
 * so values arrive as text; the app's driver parses them at the other end,
 * exactly as it would with Neon.
 */
export async function postgresBackend(connectionString) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 4 });

  // Identity parsers for every type, so `pg` hands back raw strings.
  const rawTypes = { getTypeParser: () => (v) => v };

  const run = async (runner, query, params) => {
    const res = await runner.query({
      text: query,
      values: params ?? [],
      rowMode: "array",
      types: rawTypes,
    });
    return {
      fields: (res.fields ?? []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: (res.rows ?? []).map((row) => row.map(asText)),
      rowCount: res.rowCount ?? 0,
      command: res.command ?? "SELECT",
    };
  };

  return {
    label: "Postgres",
    query: (query, params) => run(pool, query, params),
    /** One checked-out connection, so BEGIN and COMMIT land on the same session. */
    async transaction(queries) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const results = [];
        for (const q of queries) results.push(await run(client, q.query, q.params));
        await client.query("COMMIT");
        return results;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/* --------------------------- backend: PGlite ----------------------------- */

/** Postgres compiled to WebAssembly, running in this process. Used by the tests. */
export async function pgliteBackend(dataDir) {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;

  // PGlite parses per type id, so identity parsers are listed explicitly.
  const RAW_TEXT_OIDS = [
    16, 17, 18, 19, 20, 21, 23, 25, 26, 114, 142, 600, 700, 701, 790, 829, 869,
    1000, 1001, 1005, 1007, 1009, 1014, 1015, 1016, 1021, 1022, 1042, 1043,
    1082, 1083, 1114, 1115, 1182, 1184, 1185, 1186, 1231, 1266, 1700, 2950,
    2951, 3802, 3807,
  ];
  const parsers = Object.fromEntries(RAW_TEXT_OIDS.map((oid) => [oid, (v) => v]));

  const run = async (query, params) => {
    const res = await db.query(query, params ?? [], { rowMode: "array", parsers });
    return {
      fields: (res.fields ?? []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: (res.rows ?? []).map((row) => row.map(asText)),
      rowCount: res.rowCount ?? res.affectedRows ?? 0,
      command: res.command ?? "SELECT",
    };
  };

  return {
    label: "PGlite",
    db, // the test scripts seed and inspect directly through this
    query: run,
    async transaction(queries) {
      await db.query("BEGIN");
      try {
        const results = [];
        for (const q of queries) results.push(await run(q.query, q.params));
        await db.query("COMMIT");
        return results;
      } catch (e) {
        await db.query("ROLLBACK").catch(() => {});
        throw e;
      }
    },
    close: () => db.close(),
  };
}

/* ------------------------------- the server ------------------------------ */

/**
 * @param {object} opts
 * @param {object} opts.backend  from postgresBackend() or pgliteBackend()
 * @param {number} [opts.port]   any spare port
 * @param {string} [opts.host]   loopback only - this speaks unauthenticated SQL
 *                               and must never be reachable from off the machine
 */
export async function startNeonEmulator({ backend, port = 5442, host = "127.0.0.1", log = false }) {
  if (!backend) throw new Error("startNeonEmulator needs a backend");

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(text),
        });
        res.end(text);
      };

      try {
        const parsed = JSON.parse(body || "{}");

        // sql.transaction([...]) - run as one real transaction, so a failure
        // rolls the whole submission back exactly as it would on Neon.
        if (Array.isArray(parsed.queries)) {
          if (log) console.log(`  [db] batch of ${parsed.queries.length}`);
          return send(200, { results: await backend.transaction(parsed.queries) });
        }

        if (typeof parsed.query !== "string") return send(400, { message: "no query" });
        if (log) console.log(`  [db] ${parsed.query.replace(/\s+/g, " ").slice(0, 110)}`);
        return send(200, await backend.query(parsed.query, parsed.params));
      } catch (e) {
        // The driver turns a 400 with {message} into a thrown error whose message
        // the app's route wrapper inspects (to spot unique-constraint violations).
        if (log) console.log(`  [db] ERROR ${e.message}`);
        return send(400, { message: String(e.message ?? e), code: e.code ?? undefined });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE") {
        // Callers check `.code` to print their own advice, so keep it attached.
        const wrapped = new Error(`${host}:${port} is already in use.`);
        wrapped.code = e.code;
        return reject(wrapped);
      }
      reject(e);
    });
    server.listen(port, host, resolve);
  });

  return {
    endpoint: `http://${host}:${port}/sql`,
    db: backend.db,
    backend,
    async close() {
      await new Promise((r) => server.close(r));
      await backend.close();
    },
  };
}
