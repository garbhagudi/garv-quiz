/**
 * End-to-end test of the real built app.
 *
 *   npm run e2e
 *
 * It builds into its own directory (`.next-e2e`) and runs its database on its own
 * port, so it is safe to run while `npm run dev` or `npm run dev:local` is up.
 *
 * It starts the actual Next server against a local Neon-HTTP emulator backed by
 * PGlite, then plays through the whole product over HTTP: a student registers,
 * answers and is thanked; an admin signs in, edits
 * questions, reads results and exports the workbook; and the permission and
 * anti-cheat rules are pushed on to confirm they hold.
 *
 * It needs nothing installed: the database runs in-process (Postgres compiled
 * to WebAssembly), so this works on any machine with no Docker and no network.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import bcrypt from "bcryptjs";
import { startNeonEmulator, pgliteBackend } from "./neon-http-emulator.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3158;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { email: "owner@garbhagudi.com", password: "OwnerPassword!2026" };
// The suite runs its own database on an ordinary port and tells the driver where
// to find it, so it never collides with a `npm run dev:local` already running.
const DB_PORT = 5453;
const DB_ENDPOINT = `http://127.0.0.1:${DB_PORT}/sql`;
// Its own build directory, so a test run never disturbs a running dev server.
const DIST_DIR = ".next-e2e";

/* ----------------------------- tiny test rig ----------------------------- */

let passed = 0;
const failures = [];
let group = "";

const section = (name) => {
  group = name;
  console.log(`\n  ${name}`);
};

async function test(label, fn) {
  try {
    const note = await fn();
    passed++;
    console.log(`    ok    ${label}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    failures.push({ group, label, message: e.message });
    console.log(`    FAIL  ${label}\n          ${e.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, what = "value") {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/* ------------------------------- cookie jars ----------------------------- */

/** A browser-ish client: keeps cookies, returns status + parsed body. */
function client(name) {
  const jar = new Map();
  return {
    name,
    jar,
    cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    async call(path, { method = "GET", body, redirect = "follow", raw = false } = {}) {
      const headers = {};
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect,
      });

      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(";");
        const idx = pair.indexOf("=");
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        // An expired/blanked cookie is a sign-out.
        if (!v || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(k);
        else jar.set(k, v);
      }

      if (raw) return { status: res.status, res };
      const type = res.headers.get("content-type") ?? "";
      const data = type.includes("json") ? await res.json() : await res.text();
      return { status: res.status, data, headers: res.headers };
    },
  };
}

/* -------------------------------- fixtures ------------------------------- */

function statements(text) {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const QUESTIONS = Array.from({ length: 15 }, (_, i) => ({
  text: `Seed question ${i + 1}: which option is right?`,
  options: [`w${i}a`, `w${i}b`, `right-${i}`, `w${i}c`],
  correct: 2,
}));

async function seed(db) {
  for (const s of statements(readFileSync(join(root, "db", "schema.sql"), "utf8")))
    await db.exec(s);

  const set = await db.query(
    `INSERT INTO question_sets (name, description) VALUES ('Embryology','seed') RETURNING id`,
  );
  const setId = set.rows[0].id;
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    await db.query(
      `INSERT INTO questions (set_id, position, text, options, correct_index, points)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
      [setId, i, q.text, JSON.stringify(q.options), q.correct, i === 14 ? 2 : 1],
    );
  }
  await db.query(
    `INSERT INTO organizations (slug, name, city, question_set_id) VALUES ('demo','Demo College','Bengaluru',$1)`,
    [setId],
  );
  await db.query(
    `INSERT INTO admin_users (email, password_hash, name, role) VALUES ($1,$2,'Owner','owner')`,
    [ADMIN.email, await bcrypt.hash(ADMIN.password, 10)],
  );
  return setId;
}

/** The stored snapshot for one attempt — the answer key included. */
async function servedFor(db, attemptId) {
  const r = await db.query(`SELECT served FROM attempts WHERE public_id = $1::uuid`, [attemptId]);
  return r.rows[0].served;
}

/**
 * Reads the served snapshot so the harness can play a perfect (or partial)
 * student. Handles both kinds of question: a single-answer one gets one tick, a
 * "select all that apply" one gets its whole key.
 */
/**
 * Skip the five-second lead-in a started round now carries.
 *
 * Start sets the deadline to `now + lead-in + limit`; winding it back by the
 * lead-in leaves a round that began this instant with its full limit intact.
 * The alternative is sleeping five seconds in every test that plays a round.
 */
async function skipLeadIn(db, slug) {
  await db.query(
    `UPDATE organizations SET closes_at = closes_at - interval '5 seconds' WHERE slug = $1`,
    [slug],
  );
}

/**
 * Put a student into a running round the way the product now works.
 *
 * New entries are refused once a round is on, so a player has to be registered
 * while the waiting room is open and then come back for the questions. This
 * opens the room, registers, starts the round, skips the lead-in, and returns
 * the second call - the one that carries the questions.
 */
async function joinViaWaitingRoom(admin, db, c, orgId, slug, body) {
  await admin.call(`/api/admin/organizations/${orgId}`, {
    method: "PATCH",
    body: { isOpen: true },
  });
  const lobby = await c.call("/api/quiz/start", { method: "POST", body: { slug, ...body } });
  if (lobby.status !== 200) return lobby;
  await admin.call(`/api/admin/organizations/${orgId}`, {
    method: "PATCH",
    body: { startRound: true },
  });
  await skipLeadIn(db, slug);
  return c.call("/api/quiz/start", { method: "POST", body: { slug, ...body } });
}

async function answersFor(db, attemptId, correctCount = 99) {
  const served = await servedFor(db, attemptId);
  return served.map((q) => {
    const key = q.cis?.length ? q.cis : [q.ci];
    // Deliberately answer wrongly once the quota of correct answers runs out:
    // shifting every tick by one is wrong for a single and a multi alike.
    const wrong = key.map((i) => (i + 1) % q.opts.length);
    return {
      position: q.p,
      optionIndexes: q.p < correctCount ? key : wrong,
      ms: 1000 + q.p * 10,
    };
  });
}

/** Posts one file as multipart/form-data, carrying a client's cookies. */
async function uploadTo(c, path, { name, mime, bytes }) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), name);
  const headers = {};
  const cookie = c.cookieHeader();
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method: "POST", headers, body: form });
  const type = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    data: type.includes("json") ? await res.json() : await res.text(),
  };
}

/* ================================= run ================================== */

const emu = await startNeonEmulator({ backend: await pgliteBackend(), port: DB_PORT });
console.log(`\n  Database bridge listening on port ${DB_PORT} (PGlite, in-process)`);

const setId = await seed(emu.db);
console.log(`  Seeded: 1 question set (${QUESTIONS.length} questions), organization "demo", owner account`);

const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");

const childEnv = {
  ...process.env,
  NEXT_DIST_DIR: DIST_DIR,
  DATABASE_URL: "postgresql://user:pass@localhost/neondb?sslmode=require",
  DATABASE_HTTP_ENDPOINT: DB_ENDPOINT,
  SESSION_SECRET: "e2e-session-secret-that-is-definitely-long-enough-0123456789",
};

// Build here rather than relying on the caller, so `npm run e2e` always tests the
// current source and always writes to its own directory.
console.log(`  Building into ${DIST_DIR}/ …`);
await new Promise((resolve, reject) => {
  const build = spawn(process.execPath, [nextBin, "build"], {
    cwd: root,
    env: { ...childEnv, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  build.stdout.on("data", (d) => (out += d));
  build.stderr.on("data", (d) => (out += d));
  build.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`next build failed:\n${out.slice(-3000)}`)),
  );
});

const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
  cwd: root,
  env: { ...childEnv, NODE_ENV: "production", PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/api/public/organization?code=demo");
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not start in ${timeoutMs}ms:\n${serverLog}`);
}

async function finish(code) {
  server.kill();
  await emu.close().catch(() => {});
  console.log(
    `\n  ${failures.length ? "FAILED" : "All good"}: ${passed} passed, ${failures.length} failed\n`,
  );
  if (failures.length) {
    for (const f of failures) console.log(`  [${f.group}] ${f.label}\n      ${f.message}`);
    if (serverLog.trim()) console.log(`\n  --- server log ---\n${serverLog.slice(-3000)}`);
  }
  process.exit(code ?? (failures.length ? 1 : 0));
}

try {
  await waitForServer();
  console.log(`  Next server up on ${BASE}\n`);

  /* ====================== 1. the student's journey ===================== */
  section("Student — landing and registration");

  const asha = client("asha");

  await test("home page renders and asks for a code", async () => {
    const { status, data } = await asha.call("/");
    eq(status, 200, "status");
    assert(data.includes("Quiz Challenge"), "page does not mention the quiz");
    assert(data.includes("Event code"), "page does not ask for a code");
  });

  await test("a valid code resolves to the event", async () => {
    const { status, data } = await asha.call("/api/public/organization?code=demo");
    eq(status, 200, "status");
    eq(data.organization.name, "Demo College", "organization name");
    eq(data.organization.questionCount, 15, "question count");
    eq(data.organization.isOpen, true, "isOpen");
    return `${data.organization.questionCount} questions, open`;
  });

  await test("an unknown code is a clean 404, not a crash", async () => {
    const { status, data } = await asha.call("/api/public/organization?code=not-a-organization");
    eq(status, 404, "status");
    assert(data.error.includes("No event found"), `unhelpful message: ${data.error}`);
  });

  await test("the organization page renders for a real code", async () => {
    const { status, data } = await asha.call("/s/demo");
    eq(status, 200, "status");
    assert(data.includes("Demo College"), "organization name missing from the page");
    assert(data.includes("Mobile number"), "registration form missing");
  });

  await test("an unknown organization URL renders the not-found page", async () => {
    const { status } = await asha.call("/s/nope");
    eq(status, 404, "status");
  });

  await test("registration rejects a bad mobile number", async () => {
    const { status, data } = await asha.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Asha Rao", phone: "12345", email: "asha@x.com" },
    });
    eq(status, 422, "status");
    eq(data.field, "phone", "field");
  });

  await test("registration rejects a one-letter name", async () => {
    const { status, data } = await asha.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "A", phone: "9800000001", email: "asha@x.com" },
    });
    eq(status, 422, "status");
    assert(data.error.toLowerCase().includes("name"), `message was: ${data.error}`);
  });

  await test("registration rejects a missing email when the event requires one", async () => {
    const { status } = await asha.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Asha Rao", phone: "9800000001", email: "" },
    });
    eq(status, 422, "status");
  });

  let ashaAttempt;
  await test("registration succeeds and returns the questions", async () => {
    const { status, data } = await asha.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Asha Rao", phone: "9800000001", email: "asha@x.com" },
    });
    eq(status, 200, "status");
    eq(data.questions.length, 15, "question count");
    ashaAttempt = data.attemptId;
    assert(/^[0-9a-f-]{36}$/.test(ashaAttempt), `attemptId is not a uuid: ${ashaAttempt}`);
    return `attempt ${ashaAttempt.slice(0, 8)}…`;
  });

  await test("the answer key never reaches the browser", async () => {
    // A separate client, so this probe does not overwrite Asha's session cookie.
    const probe = client("probe");
    const { data } = await probe.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Probe P", phone: "9899999999", email: "p@x.com" },
    });
    const serialised = JSON.stringify(data);
    for (const q of data.questions) {
      assert(!("ci" in q), "a question carried its correct-answer index");
      assert(!("correct" in q), "a question carried a `correct` field");
    }
    assert(!/"ci":/.test(serialised), "the payload contains a `ci` field somewhere");
    return "no `ci` / `correct` anywhere in the payload";
  });

  await test("a second student cannot register with an address already in use", async () => {
    const c = client("email-clash");
    const { status, data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Copycat C", phone: "9866000001", email: "asha@x.com" },
    });
    eq(status, 409, "status");
    eq(data.field, "email", "field");
    assert(
      data.error.toLowerCase().includes("email"),
      `the message does not mention the email: ${data.error}`,
    );
    return `refused: ${data.error}`;
  });

  await test("the address check ignores case and spacing", async () => {
    const c = client("email-clash-2");
    const { status, data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Shouty S", phone: "9866000002", email: "  ASHA@X.COM " },
    });
    eq(status, 409, "status");
    eq(data.field, "email", "field");
    return "ASHA@X.COM is the same address as asha@x.com";
  });

  section("Student — answering and scoring");

  await test("a perfect submission scores full marks", async () => {
    const answers = await answersFor(emu.db, ashaAttempt);
    const { status, data } = await asha.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: ashaAttempt, answers, elapsedMs: 40_000 },
    });
    eq(status, 200, "status");
    eq(data.correctCount, 15, "correctCount");
    eq(data.score, 16, "score (question 15 is worth 2 points)");
    eq(data.maxScore, 16, "maxScore");
    return `${data.score}/${data.maxScore}`;
  });

  await test("re-submitting returns the first result instead of double-counting", async () => {
    const answers = await answersFor(emu.db, ashaAttempt, 0); // all wrong this time
    const { status, data } = await asha.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: ashaAttempt, answers, elapsedMs: 1000 },
    });
    eq(status, 200, "status");
    eq(data.alreadySubmitted, true, "alreadySubmitted");
    eq(data.score, 16, "score is unchanged by the replay");
    const rows = await emu.db.query(
      `SELECT count(*)::int n FROM answers a JOIN attempts t ON t.id = a.attempt_id
        WHERE t.public_id = $1::uuid`,
      [ashaAttempt],
    );
    eq(rows.rows[0].n, 15, "answer rows after the replay");
    return "score held, no duplicate answer rows";
  });

  await test("a forged submission cannot award points", async () => {
    const cheat = client("cheat");
    const { data } = await cheat.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Cheat C", phone: "9888888888", email: "c@x.com" },
    });
    const bogus = data.questions.map((q) => ({ position: q.p, optionIndex: 0, ms: 1 }));
    // Also try to smuggle a score in, which the server must ignore entirely.
    const res = await cheat.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: data.attemptId, answers: bogus, score: 999, correctCount: 15 },
    });
    assert(res.data.score < 16, `a blind all-A run scored ${res.data.score}`);
    const row = await emu.db.query(`SELECT score FROM attempts WHERE public_id = $1::uuid`, [
      data.attemptId,
    ]);
    assert(Number(row.rows[0].score) < 16, "the smuggled score reached the database");
    return `scored ${res.data.score}, not 999`;
  });

  await test("a submission for an unknown attempt is refused", async () => {
    const { status } = await asha.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: "00000000-0000-4000-8000-000000000000", answers: [] },
    });
    eq(status, 404, "status");
  });

  await test("one mobile number cannot play twice while retakes are off", async () => {
    const { status, data } = await asha.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Asha Rao", phone: "9800000001", email: "asha@x.com" },
    });
    eq(status, 409, "status");
    assert(data.error.includes("already played"), `message was: ${data.error}`);
    // Sending her own address back must trip the retake rule, not the rule
    // against two students sharing one address.
    eq(data.field, "phone", "the address rule fired against the student's own row");
  });

  await test("the server times the run itself and records the streak", async () => {
    const c = client("ranking-inputs");
    const started = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Ranking Inputs", phone: "9800000021", email: "rank@x.com" },
    });
    eq(started.status, 200, "registered");
    const id = started.data.attemptId;

    // Answer the first three correctly, miss the fourth, take the fifth: the
    // longest run is 3, which is not the same as the 4 answered correctly.
    const served = await servedFor(emu.db, id);
    const answers = served.map((q, i) => {
      const key = q.cis?.length ? q.cis : [q.ci];
      const right = i < 3 || i === 4;
      return {
        position: q.p,
        optionIndexes: right ? key : key.map((k) => (k + 1) % q.opts.length),
        ms: 1, // the phone claims one millisecond a question
      };
    });
    // Age the attempt so the measurement is unambiguous: locally the whole
    // round trip takes a few milliseconds, which is the same order as the
    // phone's fake claim and would prove nothing either way.
    await emu.db.query(
      `UPDATE attempts SET started_at = now() - interval '30 seconds' WHERE public_id = $1`,
      [id],
    );

    const { status, data } = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: id, answers, elapsedMs: 1 },
    });
    eq(status, 200, "submitted");

    const [row] = (
      await emu.db.query(
        `SELECT answer_ms, server_ms, best_streak, correct_count FROM attempts WHERE public_id = $1`,
        [id],
      )
    ).rows;

    eq(row.answer_ms, served.length, "the phone's claim is stored as sent");
    eq(row.best_streak, 3, "longest run of correct answers");
    assert(row.correct_count > row.best_streak, "the streak must not just be the correct count");
    // The phone claimed one millisecond a question. The server had them on the
    // page for thirty seconds and ranks on that, whatever the payload says.
    assert(
      row.server_ms >= 29_000 && row.server_ms <= 40_000,
      `server_ms was ${row.server_ms}, expected about 30000 whatever the phone claimed`,
    );
    assert(
      row.server_ms > row.answer_ms * 100,
      `the claimed ${row.answer_ms}ms still drove the stored time`,
    );
    eq(data.answerMs, row.answer_ms, "the finish screen still shows their own answering time");

    // Only here to be measured; the admin counts below are asserted exactly.
    await emu.db.query(`DELETE FROM participants WHERE phone = '9800000021'`);
    return `claimed ${row.answer_ms}ms, server saw ${row.server_ms}ms, streak ${row.best_streak}`;
  });

  await test("the student-facing leaderboard and dashboard are gone", async () => {
    for (const path of [
      "/api/quiz/leaderboard?code=demo",
      "/api/me",
      "/s/demo/dashboard",
    ]) {
      const { status } = await asha.call(path, { redirect: "manual", raw: true });
      eq(status, 404, `${path} status`);
    }
    return "3 routes removed";
  });

  await test("a finished student is told their score and their time, and no rank", async () => {
    // Replay one student end to end and read exactly what the finish screen gets.
    const c = client("finish-screen");
    const started = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Finish Screen", phone: "9800000009", email: "fin@x.com" },
    });
    eq(started.status, 200, "registered");
    const answers = await answersFor(emu.db, started.data.attemptId, 5);
    const { status, data } = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: started.data.attemptId, answers, elapsedMs: 9_000 },
    });
    eq(status, 200, "status");

    assert(typeof data.score === "number", "no score to show");
    assert(typeof data.maxScore === "number", "no total to show");
    assert(typeof data.answerMs === "number" && data.answerMs > 0, "no time to show");

    // Nothing that would tell them where they placed, or anything about anybody
    // else: winners are the host's to announce.
    const text = JSON.stringify(data);
    for (const leak of ["rank", "leaderboard", "showLeaderboard", "top", "position"]) {
      assert(!text.includes(leak), `the finish payload exposed "${leak}"`);
    }
    assert(!c.jar.has("gg_participant"), "playing must no longer leave an identity cookie");

    // This student exists only to read the finish screen; the admin views below
    // count what played, so take them back out for real rather than soft-delete.
    await emu.db.query(`DELETE FROM participants WHERE phone = '9800000009'`);
    return `score ${data.score}/${data.maxScore}, time ${data.answerMs}ms, no rank`;
  });

  /* ------------- a field of students, for the admin views ---------------- */
  section("Student — a field of players");

  const field = [
    { name: "Bhavya N", phone: "9800000002", correct: 15, ms: 400 }, // ties Asha, faster
    { name: "Chetan K", phone: "9800000003", correct: 10, ms: 900 },
    { name: "Divya S", phone: "9800000004", correct: 3, ms: 900 },
  ];

  await test("three more students play", async () => {
    for (const s of field) {
      const c = client(s.name);
      const { data } = await c.call("/api/quiz/start", {
        method: "POST",
        body: { slug: "demo", name: s.name, phone: s.phone, email: `${s.phone}@x.com` },
      });
      const answers = (await answersFor(emu.db, data.attemptId, s.correct)).map((a) => ({
        ...a,
        ms: s.ms,
      }));
      const r = await c.call("/api/quiz/submit", {
        method: "POST",
        body: { attemptId: data.attemptId, answers, elapsedMs: s.ms * 15 + 500 },
      });
      eq(r.status, 200, `${s.name} submit status`);
      s.score = r.data.score;
    }
    return field.map((s) => `${s.name.split(" ")[0]} ${s.score}`).join(", ");
  });

  /* ========================= 2. the admin panel ======================== */
  section("Admin — access control");

  const admin = client("admin");

  await test("the admin API refuses an anonymous caller", async () => {
    for (const path of [
      "/api/admin/sets",
      "/api/admin/organizations",
      "/api/admin/questions?setId=1",
      "/api/admin/participants",
      "/api/admin/users",
      "/api/admin/audit",
    ]) {
      const { status } = await admin.call(path);
      eq(status, 401, `${path} status`);
    }
    return "6 endpoints all 401";
  });

  await test("admin pages redirect an anonymous visitor to sign-in", async () => {
    for (const path of ["/admin", "/admin/organizations", "/admin/questions", "/admin/team"]) {
      const { status, res } = await admin.call(path, { redirect: "manual", raw: true });
      assert(status === 307 || status === 302, `${path} returned ${status}`);
      const location = res.headers.get("location") ?? "";
      assert(location.includes("/admin/login"), `${path} redirected to ${location}`);
    }
    return "4 pages redirect to /admin/login";
  });

  await test("the sign-in page itself is reachable", async () => {
    const { status, data } = await admin.call("/admin/login");
    eq(status, 200, "status");
    assert(data.includes("Team sign in"), "the sign-in form is missing");
  });

  await test("a wrong password is refused", async () => {
    const { status, data } = await admin.call("/api/admin/session", {
      method: "POST",
      body: { email: ADMIN.email, password: "not-the-password" },
    });
    eq(status, 401, "status");
    eq(data.error, "Wrong email or password.", "message");
  });

  await test("an unknown email gives the same message as a wrong password", async () => {
    const { status, data } = await admin.call("/api/admin/session", {
      method: "POST",
      body: { email: "nobody@nowhere.com", password: "whatever" },
    });
    eq(status, 401, "status");
    eq(data.error, "Wrong email or password.", "message");
    return "no account enumeration";
  });

  await test("the right password signs in and sets the admin cookie", async () => {
    const { status, data } = await admin.call("/api/admin/session", {
      method: "POST",
      body: ADMIN,
    });
    eq(status, 200, "status");
    eq(data.admin.role, "owner", "role");
    assert(admin.jar.has("gg_admin"), "no admin cookie was set");
    return `${data.admin.name} (${data.admin.role})`;
  });

  await test("admin pages now render", async () => {
    const pages = {
      "/admin": "Overview",
      "/admin/organizations": "Organizations",
      "/admin/questions": "Questions",
      "/admin/people": "People",
      "/admin/team": "Team",
      "/admin/activity": "Activity",
    };
    for (const [path, marker] of Object.entries(pages)) {
      const { status, data } = await admin.call(path);
      eq(status, 200, `${path} status`);
      assert(data.includes(marker), `${path} did not contain "${marker}"`);
    }
    return `${Object.keys(pages).length} pages render`;
  });

  section("Admin — results and export");

  let organizationId;
  await test("the overview page shows real counts and the latest entries", async () => {
    const { status, data } = await admin.call("/admin");
    eq(status, 200, "status");
    for (const marker of ["Organizations", "Students", "Quizzes done", "Recent organizations", "Latest entries"]) {
      assert(data.includes(marker), `the overview is missing "${marker}"`);
    }
    // The seeded organization and a student who has actually played must both appear.
    assert(data.includes("Demo College"), "the organization is missing from the overview");
    assert(data.includes("Bhavya N"), "the latest entries list is empty");
    return "tiles, recent organizations and latest entries all rendered";
  });

  await test("the organization list carries live counts", async () => {
    const { status, data } = await admin.call("/api/admin/organizations");
    eq(status, 200, "status");
    eq(data.organizations.length, 1, "organization count");
    organizationId = data.organizations[0].id;
    eq(Number(data.organizations[0].set_questions), 15, "set_questions");
    assert(Number(data.organizations[0].completed) >= 4, "completed count looks wrong");
    return `demo: ${data.organizations[0].registered} registered, ${data.organizations[0].completed} done`;
  });

  await test("the results view names the winner and shows contact details", async () => {
    const { status, data } = await admin.call(`/api/admin/organizations/${organizationId}`);
    eq(status, 200, "status");
    eq(data.results[0].name, "Bhavya N", "winner");
    eq(data.results[0].rank, 1, "winner rank");
    eq(data.results[1].name, "Asha Rao", "runner-up");
    eq(data.results[0].phone, "9800000002", "the winner's mobile number");
    assert(data.results[0].accuracy === 100, `accuracy was ${data.results[0].accuracy}`);
    return `winner ${data.results[0].name} ${data.results[0].score}/${data.results[0].max_score}`;
  });

  await test("students who registered but never submitted are listed separately", async () => {
    const { data } = await admin.call(`/api/admin/organizations/${organizationId}`);
    const names = data.notFinished.map((p) => p.name).sort();
    // "Probe P" registered during the answer-key check and never submitted.
    assert(names.includes("Probe P"), `expected Probe P among ${names.join(", ")}`);
    return `${data.notFinished.length} unfinished`;
  });

  await test("the per-question analysis covers every question, hardest first", async () => {
    const { data } = await admin.call(`/api/admin/organizations/${organizationId}`);
    eq(data.analysis.length, 15, "questions analysed");
    for (let i = 1; i < data.analysis.length; i++)
      assert(
        data.analysis[i - 1].pct_correct <= data.analysis[i].pct_correct,
        "analysis is not sorted hardest-first",
      );
    return `hardest ${data.analysis[0].pct_correct}%, easiest ${data.analysis.at(-1).pct_correct}%`;
  });

  await test("one student's answer sheet can be opened", async () => {
    const { data: detail } = await admin.call(`/api/admin/organizations/${organizationId}`);
    const winner = detail.results[0];
    const { status, data } = await admin.call(`/api/admin/attempts/${winner.id}`);
    eq(status, 200, "status");
    eq(data.answers.length, 15, "answer count");
    assert(
      data.answers.every((a) => a.is_correct),
      "the winner's sheet is not all correct",
    );
    assert(data.answers[0].correct_text.startsWith("right-"), "correct_text was not recorded");
    return "15 answers, all correct, with the key recorded";
  });

  await test("the Excel export downloads and parses with the expected sheets", async () => {
    const { status, res } = await admin.call(`/api/admin/organizations/${organizationId}/export`, { raw: true });
    eq(status, 200, "status");
    const type = res.headers.get("content-type") ?? "";
    assert(type.includes("spreadsheetml"), `content-type was ${type}`);
    const disposition = res.headers.get("content-disposition") ?? "";
    assert(disposition.includes("quiz-demo-"), `filename was ${disposition}`);

    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf.length > 5000, `workbook is only ${buf.length} bytes`);
    const wb = XLSX.read(buf, { type: "buffer" });
    eq(wb.SheetNames, ["Results", "Question Analysis", "Did Not Finish", "Event"], "sheet names");

    // Five completed attempts by now: Asha, Bhavya, Chetan, Divya and the
    // forged-submission student (who scored, just badly).
    const rows = XLSX.utils.sheet_to_json(wb.Sheets.Results);
    eq(rows.length, 5, "result rows");
    eq(rows[0].Name, "Bhavya N", "first row");
    // Kept as text on purpose: Excel would otherwise mangle a mobile number
    // into scientific notation and drop any leading zero.
    eq(rows[0].Mobile, "9800000002", "mobile is present, as text");
    assert(rows[0]["Accuracy %"] === 100, `accuracy was ${rows[0]["Accuracy %"]}`);

    const event = XLSX.utils.sheet_to_json(wb.Sheets.Event, { header: 1 });
    const winnerRow = event.find((r) => r[0] === "Winner");
    assert(winnerRow?.[1]?.includes("Bhavya N"), `Event sheet winner row: ${winnerRow?.[1]}`);
    return `${buf.length} bytes, 4 sheets, ${rows.length} result rows`;
  });

  await test("exporting does not delete anything", async () => {
    const { data } = await admin.call(`/api/admin/organizations/${organizationId}`);
    eq(data.summary.completed, 5, "completed attempts after the export");
    return "data intact after download";
  });

  section("Admin — managing organizations");

  let secondId;
  await test("a new organization can be created", async () => {
    const { status, data } = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: {
        name: "St. Xavier's College",
        slug: "xavier-2026",
        city: "Bengaluru",
        questionSetId: setId,
        questionCount: 5,
        shuffleQuestions: true,
        collectClass: true,
        requireEmail: false,
        // Events are created closed and go live on "Start round". The tests
        // below are about registering and marking, not the round lifecycle, so
        // they ask for a live event up front rather than pressing Start first.
        isOpen: true,
      },
    });
    eq(status, 201, "status");
    secondId = data.organization.id;
    eq(data.organization.slug, "xavier-2026", "slug");
    return `#${secondId} code xavier-2026`;
  });

  await test("a duplicate code is refused with a clear message", async () => {
    const { status, data } = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: { name: "Clashing College", slug: "xavier-2026", questionSetId: setId },
    });
    eq(status, 409, "status");
    eq(data.field, "slug", "field");
    assert(data.error.includes("already taken"), `message was: ${data.error}`);
  });

  await test("a reserved code is refused", async () => {
    const { status } = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: { name: "Admin College", slug: "admin", questionSetId: setId },
    });
    eq(status, 422, "status");
  });

  await test("a 5-of-15 subset really asks 5 questions, in varying order", async () => {
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
      const c = client(`x${i}`);
      const { status, data } = await c.call("/api/quiz/start", {
        method: "POST",
        body: { slug: "xavier-2026", name: `Student ${i}`, phone: `98111000${i}${i}`, classOrYear: "2nd year" },
      });
      eq(status, 200, `student ${i} status`);
      eq(data.questions.length, 5, "questions served");
      seen.add(data.questions.map((q) => q.text).join("|"));
    }
    return `5 questions each; ${seen.size} distinct selections across 3 students`;
  });

  await test("email is optional when the event says so", async () => {
    const c = client("no-email");
    const { status } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "xavier-2026", name: "No Email", phone: "9812000001" },
    });
    eq(status, 200, "status");
  });

  await test("a partial update changes only what was sent", async () => {
    const { data: before } = await admin.call(`/api/admin/organizations/${secondId}`);
    // Send one field. Everything else must survive untouched.
    const { status } = await admin.call(`/api/admin/organizations/${secondId}`, {
      method: "PATCH",
      body: { city: "Mysuru" },
    });
    eq(status, 200, "status");
    const { data: after } = await admin.call(`/api/admin/organizations/${secondId}`);
    eq(after.organization.city, "Mysuru", "the field that was sent");
    for (const key of [
      "name", "slug", "question_set_id", "question_count", "is_open",
      "shuffle_questions", "shuffle_options", "allow_retake", "show_score",
      "require_email", "collect_class", "prize_note",
    ]) {
      eq(after.organization[key], before.organization[key], `untouched field "${key}"`);
    }
    return "12 other settings preserved";
  });

  await test("closing entries stops new registrations", async () => {
    const { status } = await admin.call(`/api/admin/organizations/${secondId}`, {
      method: "PATCH",
      body: { isOpen: false },
    });
    eq(status, 200, "patch status");

    const c = client("late");
    const late = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "xavier-2026", name: "Too Late", phone: "9813000001" },
    });
    eq(late.status, 403, "late registration status");
    assert(late.data.error.includes("closed"), `message was: ${late.data.error}`);
  });

  section("Admin — managing questions");

  let newQuestionId;
  await test("a question can be added", async () => {
    const { status, data } = await admin.call("/api/admin/questions", {
      method: "POST",
      body: {
        setId,
        text: "Which structure implants in the uterine wall?",
        options: ["Zygote", "Blastocyst", "Polar body", "Morula"],
        correctIndex: 1,
        points: 3,
      },
    });
    eq(status, 201, "status");
    newQuestionId = data.question.id;
    eq(Number(data.question.position), 15, "appended at the end");
    return `#${newQuestionId} at position 15, worth 3 points`;
  });

  await test("a question with an out-of-range answer key is refused", async () => {
    const { status } = await admin.call("/api/admin/questions", {
      method: "POST",
      body: { setId, text: "Broken question here", options: ["a", "b"], correctIndex: 5 },
    });
    eq(status, 422, "status");
  });

  await test("a question with one option is refused", async () => {
    const { status } = await admin.call("/api/admin/questions", {
      method: "POST",
      body: { setId, text: "Only one option here", options: ["a"], correctIndex: 0 },
    });
    eq(status, 422, "status");
  });

  await test("a question can be edited", async () => {
    const { status, data } = await admin.call(`/api/admin/questions/${newQuestionId}`, {
      method: "PATCH",
      body: {
        setId,
        text: "Which structure implants in the uterine wall? (edited)",
        options: ["Zygote", "Blastocyst", "Polar body", "Morula"],
        correctIndex: 1,
        points: 1,
      },
    });
    eq(status, 200, "status");
    assert(data.question.text.endsWith("(edited)"), "the edit did not stick");
  });

  await test("editing a question does not rewrite how past quizzes were marked", async () => {
    const first = QUESTIONS[0];
    const list = await admin.call(`/api/admin/questions?setId=${setId}`);
    const target = list.data.questions.find((q) => q.text === first.text);
    await admin.call(`/api/admin/questions/${target.id}`, {
      method: "PATCH",
      body: {
        setId,
        text: "Completely rewritten question",
        options: ["p", "q", "r", "s"],
        correctIndex: 0,
        points: 1,
      },
    });
    const { data } = await admin.call(`/api/admin/organizations/${organizationId}`);
    eq(data.results[0].score, 16, "the winner's score changed after a question edit");
    const sheet = await admin.call(`/api/admin/attempts/${data.results[0].id}`);
    assert(
      sheet.data.answers.some((a) => a.question_text === first.text),
      "the answer sheet lost its snapshot of the original wording",
    );
    return "scores and answer sheets unchanged";
  });

  await test("questions can be reordered", async () => {
    const { data: before } = await admin.call(`/api/admin/questions?setId=${setId}`);
    const reversed = [...before.questions].reverse().map((q) => q.id);
    const { status } = await admin.call("/api/admin/questions", {
      method: "PUT",
      body: { setId, order: reversed },
    });
    eq(status, 200, "status");
    const { data: after } = await admin.call(`/api/admin/questions?setId=${setId}`);
    eq(
      after.questions.map((q) => String(q.id)),
      reversed.map(String),
      "order after reordering",
    );
    // Put it back so later assertions about content are stable.
    await admin.call("/api/admin/questions", {
      method: "PUT",
      body: { setId, order: [...reversed].reverse() },
    });
    return `${reversed.length} questions reordered and restored`;
  });

  await test("a question can be hidden without deleting it", async () => {
    await admin.call(`/api/admin/questions/${newQuestionId}`, {
      method: "PATCH",
      body: {
        setId,
        text: "Which structure implants in the uterine wall? (edited)",
        options: ["Zygote", "Blastocyst", "Polar body", "Morula"],
        correctIndex: 1,
        isActive: false,
      },
    });
    const { data } = await asha.call("/api/public/organization?code=demo");
    eq(data.organization.questionCount, 15, "a hidden question is still being asked");
    return "hidden question excluded from the count";
  });

  await test("a question can be deleted, and positions close up", async () => {
    const { status } = await admin.call(`/api/admin/questions/${newQuestionId}`, {
      method: "DELETE",
    });
    eq(status, 200, "status");
    const { data } = await admin.call(`/api/admin/questions?setId=${setId}`);
    const positions = data.questions.map((q) => Number(q.position));
    eq(positions, [...positions.keys()], "positions are not contiguous after the delete");
    return `${positions.length} questions, positions 0..${positions.length - 1}`;
  });

  await test("a question set can be duplicated with its questions", async () => {
    const { status, data } = await admin.call("/api/admin/sets", {
      method: "POST",
      body: { name: "Embryology (copy)", copyFrom: setId },
    });
    eq(status, 201, "status");
    const listed = await admin.call("/api/admin/sets");
    const copy = listed.data.sets.find((s) => Number(s.id) === Number(data.set.id));
    const original = listed.data.sets.find((s) => Number(s.id) === Number(setId));
    eq(Number(copy.question_count), Number(original.question_count), "copied question count");
    return `${copy.question_count} questions copied`;
  });

  await test("a set still used by an organization cannot be deleted", async () => {
    const { status, data } = await admin.call(`/api/admin/sets/${setId}`, { method: "DELETE" });
    eq(status, 409, "status");
    assert(data.error.includes("still use this set"), `message was: ${data.error}`);
  });

  section("A time limit for the whole quiz");

  // Its own set and its own event, so timing a quiz never disturbs the counts
  // the "demo" assertions above and below depend on.
  let timedSetId, timedOrgId;
  await test("a set and an event to time", async () => {
    const set = await admin.call("/api/admin/sets", {
      method: "POST",
      body: { name: "Timed set", description: "e2e" },
    });
    eq(set.status, 201, "set status");
    timedSetId = set.data.set.id;
    eq(set.data.set.time_limit_seconds, null, "a new set starts untimed");

    for (let i = 0; i < 3; i++) {
      const { status } = await admin.call("/api/admin/questions", {
        method: "POST",
        body: {
          setId: timedSetId,
          text: `Timed question ${i + 1}: which option is right?`,
          options: [`t${i}a`, `t${i}b`, `right-${i}`],
          correctIndexes: [2],
        },
      });
      eq(status, 201, `question ${i + 1}`);
    }

    const org = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: { name: "Timed College", slug: "timed-2026", questionSetId: timedSetId, requireEmail: false, isOpen: true },
    });
    eq(org.status, 201, "event status");
    timedOrgId = org.data.organization.id;
    return `set #${timedSetId}, event "timed-2026"`;
  });

  await test("an untimed quiz tells the phone there is no limit", async () => {
    const c = client("untimed");
    const { status, data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "timed-2026", name: "Untimed Student", phone: "9872000001" },
    });
    eq(status, 200, "status");
    eq(data.timeLimitSeconds, null, "timeLimitSeconds");
    return "null, so the phone draws no countdown";
  });

  await test("a limit is set in minutes and stored in seconds", async () => {
    const { status } = await admin.call(`/api/admin/sets/${timedSetId}`, {
      method: "PATCH",
      body: { name: "Timed set", description: "e2e", timeLimitMinutes: 12 },
    });
    eq(status, 200, "status");
    const { data } = await admin.call("/api/admin/sets");
    const set = data.sets.find((s) => Number(s.id) === Number(timedSetId));
    eq(set.time_limit_seconds, 720, "12 minutes stored as seconds");

    // The set is timed now, so the event needs its round started before it will
    // let anybody in. Nothing below is about the door, so open it here.
    const started = await admin.call(`/api/admin/organizations/${timedOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "timed-2026");
    assert(started.data.organization.closes_at, "the round did not start");
    return "12 min -> 720 s";
  });

  await test("a timed event admits nobody until its round is started", async () => {
    // The event's switch is on, but no round has been given a deadline. Letting
    // students in here would hand each of them a full clock before the host had
    // said go — the whole point of a timed round.
    const made = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: {
        name: "Early College",
        slug: "early-2026",
        questionSetId: timedSetId,
        requireEmail: false,
        isOpen: true,
      },
    });
    eq(made.status, 201, "created");
    eq(made.data.organization.is_open, true, "open by hand");
    eq(made.data.organization.closes_at, null, "but with no round");

    const pub = await client("early-pub").call("/api/public/organization?code=early-2026");
    eq(pub.data.organization.isOpen, true, "the waiting room is reachable");
    eq(pub.data.organization.notStarted, true, "but the round has not started");
    eq(pub.data.organization.beginsInMs, null, "and there is nothing to count down to");

    // Registering is exactly what a student does in the waiting room, so this
    // succeeds — but it opens no attempt and hands out no questions.
    const { status, data } = await client("early").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "early-2026", name: "Far Too Keen", phone: "9872000009" },
    });
    eq(status, 200, "status");
    eq(data.waiting, true, "waiting");
    eq(data.questions, undefined, "no question may leave the server before the round");
    eq(data.attemptId, undefined, "and no attempt may be opened");
    eq(data.beginsInMs, null, "nothing to count down to yet");
    eq(data.summary.total, 3, "but the shape of the quiz is safe to send");

    const early = await emu.db.query(
      `SELECT count(*)::int AS n FROM attempts a
         JOIN organizations o ON o.id = a.organization_id
        WHERE o.slug = 'early-2026'`,
    );
    eq(early.rows[0].n, 0, "the waiting room must not open attempts");

    // Start is what opens it, and then the same student is welcome.
    await admin.call(`/api/admin/organizations/${made.data.organization.id}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "early-2026");
    const after = await client("early2").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "early-2026", name: "Far Too Keen", phone: "9872000009" },
    });
    eq(after.status, 200, "the round started, so the student is in");
    eq(after.data.timeLimitSeconds, 720, "and gets the set's limit");
    eq(after.data.questions.length, 3, "and now has questions");
    assert(after.data.attemptId, "and an attempt");

    await admin.call(
      `/api/admin/organizations/${made.data.organization.id}?mode=all&confirm=early-2026`,
      { method: "DELETE" },
    );
    return "refused before Start, admitted after";
  });

  await test("the limit reaches the student with their questions", async () => {
    const c = client("timed");
    const { status, data } = await joinViaWaitingRoom(admin, emu.db, c, timedOrgId, "timed-2026", {
      name: "Timed Student",
      phone: "9872000002",
    });
    eq(status, 200, "status");
    eq(data.timeLimitSeconds, 720, "timeLimitSeconds");
    eq(data.questions.length, 3, "questions served");
    // One limit for the whole quiz — nothing per question carries its own.
    assert(
      data.questions.every((q) => q.limit === undefined && q.timeLimitSeconds === undefined),
      "a per-question limit leaked into the payload",
    );
    return "720 s, delivered once for the whole run";
  });

  await test("running out of time still saves the answers given so far", async () => {
    const c = client("ran-out");
    const { data } = await joinViaWaitingRoom(admin, emu.db, c, timedOrgId, "timed-2026", {
      name: "Ran Out",
      phone: "9872000003",
    });
    // What the countdown submits at zero: the answers reached, nothing else.
    const all = await answersFor(emu.db, data.attemptId);
    const res = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: data.attemptId, answers: all.slice(0, 1), elapsedMs: 720_000 },
    });
    eq(res.status, 200, "status");
    eq(res.data.correctCount, 1, "the one answered is marked");
    eq(res.data.questionCount, 3, "the two unanswered still count against them");
    eq(res.data.score, 1, "score");
    return "1 of 3 saved, the rest left unanswered";
  });

  await test("a limit nobody could run is refused, and does not clear the old one", async () => {
    for (const timeLimitMinutes of [0, -5, 0.4, 361, "abc"]) {
      const { status } = await admin.call(`/api/admin/sets/${timedSetId}`, {
        method: "PATCH",
        body: { name: "Timed set", description: "e2e", timeLimitMinutes },
      });
      assert(status === 422, `timeLimitMinutes=${JSON.stringify(timeLimitMinutes)} returned ${status}`);
    }
    // The 12 minutes must survive every one of those rejections.
    const { data } = await admin.call("/api/admin/sets");
    const set = data.sets.find((s) => Number(s.id) === Number(timedSetId));
    eq(set.time_limit_seconds, 720, "the stored limit after 5 bad requests");
    return "5 refused, 12 min intact";
  });

  await test("the limit can be cleared back to untimed", async () => {
    const { status } = await admin.call(`/api/admin/sets/${timedSetId}`, {
      method: "PATCH",
      body: { name: "Timed set", description: "e2e", timeLimitMinutes: null },
    });
    eq(status, 200, "status");
    const { data } = await admin.call("/api/admin/sets");
    const set = data.sets.find((s) => Number(s.id) === Number(timedSetId));
    eq(set.time_limit_seconds, null, "back to untimed");

    const c = client("untimed-again");
    const start = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "timed-2026", name: "Untimed Again", phone: "9872000004" },
    });
    eq(start.data.timeLimitSeconds, null, "and the phone is told");
    return "cleared, and the quiz is untimed again";
  });

  await test("duplicating a timed set keeps its limit", async () => {
    await admin.call(`/api/admin/sets/${timedSetId}`, {
      method: "PATCH",
      body: { name: "Timed set", description: "e2e", timeLimitMinutes: 20 },
    });
    // Exactly what the Duplicate button sends.
    const copy = await admin.call("/api/admin/sets", {
      method: "POST",
      body: { name: "Timed set (copy)", description: "e2e", timeLimitMinutes: 20, copyFrom: timedSetId },
    });
    eq(copy.status, 201, "status");
    eq(copy.data.set.time_limit_seconds, 1200, "the copy is timed too");
    await admin.call(`/api/admin/sets/${copy.data.set.id}`, { method: "DELETE" });
    return "20 min carried to the copy";
  });

  section("Coming back to the registration form");

  // Its own event, so registering the same student several times cannot disturb
  // the counts the "demo" assertions depend on.
  let againOrgId;
  await test("an event to re-register against", async () => {
    const org = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: { name: "Again College", slug: "again-2026", questionSetId: setId, questionCount: 3, isOpen: true },
    });
    eq(org.status, 201, "status");
    againOrgId = org.data.organization.id;
    return `event "again-2026"`;
  });

  const rowsFor = async (slug) =>
    (
      await emu.db.query(
        `SELECT p.id, p.name, p.phone, p.email FROM participants p
           JOIN organizations o ON o.id = p.organization_id
          WHERE o.slug = $1 AND p.is_deleted = false ORDER BY p.id`,
        [slug],
      )
    ).rows;

  await test("re-entering the very same details picks the run back up", async () => {
    // Never refused, never duplicated: the same details come back to the run
    // already open rather than opening a second one beside it.
    const c = client("again-same");
    const body = { slug: "again-2026", name: "Same Details", phone: "9861000001", email: "same@x.com" };
    const first = await c.call("/api/quiz/start", { method: "POST", body });
    eq(first.status, 200, "first status");
    eq(first.data.resumed, false, "the first call opens the run");
    const second = await c.call("/api/quiz/start", { method: "POST", body });
    eq(second.status, 200, "second status");
    eq(second.data.resumed, true, "the second picks it up");
    eq(second.data.attemptId, first.data.attemptId, "and it is the same attempt");

    const rows = (await rowsFor("again-2026")).filter((r) => r.email === "same@x.com");
    eq(rows.length, 1, "still one row for that student");
    const open = await emu.db.query(
      `SELECT count(*)::int AS n FROM attempts a
         JOIN participants p ON p.id = a.participant_id
        WHERE p.email = 'same@x.com'`,
    );
    eq(open.rows[0].n, 1, "and one attempt, not two");
    return "same run, one participant row, one attempt";
  });

  await test("the same address with a mistyped number is the same student, not a clash", async () => {
    // The bug: a student registers, comes back, retypes their number wrongly,
    // and the one-address-per-event rule locked them out of their own quiz.
    const c = client("again-typo");
    const start = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-2026", name: "Typo Student", phone: "9861000002", email: "typo@x.com" },
    });
    eq(start.status, 200, "first status");
    const before = (await rowsFor("again-2026")).find((r) => r.email === "typo@x.com");

    const retry = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-2026", name: "Typo Student", phone: "9861000099", email: "typo@x.com" },
    });
    eq(retry.status, 200, "second status — they must be let in");

    const after = (await rowsFor("again-2026")).filter((r) => r.email === "typo@x.com");
    eq(after.length, 1, "one row, not two");
    eq(Number(after[0].id), Number(before.id), "the same row, moved to the new number");
    eq(after[0].phone, "9861000099", "the row now carries the corrected number");
    return "recognised by address, row moved to the new number";
  });

  await test("the same number with a different address is also fine", async () => {
    const c = client("again-newmail");
    const body = { slug: "again-2026", name: "New Mail", phone: "9861000003", email: "old@x.com" };
    eq((await c.call("/api/quiz/start", { method: "POST", body })).status, 200, "first status");
    const second = await c.call("/api/quiz/start", {
      method: "POST",
      body: { ...body, email: "new@x.com" },
    });
    eq(second.status, 200, "second status");
    const rows = (await rowsFor("again-2026")).filter((r) => r.phone === "9861000003");
    eq(rows.length, 1, "still one row");
    eq(rows[0].email, "new@x.com", "the address was updated");
    return "allowed, address updated";
  });

  await test("an address that really is somebody else's is still refused", async () => {
    // Two rows already exist; this asks for one person's number and the other
    // person's address, which is exactly what the rule is for.
    const c = client("again-clash");
    const { status, data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-2026", name: "Impostor", phone: "9861000001", email: "new@x.com" },
    });
    eq(status, 409, "status");
    eq(data.field, "email", "field");
    assert(
      data.error.includes("different mobile number"),
      `message was: ${data.error}`,
    );
    return "refused, and the message says why";
  });

  await test("once they have finished, coming back says they already played", async () => {
    const c = client("again-done");
    const start = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-2026", name: "Finished Student", phone: "9861000004", email: "done@x.com" },
    });
    const answers = await answersFor(emu.db, start.data.attemptId);
    eq(
      (await c.call("/api/quiz/submit", {
        method: "POST",
        body: { attemptId: start.data.attemptId, answers, elapsedMs: 4000 },
      })).status,
      200,
      "submit status",
    );

    // By the same number.
    const byPhone = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-2026", name: "Finished Student", phone: "9861000004", email: "done@x.com" },
    });
    eq(byPhone.status, 409, "status when they come back by number");
    assert(byPhone.data.error.includes("already played"), `message was: ${byPhone.data.error}`);
    eq(byPhone.data.field, "phone", "field");

    // And by the same address with a different number — the path that used to
    // report an address clash instead of the real reason.
    const byEmail = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-2026", name: "Finished Student", phone: "9861000088", email: "done@x.com" },
    });
    eq(byEmail.status, 409, "status when they come back by address");
    assert(byEmail.data.error.includes("already played"), `message was: ${byEmail.data.error}`);

    // There is nowhere for them to go and look, so the refusal must not send
    // them anywhere. This used to read "Open your dashboard to see your score."
    for (const m of [byPhone.data.error, byEmail.data.error]) {
      assert(!/dashboard/i.test(m), `the refusal still points at a dashboard: ${m}`);
    }
    eq(byEmail.data.field, "email", "field");
    return "both routes say already played, not a clash";
  });

  await test("retakes still work when the event allows them", async () => {
    await admin.call(`/api/admin/organizations/${againOrgId}`, {
      method: "PATCH",
      body: { allowRetake: true },
    });
    const c = client("again-retake");
    const { status } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-2026", name: "Finished Student", phone: "9861000004", email: "done@x.com" },
    });
    eq(status, 200, "status");
    await admin.call(`/api/admin/organizations/${againOrgId}`, {
      method: "PATCH",
      body: { allowRetake: false },
    });
    return "a finished student can play again when retakes are on";
  });

  await test("a refused registration writes nothing at all", async () => {
    // The bug: the row was moved to the newly typed number and only then was
    // the student refused. Their number drifted onto whatever they typed next,
    // that number became spoken for, and the person it really belonged to could
    // never register.
    const c = client("refuse-writes");
    const body = { slug: "again-2026", name: "Drift Test", phone: "9862000001", email: "drift@x.com" };
    const start = await c.call("/api/quiz/start", { method: "POST", body });
    eq(start.status, 200, "first status");
    const answers = await answersFor(emu.db, start.data.attemptId);
    await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: start.data.attemptId, answers, elapsedMs: 3000 },
    });

    const before = (await rowsFor("again-2026")).find((r) => r.email === "drift@x.com");
    eq(before.phone, "9862000001", "their number before the refused attempt");

    // Same address, a number they have never used. Refused, because they have
    // played — and it must change nothing.
    const refused = await c.call("/api/quiz/start", {
      method: "POST",
      body: { ...body, phone: "9862000002" },
    });
    eq(refused.status, 409, "status");
    assert(refused.data.error.includes("already played"), `message was: ${refused.data.error}`);

    const after = (await rowsFor("again-2026")).find((r) => r.email === "drift@x.com");
    eq(after.phone, "9862000001", "their number must not have followed the refused attempt");
    eq(Number(after.id), Number(before.id), "same row");
    return "refused, and the row is untouched";
  });

  await test("the number typed in a refused attempt is still free for its real owner", async () => {
    // 9862000002 was typed above and refused. It must belong to nobody.
    const c = client("refuse-free");
    const { status } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-2026", name: "Real Owner", phone: "9862000002", email: "owner@x.com" },
    });
    eq(status, 200, "a different student must be able to use that number");
    const rows = await rowsFor("again-2026");
    eq(rows.filter((r) => r.phone === "9862000002").length, 1, "one row on that number");
    eq(rows.find((r) => r.phone === "9862000002").email, "owner@x.com", "and it is theirs");
    return "the number was never taken";
  });

  await test("after finishing, brand new details are a brand new student", async () => {
    // Neither the number nor the address is on file, so there is nobody to
    // recognise and nothing to refuse — even though the browser still carries
    // the session cookie from the run they just finished.
    const c = client("refuse-fresh");
    const body = { slug: "again-2026", name: "Fresh Start", phone: "9862000003", email: "fresh@x.com" };
    const start = await c.call("/api/quiz/start", { method: "POST", body });
    eq(start.status, 200, "first status");
    const answers = await answersFor(emu.db, start.data.attemptId);
    await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: start.data.attemptId, answers, elapsedMs: 3000 },
    });

    // Same browser, same cookie, entirely different person.
    const second = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-2026", name: "Second Person", phone: "9862000004", email: "second@x.com" },
    });
    eq(second.status, 200, "a new number and a new address must be let straight in");
    return "the signed-in cookie does not decide who is registering";
  });

  await test("the Unfinished count is people, and always matches the list beside it", async () => {
    // By now this event holds students who started several times and one who
    // started several times and then finished — the shape that made the tile
    // and the list disagree: the tile counted open attempts, the list counted
    // people, so a tester who pressed Continue five times and then finished
    // saw "5 unfinished" above an empty list.
    const { data } = await admin.call(`/api/admin/organizations/${againOrgId}`);

    eq(
      data.summary.not_finished,
      data.notFinished.length,
      "the number on the tile against the length of the list under it",
    );

    // Everybody in the list really has no completed run, and really did start.
    assert(data.notFinished.length > 0, "expected somebody to be unfinished here");
    assert(
      data.notFinished.every((p) => p.attempts >= 1),
      "somebody is listed who never started an attempt",
    );

    // Nobody who finished is in it.
    const finishedPhones = new Set(data.results.map((r) => r.phone));
    assert(
      data.notFinished.every((p) => !finishedPhones.has(p.phone)),
      "somebody who finished is listed as unfinished",
    );

    // And the old number is still reported, still counting attempts rather than
    // people — which is why it is no longer what the tile shows.
    assert(
      data.summary.in_progress >= data.summary.not_finished,
      `open attempts (${data.summary.in_progress}) should not be under people (${data.summary.not_finished})`,
    );
    return `${data.summary.not_finished} people, ${data.summary.in_progress} open attempts`;
  });

  await test("finishing removes a student from the unfinished list", async () => {
    const before = await admin.call(`/api/admin/organizations/${againOrgId}`);
    const target = before.data.notFinished[0];
    assert(target, "expected an unfinished student to finish off");

    const c = client("again-finisher");
    const start = await c.call("/api/quiz/start", {
      method: "POST",
      body: {
        slug: "again-2026",
        name: target.name,
        phone: target.phone,
        email: target.email,
      },
    });
    eq(start.status, 200, "start status");
    const answers = await answersFor(emu.db, start.data.attemptId);
    eq(
      (await c.call("/api/quiz/submit", {
        method: "POST",
        body: { attemptId: start.data.attemptId, answers, elapsedMs: 3000 },
      })).status,
      200,
      "submit status",
    );

    const after = await admin.call(`/api/admin/organizations/${againOrgId}`);
    eq(
      after.data.summary.not_finished,
      before.data.summary.not_finished - 1,
      "the count after one of them finished",
    );
    eq(after.data.summary.not_finished, after.data.notFinished.length, "count still matches the list");
    assert(
      !after.data.notFinished.some((p) => p.phone === target.phone),
      "the student who just finished is still listed as unfinished",
    );
    // Their abandoned attempts are still on the row, and still must not count.
    return `${target.name} dropped off; ${after.data.summary.in_progress} open attempts remain`;
  });

  section("Starting and ending a round");

  // Its own set and event again, and a short limit so a round can really run out
  // inside the suite rather than being simulated.
  let roundSetId, roundOrgId;
  await test("a timed set and an event to run rounds on", async () => {
    const set = await admin.call("/api/admin/sets", {
      method: "POST",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: 1 },
    });
    eq(set.status, 201, "set status");
    roundSetId = set.data.set.id;
    eq(set.data.set.time_limit_seconds, 60, "one minute");

    for (let i = 0; i < 2; i++) {
      const { status } = await admin.call("/api/admin/questions", {
        method: "POST",
        body: {
          setId: roundSetId,
          text: `Round question ${i + 1}: which option is right?`,
          options: [`r${i}a`, `right-${i}`],
          correctIndexes: [1],
        },
      });
      eq(status, 201, `question ${i + 1}`);
    }

    const org = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: {
        name: "Round College",
        slug: "round-2026",
        questionSetId: roundSetId,
        requireEmail: false,
        isOpen: false,
      },
    });
    eq(org.status, 201, "event status");
    roundOrgId = org.data.organization.id;
    eq(org.data.organization.closes_at, null, "a new event has no deadline");
    return `set #${roundSetId} (1 min), event "round-2026", closed`;
  });

  await test("a new event is created closed, not live", async () => {
    // Setting an event up is a quiet job done beforehand; going live is a
    // deliberate press of Start in front of the room. A half-configured event
    // must not already be taking entries.
    const made = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: { name: "Default College", slug: "default-2026", questionSetId: roundSetId },
    });
    eq(made.status, 201, "status");
    eq(made.data.organization.is_open, false, "a brand new event must not be open");
    eq(made.data.organization.closes_at, null, "a brand new event has no deadline");

    const { status } = await client("default-early").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "default-2026", name: "Far Too Early", phone: "9865000001" },
    });
    eq(status, 403, "a student reached an event nobody had started");

    await admin.call(
      `/api/admin/organizations/${made.data.organization.id}?mode=all&confirm=default-2026`,
      { method: "DELETE" },
    );
    return "closed on arrival, and refusing entries";
  });

  await test("while it is closed, nobody can register", async () => {
    const { status, data } = await client("round-early").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Too Early", phone: "9863000001" },
    });
    eq(status, 403, "status");
    assert(data.error.includes("closed"), `message was: ${data.error}`);
  });

  await test("Start opens it and gives the round the set's limit", async () => {
    // Into the waiting room first - once the round is on, the door is shut.
    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { isOpen: true },
    });
    const eager = client("round-leadin");
    const booked = await eager.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Too Eager", phone: "9863000011" },
    });
    eq(booked.status, 200, "registered in the waiting room");
    eq(booked.data.waiting, true, "and is waiting");

    const { status, data } = await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    eq(status, 200, "status");
    eq(data.organization.is_open, true, "is_open");
    assert(data.organization.closes_at, "no deadline was set");

    // The lead-in is bought on top of the limit, not taken out of it: a minute
    // of answering still lasts a minute, and the deadline is that much later.
    const left = new Date(data.organization.closes_at).getTime() - Date.now();
    assert(
      left > 60_000 && left <= 65_000,
      `deadline is ${Math.round(left / 1000)}s away, expected ~65 (60s round + 5s lead-in)`,
    );

    // The phone is told how long until the questions appear, as a duration, so
    // a room of phones lands together whatever their clocks say.
    const pub = await client("round-pub").call("/api/public/organization?code=round-2026");
    eq(pub.data.organization.isOpen, true, "the student-facing page says open");
    eq(pub.data.organization.notStarted, false, "the round is on");
    assert(
      pub.data.organization.beginsInMs > 0 && pub.data.organization.beginsInMs <= 5_000,
      `lead-in reached the phone as ${pub.data.organization.beginsInMs}ms`,
    );
    assert(pub.data.organization.closesInMs > 0, "the countdown did not reach the phone");

    // During the lead-in there is still nothing to answer.
    const early = await eager.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Too Eager", phone: "9863000011" },
    });
    eq(early.status, 200, "somebody already registered may still come back");
    eq(early.data.waiting, true, "but the questions wait for the countdown");

    await skipLeadIn(emu.db, "round-2026");
    const now = await eager.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Too Eager", phone: "9863000011" },
    });
    eq(now.status, 200, "once the lead-in is over the same student is let in");
    eq(now.data.questions.length, 2, "and gets the questions");
    return `open, ${Math.round(left / 1000)}s deadline including the lead-in`;
  });

  await test("a running round takes no new entries, however new the details", async () => {
    /* The hole this closes: play once, copy the questions out, then come back
       under a different name and mobile ten minutes in and collect a fresh full
       window with the answers already in hand. The retake rule cannot see it -
       a new number and a new address are a new person - so the door is what
       stops it. */
    const { status, data } = await client("round-latecomer").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Brand New", phone: "9863000012" },
    });
    eq(status, 403, "status");
    assert(/already started/i.test(data.error), `message was: ${data.error}`);

    // And nothing was written for them.
    const rows = await emu.db.query(
      `SELECT count(*)::int AS n FROM participants p
         JOIN organizations o ON o.id = p.organization_id
        WHERE o.slug = 'round-2026' AND p.phone = '9863000012'`,
    );
    eq(rows.rows[0].n, 0, "a refused latecomer must leave no row behind");
    return "refused, and nothing written";
  });

  await test("somebody from the waiting room plays the round they booked", async () => {
    const c = client("round-player");
    const { status, data } = await joinViaWaitingRoom(admin, emu.db, c, roundOrgId, "round-2026", {
      name: "In Time",
      phone: "9863000002",
    });
    eq(status, 200, "status");
    eq(data.timeLimitSeconds, 60, "their own limit is the same minute");
    return "registered in the waiting room, playing in the round";
  });

  await test("when the deadline passes the event closes itself", async () => {
    // Wind the deadline back rather than waiting a minute: the rule reads the
    // stored timestamp, so a past one is exactly what running out looks like.
    await emu.db.query(
      `UPDATE organizations SET closes_at = now() - interval '1 second' WHERE slug = 'round-2026'`,
    );

    const { status, data } = await client("round-late").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Too Late", phone: "9863000003" },
    });
    eq(status, 403, "status");
    assert(data.error.includes("closed"), `message was: ${data.error}`);

    const pub = await client("round-pub2").call("/api/public/organization?code=round-2026");
    eq(pub.data.organization.isOpen, false, "the student-facing page still says open");

    // Nothing rewrote the switch — the deadline alone closed it.
    const row = await emu.db.query(`SELECT is_open FROM organizations WHERE slug = 'round-2026'`);
    eq(row.rows[0].is_open, true, "is_open was flipped; the deadline should be enough");
    return "closed by its deadline, with is_open left alone";
  });

  await test("a student caught mid-quiz can still finish", async () => {
    // They registered while the round was running; running out must not throw
    // away answers they had already given.
    const attempt = await emu.db.query(
      `SELECT a.public_id FROM attempts a
         JOIN participants p ON p.id = a.participant_id
         JOIN organizations o ON o.id = a.organization_id
        WHERE o.slug = 'round-2026' AND p.phone = '9863000002' AND a.status = 'in_progress'`,
    );
    assert(attempt.rows.length === 1, "expected one open attempt");
    const id = attempt.rows[0].public_id;
    const answers = await answersFor(emu.db, id);
    const { status, data } = await client("round-finish").call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: id, answers, elapsedMs: 20_000 },
    });
    eq(status, 200, "status");
    eq(data.score, 2, "score");
    return "submitted after the round ended, and marked";
  });

  await test("a timed event opened by hand still has a round to start", async () => {
    // The state that a UI regression hid Start on: open, timed, but with no
    // deadline because nobody pressed Start. `closes_at` is null here exactly
    // as it is on an untimed event, so the run screen is told the set's limit
    // and must keep offering Start until a clock is actually ticking.
    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { isOpen: false },
    });
    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { isOpen: true },
    });

    const live = await admin.call(`/api/admin/organizations/${roundOrgId}/live`);
    eq(live.status, 200, "status");
    eq(live.data.organization.is_open, true, "open");
    eq(live.data.organization.closes_at, null, "opened by hand, so no deadline");
    eq(live.data.timeLimitSeconds, 60, "the run screen must be told the set is timed");

    // And the full detail route, which the results page reads, agrees.
    const detail = await admin.call(`/api/admin/organizations/${roundOrgId}`);
    eq(detail.data.timeLimitSeconds, 60, "the detail route must report it too");

    // Start still works from here, and is what puts a clock on it.
    const { data } = await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "round-2026");
    assert(data.organization.closes_at, "Start did not give the round a deadline");
    return "open with no clock, and Start still available";
  });

  await test("an untimed set reports no limit to the run screen", async () => {
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: null },
    });
    const live = await admin.call(`/api/admin/organizations/${roundOrgId}/live`);
    eq(live.data.timeLimitSeconds, null, "an untimed set must report null");

    // Put the minute back for the tests below.
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: 1 },
    });
    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "round-2026");
    return "null, so the screen offers open/close rather than a round";
  });

  await test("a submission after the student's own time is up is refused", async () => {
    const c = client("round-overrun");
    const started = await joinViaWaitingRoom(admin, emu.db, c, roundOrgId, "round-2026", {
      name: "Ran Over",
      phone: "9863000009",
    });
    eq(started.status, 200, "registered");
    const id = started.data.attemptId;
    const answers = await answersFor(emu.db, id);

    // Age the attempt past its own minute rather than waiting one out. The
    // check reads `started_at`, so an old one is exactly what overrunning is.
    await emu.db.query(
      `UPDATE attempts SET started_at = now() - interval '5 minutes' WHERE public_id = $1`,
      [id],
    );

    const { status, data } = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: id, answers, elapsedMs: 20_000 },
    });
    eq(status, 409, "status");
    assert(data.error.toLowerCase().includes("time"), `message was: ${data.error}`);

    // Nothing was scored, and the attempt is not left hanging in the host's
    // "still answering" count for somebody who is never coming back.
    const row = await emu.db.query(
      `SELECT status, score FROM attempts WHERE public_id = $1`,
      [id],
    );
    eq(row.rows[0].status, "abandoned", "attempt status");
    eq(row.rows[0].score, 0, "an overrun attempt must score nothing");

    const again = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: id, answers, elapsedMs: 20_000 },
    });
    eq(again.status, 409, "a second try must not get in either");
    return "refused, marked abandoned, and unscored";
  });

  await test("running a little late is still allowed through", async () => {
    // The countdown starts in the browser a moment after `started_at` is
    // stamped here, so an honest auto-submit at zero lands slightly late.
    const c = client("round-grace");
    const started = await joinViaWaitingRoom(admin, emu.db, c, roundOrgId, "round-2026", {
      name: "Just Late",
      phone: "9863000010",
    });
    eq(started.status, 200, "registered");
    const id = started.data.attemptId;
    const answers = await answersFor(emu.db, id);

    // One minute and five seconds into a one-minute quiz: over, but within the
    // allowance for a round trip.
    await emu.db.query(
      `UPDATE attempts SET started_at = now() - interval '65 seconds' WHERE public_id = $1`,
      [id],
    );

    const { status } = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: id, answers, elapsedMs: 60_000 },
    });
    eq(status, 200, "an honest late submit was thrown away");
    return "5s over the limit, accepted";
  });

  await test("Start again runs a fresh round", async () => {
    const { status, data } = await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "round-2026");
    eq(status, 200, "status");
    const left = new Date(data.organization.closes_at).getTime() - Date.now();
    assert(left > 50_000, `the new deadline is only ${Math.round(left / 1000)}s away`);

    // A new face cannot walk into the running round...
    const { status: shut } = await client("round-second-late").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Second Round", phone: "9863000004" },
    });
    eq(shut, 403, "the door is shut on the second round too");

    // ...but the host reopening the waiting room lets them in for it.
    const { status: joined } = await joinViaWaitingRoom(
      admin, emu.db, client("round-second"), roundOrgId, "round-2026",
      { name: "Second Round", phone: "9863000004" },
    );
    eq(joined, 200, "a student can join the new round through the waiting room");
    return "a second round, entered the way the first one was";
  });

  await test("closing by hand ends the round and clears its deadline", async () => {
    const { status, data } = await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { isOpen: false },
    });
    eq(status, 200, "status");
    eq(data.organization.is_open, false, "is_open");
    eq(data.organization.closes_at, null, "a closed event must not keep a deadline ticking");

    const { status: refused } = await client("round-closed").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "After Close", phone: "9863000005" },
    });
    eq(refused, 403, "status");
    return "closed, deadline cleared";
  });

  await test("reopening a timed event by hand does not restart its round", async () => {
    const { data } = await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { isOpen: true },
    });
    eq(data.organization.is_open, true, "is_open");
    eq(data.organization.closes_at, null, "reopening by hand must not invent a deadline");

    // The switch is on, but this set is timed and no round is running: that is
    // the waiting room. They register and wait rather than being turned away.
    const { status, data: body } = await client("round-reopened").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "After Reopen", phone: "9863000006" },
    });
    eq(status, 200, "status");
    eq(body.waiting, true, "waiting");
    eq(body.questions, undefined, "no questions before the round");

    const started = await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "round-2026");
    assert(started.data.organization.closes_at, "Start did not give it a deadline");
    const { status: joined } = await client("round-reopened2").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "After Reopen", phone: "9863000006" },
    });
    eq(joined, 200, "the started round lets them in");
    return "the switch alone is not a round";
  });

  await test("an ordinary edit leaves a running round alone", async () => {
    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "round-2026");
    const before = await admin.call(`/api/admin/organizations/${roundOrgId}`);
    const deadline = before.data.organization.closes_at;
    assert(deadline, "expected a running round");

    // Renaming the event must not end it.
    const { data } = await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { city: "Bengaluru" },
    });
    eq(data.organization.closes_at, deadline, "the deadline moved during an unrelated edit");
    eq(data.organization.city, "Bengaluru", "the edit itself did not take");
    return "deadline untouched by an unrelated edit";
  });

  await test("Start on an untimed set just opens it", async () => {
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: null },
    });
    const { data } = await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "round-2026");
    eq(data.organization.is_open, true, "is_open");
    eq(data.organization.closes_at, null, "an untimed set has no deadline to give");

    const { status } = await client("round-untimed").call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Untimed Round", phone: "9863000007" },
    });
    eq(status, 200, "status");
    return "open, with nothing to run out";
  });

  await test("the same details on a second phone resume the run, not start another", async () => {
    /* Found live: enter the same details on a second phone while the first run
       is still open and a second attempt was created, because the retake rule
       counts finished attempts and an open one counts nothing. Both submitted,
       and one person had two scores on the results table. */
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: 1 },
    });
    const made = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: {
        name: "Two Phones College",
        slug: "twophones-2026",
        questionSetId: roundSetId,
        requireEmail: false,
        isOpen: true,
      },
    });
    const id = made.data.organization.id;
    const body = { slug: "twophones-2026", name: "Both Devices", phone: "9869000001" };

    const phoneA = client("phone-a");
    const phoneB = client("phone-b");
    eq((await phoneA.call("/api/quiz/start", { method: "POST", body })).status, 200, "booked in");
    await admin.call(`/api/admin/organizations/${id}`, { method: "PATCH", body: { startRound: true } });
    await skipLeadIn(emu.db, "twophones-2026");

    const a = await phoneA.call("/api/quiz/start", { method: "POST", body });
    eq(a.status, 200, "first phone is playing");
    eq(a.data.resumed, false, "and it is a new run");

    // Second phone, same details, while the first run is still open.
    const b = await phoneB.call("/api/quiz/start", { method: "POST", body });
    eq(b.status, 200, "second phone gets in");
    eq(b.data.resumed, true, "but it is the same run");
    eq(b.data.attemptId, a.data.attemptId, "the very same attempt");
    assert(
      b.data.remainingMs <= a.data.remainingMs,
      `resuming handed out more time: ${a.data.remainingMs} -> ${b.data.remainingMs}`,
    );

    const rows = await emu.db.query(
      `SELECT count(*)::int AS n FROM attempts a
         JOIN organizations o ON o.id = a.organization_id
        WHERE o.slug = 'twophones-2026'`,
    );
    eq(rows.rows[0].n, 1, "one person, one attempt");

    // Both submit. The first wins; the second is told the same result.
    const answers = await answersFor(emu.db, a.data.attemptId, 2);
    const first = await phoneB.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: b.data.attemptId, answers, elapsedMs: 3000 },
    });
    eq(first.status, 200, "second phone submits");
    const second = await phoneA.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: a.data.attemptId, answers, elapsedMs: 3000 },
    });
    eq(second.status, 200, "first phone submits too");
    eq(second.data.alreadySubmitted, true, "and is told it was already in");

    const detail = await admin.call(`/api/admin/organizations/${id}`);
    eq(detail.data.summary.completed, 1, "one completed attempt, not two");
    eq(detail.data.results.length, 1, "one row on the results table");

    await admin.call(`/api/admin/organizations/${id}?mode=all&confirm=twophones-2026`, { method: "DELETE" });
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: null },
    });
    return "two phones, one attempt, one score";
  });

  await test("clearing entries does not leave the door ajar mid-round", async () => {
    /* Found live: Clear entries soft-deletes the participants, but the phone
       lookup deliberately sees deleted rows so the upsert cannot collide with a
       hidden one. The door read that as "already registered", so everybody the
       host had just wiped could walk back into a running round and take a fresh
       clock - which is the whole thing the door exists to stop. */
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: 1 },
    });
    const made = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: {
        name: "Cleared College",
        slug: "cleared-2026",
        questionSetId: roundSetId,
        requireEmail: false,
        isOpen: true,
      },
    });
    const id = made.data.organization.id;
    const body = { slug: "cleared-2026", name: "Wiped Out", phone: "9868000001" };

    // Registers in the waiting room and plays a round.
    const c = client("cleared-player");
    eq((await c.call("/api/quiz/start", { method: "POST", body })).status, 200, "booked in");
    await admin.call(`/api/admin/organizations/${id}`, { method: "PATCH", body: { startRound: true } });
    await skipLeadIn(emu.db, "cleared-2026");
    const run = await c.call("/api/quiz/start", { method: "POST", body });
    eq(run.status, 200, "played");
    const answers = await answersFor(emu.db, run.data.attemptId);
    await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: run.data.attemptId, answers, elapsedMs: 2000 },
    });

    // Host wipes the room and starts a fresh round without reopening the doors.
    const cleared = await admin.call(
      `/api/admin/organizations/${id}?mode=entries&confirm=cleared-2026`,
      { method: "DELETE" },
    );
    eq(cleared.status, 200, "entries cleared");
    await admin.call(`/api/admin/organizations/${id}`, { method: "PATCH", body: { startRound: true } });
    await skipLeadIn(emu.db, "cleared-2026");

    const again = await c.call("/api/quiz/start", { method: "POST", body });
    eq(again.status, 403, "a wiped participant is new again, and the round has started");
    assert(/already started/i.test(again.data.error), `message was: ${again.data.error}`);

    // The waiting room is how they get back in, exactly like anybody else.
    const back = await joinViaWaitingRoom(admin, emu.db, c, id, "cleared-2026", {
      name: body.name,
      phone: body.phone,
    });
    eq(back.status, 200, "and the waiting room lets them back in");
    assert(back.data.questions, "with questions");

    await admin.call(`/api/admin/organizations/${id}?mode=all&confirm=cleared-2026`, { method: "DELETE" });
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: null },
    });
    return "wiped, refused mid-round, readmitted through the waiting room";
  });

  await test("somebody who registers and walks away is listed as never started", async () => {
    /* The whole point of the waiting room is that people book in early, so some
       of them will drift off before the round begins. The host needs to see who
       registered and never saw a question, apart from who opened the quiz and
       never sent it back. */
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: 1 },
    });
    const made = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: {
        name: "No Show College",
        slug: "noshow-2026",
        questionSetId: roundSetId,
        requireEmail: false,
        isOpen: true,
      },
    });
    const id = made.data.organization.id;

    // One registers and leaves. One registers, starts, and never submits.
    const ghost = client("noshow-ghost");
    const quitter = client("noshow-quitter");
    for (const [c, name, phone] of [
      [ghost, "Never Played", "9867000001"],
      [quitter, "Gave Up", "9867000002"],
    ]) {
      const r = await c.call("/api/quiz/start", { method: "POST", body: { slug: "noshow-2026", name, phone } });
      eq(r.status, 200, `${name} registered`);
      eq(r.data.waiting, true, `${name} is waiting`);
    }
    await admin.call(`/api/admin/organizations/${id}`, { method: "PATCH", body: { startRound: true } });
    await skipLeadIn(emu.db, "noshow-2026");
    // Only the quitter comes back for questions; the ghost never returns.
    const started = await quitter.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "noshow-2026", name: "Gave Up", phone: "9867000002" },
    });
    eq(started.status, 200, "the quitter got questions");

    const { data } = await admin.call(`/api/admin/organizations/${id}`);
    eq(data.summary.registered, 2, "both are registered");
    eq(data.summary.completed, 0, "neither submitted");
    eq(data.notFinished.length, 2, "both are listed as unfinished");

    const byName = Object.fromEntries(data.notFinished.map((p) => [p.name, p]));
    eq(byName["Never Played"].attempts, 0, "registered and left: no attempt at all");
    eq(byName["Gave Up"].attempts, 1, "started but never sent it back");

    // And the workbook says the same thing in words.
    const res = await admin.call(`/api/admin/organizations/${id}/export`, { raw: true });
    const wb = XLSX.read(Buffer.from(await res.res.arrayBuffer()), { type: "buffer" });
    const sheet = XLSX.utils.sheet_to_json(wb.Sheets["Did Not Finish"]);
    const ghostRow = sheet.find((r) => r.Name === "Never Played");
    const quitRow = sheet.find((r) => r.Name === "Gave Up");
    eq(ghostRow["Got as far as"], "Never started", "ghost row");
    eq(quitRow["Got as far as"], "Started, not submitted", "quitter row");
    eq(ghostRow["Attempts started"], 0, "ghost attempts");

    await admin.call(`/api/admin/organizations/${id}?mode=all&confirm=noshow-2026`, { method: "DELETE" });
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: null },
    });
    return "one never started, one started and stopped, both visible";
  });

  await test("a finished round can be reopened as a waiting room", async () => {
    // A waiting room only exists on a timed set, and an earlier test left this
    // one untimed. Put a minute back for the duration, and restore it after.
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: 1 },
    });

    // Its own event, so the carefully ordered tests above are left alone.
    const made = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: {
        name: "Again And Again College",
        slug: "again-round-2026",
        questionSetId: roundSetId,
        requireEmail: false,
      },
    });
    eq(made.status, 201, "created");
    const id = made.data.organization.id;

    await admin.call(`/api/admin/organizations/${id}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    // Run the round out, leaving the state the host actually finds afterwards:
    // the switch still on, the deadline behind them.
    await emu.db.query(
      `UPDATE organizations SET closes_at = now() - interval '1 second' WHERE slug = 'again-round-2026'`,
    );
    const over = await admin.call(`/api/admin/organizations/${id}`);
    eq(over.data.organization.is_open, true, "the switch is still on");
    assert(over.data.organization.closes_at, "and the spent deadline is still there");

    // Opening the waiting room from here must clear that spent deadline,
    // otherwise the event would still read as over and admit nobody.
    const opened = await admin.call(`/api/admin/organizations/${id}`, {
      method: "PATCH",
      body: { isOpen: true },
    });
    eq(opened.data.organization.is_open, true, "open");
    eq(opened.data.organization.closes_at, null, "the spent deadline must be cleared");

    // And it behaves as a waiting room: registering works, questions do not.
    const c = client("again-lobby");
    const { status, data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "again-round-2026", name: "Second Timer", phone: "9866000001" },
    });
    eq(status, 200, "registering in the new waiting room");
    eq(data.waiting, true, "waiting");
    eq(data.questions, undefined, "no questions until the next round starts");

    await admin.call(
      `/api/admin/organizations/${id}?mode=all&confirm=again-round-2026`,
      { method: "DELETE" },
    );
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: null },
    });
    return "round over -> waiting room -> registering again";
  });

  await test("the run dashboard reports the room while it plays", async () => {
    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "round-2026");

    // Two students in: one finishes, one is left mid-quiz.
    const done = client("run-done");
    const d = await done.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Run Done", phone: "9864000001" },
    });
    const answers = await answersFor(emu.db, d.data.attemptId);
    await done.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: d.data.attemptId, answers, elapsedMs: 2000 },
    });

    const mid = client("run-mid");
    await mid.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "round-2026", name: "Run Mid", phone: "9864000002" },
    });

    const { data } = await admin.call(`/api/admin/organizations/${roundOrgId}`);
    assert(data.summary.registered >= 2, `registered was ${data.summary.registered}`);
    assert(data.summary.completed >= 1, `submitted was ${data.summary.completed}`);
    assert(data.summary.answering >= 1, `still answering was ${data.summary.answering}`);
    assert(
      data.results.some((r) => r.name === "Run Done"),
      "the finished student is missing from the leaderboard the panel shows",
    );
    return `${data.summary.registered} registered, ${data.summary.answering} answering, ${data.summary.completed} submitted`;
  });

  await test("a student whose own clock has expired stops counting as answering", async () => {
    // The host must not be left waiting on somebody who is never coming back.
    // The set runs one minute, so an attempt older than that cannot be live.
    // An earlier test left this set untimed, and an untimed set can only judge
    // "still answering" loosely — an hour. Put the minute back, so the rule
    // being checked is the one that reads the set's own limit.
    await admin.call(`/api/admin/sets/${roundSetId}`, {
      method: "PATCH",
      body: { name: "Round set", description: "e2e", timeLimitMinutes: 1 },
    });

    const before = await admin.call(`/api/admin/organizations/${roundOrgId}`);
    assert(before.data.summary.answering >= 1, "expected somebody mid-quiz to age out");

    await emu.db.query(
      `UPDATE attempts SET started_at = now() - interval '10 minutes'
        WHERE status = 'in_progress'
          AND organization_id = (SELECT id FROM organizations WHERE slug = 'round-2026')`,
    );

    const after = await admin.call(`/api/admin/organizations/${roundOrgId}`);
    eq(after.data.summary.answering, 0, "still answering");
    // The raw attempt is still open, and still counts as an unfinished person.
    assert(after.data.summary.in_progress >= 1, "the attempt itself should still be open");
    assert(
      after.data.notFinished.some((p) => p.phone === "9864000002"),
      "they should still be listed as not finished",
    );
    return "aged out of 'answering', still listed as unfinished";
  });

  await test("the run dashboard has a URL of its own, addressed by code", async () => {
    const byCode = await admin.call("/admin/organizations/round-2026/dashboard");
    eq(byCode.status, 200, "by code");
    assert(byCode.data.includes("Round College"), "the event name is missing from the page");

    const byId = await admin.call(`/admin/organizations/${roundOrgId}/dashboard`);
    eq(byId.status, 200, "by id");
    return "/admin/organizations/round-2026/dashboard and by id both render";
  });

  await test("the organization page itself also answers to the code", async () => {
    const { status, data } = await admin.call("/admin/organizations/round-2026");
    eq(status, 200, "status");
    assert(data.includes("Round College"), "the event name is missing from the page");
  });

  await test("the short URL redirects into the guarded admin one", async () => {
    const { status, res } = await admin.call("/organizations/round-2026/dashboard", {
      redirect: "manual",
      raw: true,
    });
    assert(status === 307 || status === 308, `expected a redirect, got ${status}`);
    eq(
      res.headers.get("location"),
      "/admin/organizations/round-2026/dashboard",
      "where it points",
    );
    return "short URL -> the admin one";
  });

  await test("a signed-out visitor cannot reach the dashboard", async () => {
    const anon = client("dash-anon");
    const direct = await anon.call("/admin/organizations/round-2026/dashboard", {
      redirect: "manual",
      raw: true,
    });
    assert(direct.status === 307 || direct.status === 308, `got ${direct.status}`);
    assert(
      (direct.res.headers.get("location") ?? "").includes("/admin/login"),
      `sent to ${direct.res.headers.get("location")}`,
    );

    // And the short URL cannot be used to slip past that.
    const short = await anon.call("/organizations/round-2026/dashboard");
    assert(
      typeof short.data === "string" && short.data.includes("Team sign in"),
      "the short URL let an anonymous visitor through",
    );
    return "bounced to sign-in by both routes";
  });

  await test("an unknown code is a 404, not an empty dashboard", async () => {
    const { status } = await admin.call("/admin/organizations/no-such-event/dashboard");
    eq(status, 404, "status");
  });

  await test("the live endpoint answers with only what the run screen draws", async () => {
    const { status, data } = await admin.call(`/api/admin/organizations/${roundOrgId}/live`);
    eq(status, 200, "status");

    // Exactly these keys — anything heavier has crept in if this fails.
    eq(
      Object.keys(data).sort(),
      ["ok", "organization", "summary", "timeLimitSeconds", "top"],
      "response shape",
    );
    eq(
      Object.keys(data.summary).sort(),
      ["answering", "completed", "registered"],
      "summary shape",
    );
    eq(
      Object.keys(data.organization).sort(),
      ["city", "closes_at", "id", "is_open", "name", "slug"],
      "organization shape",
    );

    // Nothing that grows with the room: no results table, no analysis, no list.
    assert(!("results" in data), "the full results table is in the live payload");
    assert(!("analysis" in data), "the question analysis is in the live payload");
    assert(!("notFinished" in data), "the did-not-finish list is in the live payload");
    assert(data.top.length <= 5, `the board carried ${data.top.length} rows, expected at most 5`);

    return `${JSON.stringify(data).length} bytes, board capped at 5`;
  });

  await test("the live payload stays small as the room grows", async () => {
    const before = JSON.stringify(
      (await admin.call(`/api/admin/organizations/${roundOrgId}/live`)).data,
    ).length;

    // A roomful books in first, the way they now have to.
    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { isOpen: true },
    });
    const room = [];
    for (let i = 0; i < 8; i++) {
      const c = client(`live-load-${i}`);
      const body = { slug: "round-2026", name: `Load Student ${i}`, phone: `98650000${10 + i}` };
      const lobby = await c.call("/api/quiz/start", { method: "POST", body });
      eq(lobby.status, 200, `student ${i} into the waiting room`);
      room.push({ c, body });
    }

    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { startRound: true },
    });
    await skipLeadIn(emu.db, "round-2026");

    for (const { c, body } of room) {
      const start = await c.call("/api/quiz/start", { method: "POST", body });
      const answers = await answersFor(emu.db, start.data.attemptId);
      await c.call("/api/quiz/submit", {
        method: "POST",
        body: { attemptId: start.data.attemptId, answers, elapsedMs: 2000 },
      });
    }

    const after = await admin.call(`/api/admin/organizations/${roundOrgId}/live`);
    assert(after.data.summary.completed >= 8, `completed was ${after.data.summary.completed}`);
    eq(after.data.top.length, 5, "the board is still capped");

    const grown = JSON.stringify(after.data).length;
    // Eight more finishers must not make the payload meaningfully bigger.
    assert(grown < before + 400, `payload grew from ${before} to ${grown} bytes`);
    return `${before} -> ${grown} bytes after 8 more finishers`;
  });

  await test("one student appears once on the live board even after a retake", async () => {
    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { allowRetake: true },
    });
    const c = client("live-retake");
    const body = { slug: "round-2026", name: "Twice Over", phone: "9865000099" };
    // The first run comes in through the waiting room; the retake is allowed
    // because by then they are somebody the event already knows.
    const first = await joinViaWaitingRoom(admin, emu.db, c, roundOrgId, "round-2026", {
      name: body.name,
      phone: body.phone,
    });
    eq(first.status, 200, "first run");
    for (const start of [first, null]) {
      const run = start ?? (await c.call("/api/quiz/start", { method: "POST", body }));
      const answers = await answersFor(emu.db, run.data.attemptId);
      await c.call("/api/quiz/submit", {
        method: "POST",
        body: { attemptId: run.data.attemptId, answers, elapsedMs: 1500 },
      });
    }
    const { data } = await admin.call(`/api/admin/organizations/${roundOrgId}/live`);
    const mine = data.top.filter((r) => r.name === "Twice Over");
    assert(mine.length <= 1, `they appear ${mine.length} times on the board`);
    await admin.call(`/api/admin/organizations/${roundOrgId}`, {
      method: "PATCH",
      body: { allowRetake: false },
    });
    return "best attempt only";
  });

  await test("the live endpoint is admin-only", async () => {
    const { status } = await client("live-anon").call(
      `/api/admin/organizations/${roundOrgId}/live`,
    );
    eq(status, 401, "status");
  });

  section("Pictures on questions");

  // A real 1x1 PNG, so the sniffing in /api/admin/uploads has genuine magic
  // bytes to read rather than a made-up header.
  const PNG_1PX = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );

  let pictureUrl = "";
  await test("an admin can upload a picture", async () => {
    const { status, data } = await uploadTo(admin, "/api/admin/uploads", {
      name: "blastocyst.png",
      mime: "image/png",
      bytes: PNG_1PX,
    });
    eq(status, 201, "status");
    eq(data.mime, "image/png", "mime");
    eq(data.byteSize, PNG_1PX.length, "byteSize");
    assert(
      /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.url),
      `url was ${data.url}`,
    );
    pictureUrl = data.url;
    return `${PNG_1PX.length} bytes at ${pictureUrl}`;
  });

  await test("the picture is readable without signing in, byte for byte", async () => {
    // A student's phone has no session at all, which is the whole point.
    const res = await fetch(BASE + pictureUrl);
    eq(res.status, 200, "status");
    eq(res.headers.get("content-type"), "image/png", "content-type");
    eq(res.headers.get("x-content-type-options"), "nosniff", "nosniff header");
    assert(
      (res.headers.get("cache-control") ?? "").includes("immutable"),
      `cache-control was ${res.headers.get("cache-control")}`,
    );
    const back = Buffer.from(await res.arrayBuffer());
    assert(back.equals(PNG_1PX), `got ${back.length} bytes, expected ${PNG_1PX.length}`);
    return "identical bytes, cached for a year";
  });

  await test("a picture id that does not exist is a plain 404", async () => {
    for (const id of ["2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "not-a-uuid", "../../etc/passwd"]) {
      const res = await fetch(`${BASE}/api/media/${encodeURIComponent(id)}`);
      eq(res.status, 404, `status for ${id}`);
    }
    return "3 bad ids refused";
  });

  await test("a file that is not really an image is refused", async () => {
    const { status, data } = await uploadTo(admin, "/api/admin/uploads", {
      // Claims to be a PNG in both the name and the type, but is HTML.
      name: "sneaky.png",
      mime: "image/png",
      bytes: Buffer.from("<html><script>alert(1)</script></html>"),
    });
    eq(status, 415, "status");
    assert(data.error.includes("not a PNG"), `message was: ${data.error}`);
    return "sniffed from the bytes, not trusted from the name";
  });

  await test("an SVG is refused, because it can carry script", async () => {
    const { status } = await uploadTo(admin, "/api/admin/uploads", {
      name: "diagram.svg",
      mime: "image/svg+xml",
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    eq(status, 415, "status");
  });

  await test("a picture over 2 MB is refused", async () => {
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(2 * 1024 * 1024)]);
    const { status, data } = await uploadTo(admin, "/api/admin/uploads", {
      name: "huge.png",
      mime: "image/png",
      bytes: big,
    });
    eq(status, 413, "status");
    assert(data.error.includes("2 MB"), `message was: ${data.error}`);
    return `${(big.length / 1024 / 1024).toFixed(1)} MB rejected`;
  });

  await test("an empty upload is refused", async () => {
    const { status } = await uploadTo(admin, "/api/admin/uploads", {
      name: "nothing.png",
      mime: "image/png",
      bytes: Buffer.alloc(0),
    });
    eq(status, 400, "status");
  });

  await test("a signed-out visitor cannot upload", async () => {
    const { status } = await uploadTo(client("nobody"), "/api/admin/uploads", {
      name: "x.png",
      mime: "image/png",
      bytes: PNG_1PX,
    });
    eq(status, 401, "status");
  });

  section("Questions with several correct answers");

  // A separate set and event, so the assertions about "demo" above — 15
  // questions, a winning score of 16 — stay exactly as they were.
  let multiSetId, multiOrgId;
  await test("a set of multi-answer questions can be built", async () => {
    const set = await admin.call("/api/admin/sets", {
      method: "POST",
      body: { name: "Select all that apply", description: "e2e" },
    });
    eq(set.status, 201, "set status");
    multiSetId = set.data.set.id;

    // Two right out of four, three right out of four, and one ordinary
    // single-answer question, so one attempt covers both kinds.
    const built = [
      {
        text: "Which two of these are gametes?",
        options: ["Sperm", "Oocyte", "Zygote", "Morula"],
        correctIndexes: [0, 1],
        points: 2,
        imageUrl: pictureUrl,
        imageAlt: "A sperm and an oocyte",
      },
      {
        text: "Which three stages follow fertilisation?",
        options: ["Oocyte", "Zygote", "Morula", "Blastocyst"],
        correctIndexes: [1, 2, 3],
        points: 3,
      },
      {
        text: "Which single cell implants in the uterine wall?",
        options: ["Zygote", "Blastocyst", "Polar body"],
        correctIndexes: [1],
        points: 1,
      },
    ];
    for (const q of built) {
      const { status } = await admin.call("/api/admin/questions", {
        method: "POST",
        body: { setId: multiSetId, ...q },
      });
      eq(status, 201, `creating "${q.text}"`);
    }

    const listed = await admin.call(`/api/admin/questions?setId=${multiSetId}`);
    eq(listed.data.questions.length, 3, "questions in the set");
    eq(
      listed.data.questions.map((q) => q.correct_indexes),
      [[0, 1], [1, 2, 3], [1]],
      "stored answer keys",
    );
    eq(
      listed.data.questions.map((q) => Number(q.correct_index)),
      [0, 1, 1],
      "correct_index tracks the first correct option",
    );
    eq(listed.data.questions[0].image_url, pictureUrl, "the picture stuck to the question");
    return "3 questions: 2-of-4, 3-of-4, 1-of-3";
  });

  await test("an answer key pointing past the last option is refused", async () => {
    const { status } = await admin.call("/api/admin/questions", {
      method: "POST",
      body: {
        setId: multiSetId,
        text: "Broken multi-answer question",
        options: ["a", "b", "c"],
        correctIndexes: [0, 5],
      },
    });
    eq(status, 422, "status");
  });

  await test("a question with no correct option at all is refused", async () => {
    const { status } = await admin.call("/api/admin/questions", {
      method: "POST",
      body: {
        setId: multiSetId,
        text: "Nothing is correct here",
        options: ["a", "b", "c"],
        correctIndexes: [],
      },
    });
    eq(status, 422, "status");
  });

  await test("a question where every option is correct is refused", async () => {
    const { status, data } = await admin.call("/api/admin/questions", {
      method: "POST",
      body: {
        setId: multiSetId,
        text: "Every option is correct here",
        options: ["a", "b", "c"],
        correctIndexes: [0, 1, 2],
      },
    });
    eq(status, 422, "status");
    assert(data.error.includes("nothing to work out"), `message was: ${data.error}`);
  });

  await test("a picture link that is not https or an upload is refused", async () => {
    for (const imageUrl of [
      "http://cdn.example.com/x.png",
      "javascript:alert(1)",
      "/api/media/not-a-uuid",
    ]) {
      const { status } = await admin.call("/api/admin/questions", {
        method: "POST",
        body: {
          setId: multiSetId,
          text: "Question with a bad picture link",
          options: ["a", "b"],
          correctIndexes: [0],
          imageUrl,
        },
      });
      eq(status, 422, `status for ${imageUrl}`);
    }
    return "3 bad links refused";
  });

  await test("an event can be pointed at the multi-answer set", async () => {
    const { status, data } = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: {
        name: "Multi College",
        slug: "multi-2026",
        questionSetId: multiSetId,
        shuffleOptions: true,
        requireEmail: false,
        isOpen: true,
      },
    });
    eq(status, 201, "status");
    multiOrgId = data.organization.id;
    return `#${multiOrgId} code multi-2026`;
  });

  await test("the phone is told a question takes several answers, but not how many", async () => {
    const c = client("multi-peek");
    const { status, data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "multi-2026", name: "Peek Student", phone: "9871000001" },
    });
    eq(status, 200, "status");
    eq(data.questions.length, 3, "questions served");

    const json = JSON.stringify(data.questions);
    assert(!json.includes('"ci"'), "the single-answer key leaked to the phone");
    assert(!json.includes('"cis"'), "the multi-answer key leaked to the phone");
    assert(!/"correct/i.test(json), `something answer-shaped leaked: ${json}`);

    const flags = data.questions.map((q) => q.multi === true);
    eq(flags.filter(Boolean).length, 2, "questions flagged as multi-answer");
    eq(flags.filter((f) => !f).length, 1, "questions left as single-answer");

    const withPicture = data.questions.find((q) => q.img);
    assert(withPicture, "the question's picture never reached the phone");
    eq(withPicture.img, pictureUrl, "picture url");
    eq(withPicture.alt, "A sperm and an oocyte", "picture description");
    return "multi flagged, key hidden, picture delivered";
  });

  await test("exactly the right set of options scores full marks", async () => {
    const c = client("multi-perfect");
    const { data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "multi-2026", name: "Perfect Student", phone: "9871000002" },
    });
    const answers = await answersFor(emu.db, data.attemptId);
    const res = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: data.attemptId, answers, elapsedMs: 5000 },
    });
    eq(res.status, 200, "status");
    eq(res.data.score, 6, "score");
    eq(res.data.maxScore, 6, "maxScore");
    eq(res.data.correctCount, 3, "correctCount");
    return "6 of 6";
  });

  await test("half of a multi-answer question scores nothing", async () => {
    const c = client("multi-half");
    const { data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "multi-2026", name: "Half Student", phone: "9871000003" },
    });
    const served = await servedFor(emu.db, data.attemptId);
    // One correct tick on each multi-answer question, the single-answer one right.
    const answers = served.map((q) => {
      const key = q.cis?.length ? q.cis : [q.ci];
      return {
        position: q.p,
        optionIndexes: key.slice(0, 1),
        ms: 900,
      };
    });
    const res = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: data.attemptId, answers, elapsedMs: 5000 },
    });
    // Only the genuinely single-answer question (1 point) can be right.
    eq(res.data.score, 1, "score");
    eq(res.data.correctCount, 1, "correctCount");
    return "1 of 6 — partial ticks earn nothing";
  });

  await test("ticking every option cannot win a multi-answer question", async () => {
    const c = client("multi-greedy");
    const { data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "multi-2026", name: "Greedy Student", phone: "9871000004" },
    });
    const answers = data.questions.map((q) => ({
      position: q.p,
      optionIndexes: q.opts.map((_, i) => i),
      ms: 400,
    }));
    const res = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: data.attemptId, answers, elapsedMs: 3000 },
    });
    eq(res.data.score, 0, "score");
    return "0 of 6 — no reward for covering every option";
  });

  await test("the answer sheet reads every chosen and correct option", async () => {
    const { data } = await admin.call(`/api/admin/organizations/${multiOrgId}`);
    const perfect = data.results.find((r) => r.name === "Perfect Student");
    assert(perfect, "the perfect run is missing from the results");
    const sheet = await admin.call(`/api/admin/attempts/${perfect.id}`);
    const twoAnswer = sheet.data.answers.find((a) => a.question_text.includes("two of these"));
    assert(twoAnswer, "the two-answer question is missing from the sheet");
    eq(twoAnswer.correct_text.split(" | ").length, 2, "correct options listed");
    eq(twoAnswer.chosen_text.split(" | ").length, 2, "chosen options listed");
    eq(twoAnswer.is_correct, true, "is_correct");

    const threeAnswer = sheet.data.answers.find((a) => a.question_text.includes("three stages"));
    eq(threeAnswer.correct_text.split(" | ").length, 3, "three correct options listed");
    return `"${twoAnswer.correct_text}"`;
  });

  await test("hiding a multi-answer question keeps its key and its picture", async () => {
    const listed = await admin.call(`/api/admin/questions?setId=${multiSetId}`);
    const q = listed.data.questions.find((x) => x.text.includes("two of these"));
    // Exactly the payload the admin panel's Hide button sends.
    const { status } = await admin.call(`/api/admin/questions/${q.id}`, {
      method: "PATCH",
      body: {
        setId: q.set_id,
        text: q.text,
        options: q.options,
        correctIndexes: q.correct_indexes,
        imageUrl: q.image_url,
        imageAlt: q.image_alt,
        explanation: q.explanation,
        points: q.points,
        isActive: false,
      },
    });
    eq(status, 200, "status");

    const after = await admin.call(`/api/admin/questions?setId=${multiSetId}`);
    const hidden = after.data.questions.find((x) => Number(x.id) === Number(q.id));
    eq(hidden.is_active, false, "is_active");
    eq(hidden.correct_indexes, [0, 1], "answer key survived being hidden");
    eq(hidden.image_url, pictureUrl, "picture survived being hidden");

    // Put it back, so a later re-read of this set is not short a question.
    await admin.call(`/api/admin/questions/${q.id}`, {
      method: "PATCH",
      body: {
        setId: q.set_id,
        text: q.text,
        options: q.options,
        correctIndexes: q.correct_indexes,
        imageUrl: q.image_url,
        imageAlt: q.image_alt,
        points: q.points,
        isActive: true,
      },
    });
    return "key and picture both intact";
  });

  await test("a single-answer question still works sent the old way", async () => {
    // An integration written against the previous API sends correctIndex.
    const { status, data } = await admin.call("/api/admin/questions", {
      method: "POST",
      body: {
        setId: multiSetId,
        text: "Written against the old single-answer API",
        options: ["Zygote", "Blastocyst", "Morula"],
        correctIndex: 1,
      },
    });
    eq(status, 201, "status");
    eq(data.question.correct_indexes, [1], "correctIndex became a one-entry key");
    await admin.call(`/api/admin/questions/${data.question.id}`, { method: "DELETE" });
    return "correctIndex 1 stored as [1]";
  });

  await test("a phone still sending one optionIndex is marked correctly", async () => {
    const c = client("multi-oldclient");
    const { data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "multi-2026", name: "Old Client", phone: "9871000005" },
    });
    const served = await servedFor(emu.db, data.attemptId);
    // The pre-upgrade payload shape: one index per question, nothing else.
    const answers = served.map((q) => ({ position: q.p, optionIndex: q.ci, ms: 800 }));
    const res = await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: data.attemptId, answers, elapsedMs: 4000 },
    });
    eq(res.status, 200, "status");
    // The single-answer question scores; one tap cannot satisfy a 2- or 3-answer key.
    eq(res.data.score, 1, "score");
    return "old payload accepted, and marked honestly";
  });

  section("Bullet points in a question");

  // The wording an admin would type: a stem, then a list. Sent with Windows line
  // endings and trailing spaces, the way a paste out of Word arrives.
  const BULLET_TEXT =
    "Which of these are true of a blastocyst?\r\n- It forms around Day 5-6  \r\n- It has an inner cell mass\r\n1. And a numbered point";
  const BULLET_STORED =
    "Which of these are true of a blastocyst?\n- It forms around Day 5-6\n- It has an inner cell mass\n1. And a numbered point";

  let bulletQuestionId;
  await test("a question can carry a bullet list, tidied on the way in", async () => {
    const { status, data } = await admin.call("/api/admin/questions", {
      method: "POST",
      body: {
        setId: multiSetId,
        text: BULLET_TEXT,
        options: ["All three", "None of them", "Only the first"],
        correctIndexes: [0],
      },
    });
    eq(status, 201, "status");
    bulletQuestionId = data.question.id;
    eq(data.question.text, BULLET_STORED, "stored wording");
    return "line endings normalised, trailing spaces gone, markers kept";
  });

  await test("the phone gets the wording verbatim, markers and all", async () => {
    const c = client("bullet-reader");
    const { status, data } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "multi-2026", name: "Bullet Reader", phone: "9871000006" },
    });
    eq(status, 200, "status");
    const q = data.questions.find((x) => x.text.startsWith("Which of these are true"));
    assert(q, "the bulleted question was not served");
    eq(q.text, BULLET_STORED, "wording as served");
    // Drawing the list is the renderer's job; the API must not pre-format it.
    assert(!q.text.includes("<"), "the API sent markup instead of text");
    return "4 lines delivered as text";
  });

  await test("a question with a list renders on the student's page", async () => {
    const { status, data } = await client("bullet-page").call("/s/multi-2026");
    eq(status, 200, "status");
    // The register screen is what renders first, so this only checks the page
    // builds at all with the bulleted question in the set behind it.
    assert(data.includes("Quiz Challenge"), "the event page did not render");
  });

  await test("the question bank page renders the bulleted question", async () => {
    const { status, data } = await admin.call("/admin/questions");
    eq(status, 200, "status");
    assert(data.includes("Questions"), "the question bank did not render");
  });

  await test("wording over the length or line limit is refused", async () => {
    const tooLong = {
      setId: multiSetId,
      options: ["a", "b", "c"],
      correctIndexes: [0],
      text: "x".repeat(2001),
    };
    eq((await admin.call("/api/admin/questions", { method: "POST", body: tooLong })).status, 422, "2001 characters");

    const tooManyLines = {
      ...tooLong,
      text: ["Q?", ...Array.from({ length: 40 }, (_, i) => `- item ${i}`)].join("\n"),
    };
    eq(
      (await admin.call("/api/admin/questions", { method: "POST", body: tooManyLines })).status,
      422,
      "41 lines",
    );
    return "both refused";
  });

  await test("the answer sheet and the export keep the list readable", async () => {
    const c = client("bullet-player");
    const { data: start } = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "multi-2026", name: "Bullet Player", phone: "9871000007" },
    });
    const answers = await answersFor(emu.db, start.attemptId);
    await c.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: start.attemptId, answers, elapsedMs: 6000 },
    });

    const org = await admin.call(`/api/admin/organizations/${multiOrgId}`);
    const player = org.data.results.find((r) => r.name === "Bullet Player");
    assert(player, "the run is missing from the results");

    // The answer sheet keeps the wording exactly, so the panel can draw the list.
    const sheet = await admin.call(`/api/admin/attempts/${player.id}`);
    const row = sheet.data.answers.find((a) => a.question_text.startsWith("Which of these are true"));
    assert(row, "the bulleted question is missing from the sheet");
    eq(row.question_text, BULLET_STORED, "wording in the answer sheet");

    // A spreadsheet cell is one line, so the export flattens it with • markers.
    const dl = await admin.call(`/api/admin/organizations/${multiOrgId}/export`, { raw: true });
    eq(dl.status, 200, "export status");
    const wb = XLSX.read(Buffer.from(await dl.res.arrayBuffer()), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Question Analysis"]);
    const flat = rows.find((r) => String(r.Question).startsWith("Which of these are true"));
    assert(flat, "the bulleted question is missing from the export");
    assert(!String(flat.Question).includes("\n"), `the cell still has newlines: ${flat.Question}`);
    assert(String(flat.Question).includes("•"), `bullets were lost: ${flat.Question}`);
    return `export cell: "${String(flat.Question).slice(0, 60)}…"`;
  });

  await test("the bulleted question can be removed again", async () => {
    const { status } = await admin.call(`/api/admin/questions/${bulletQuestionId}`, {
      method: "DELETE",
    });
    eq(status, 200, "status");
  });

  section("Admin — people and roles");

  await test("the people database is searchable", async () => {
    const all = await admin.call("/api/admin/participants");
    eq(all.status, 200, "status");
    assert(all.data.total >= 8, `total was ${all.data.total}`);

    const byName = await admin.call("/api/admin/participants?q=asha");
    eq(byName.data.participants.length, 1, "search by name");
    eq(byName.data.participants[0].phone, "9800000001", "matched phone");

    const byPhone = await admin.call("/api/admin/participants?q=9800000002");
    eq(byPhone.data.participants.length, 1, "search by mobile");
    eq(byPhone.data.participants[0].name, "Bhavya N", "matched name");

    const byOrganization = await admin.call(`/api/admin/participants?organizationId=${secondId}`);
    assert(byOrganization.data.participants.length >= 4, "filter by organization found too few");
    assert(
      byOrganization.data.participants.every((p) => Number(p.organization_id) === Number(secondId)),
      "filter by organization leaked another organization's students",
    );
    return `${all.data.total} people, search by name/mobile/organization all work`;
  });

  let viewer;
  await test("a view-only account can be created and can read", async () => {
    const { status } = await admin.call("/api/admin/users", {
      method: "POST",
      body: {
        name: "Read Only",
        email: "viewer@garbhagudi.com",
        role: "viewer",
        password: "ViewerPassword!1",
      },
    });
    eq(status, 201, "create status");

    viewer = client("viewer");
    const signin = await viewer.call("/api/admin/session", {
      method: "POST",
      body: { email: "viewer@garbhagudi.com", password: "ViewerPassword!1" },
    });
    eq(signin.status, 200, "sign-in status");
    eq(signin.data.admin.role, "viewer", "role");

    const read = await viewer.call(`/api/admin/organizations/${organizationId}`);
    eq(read.status, 200, "read status");
    eq(read.data.results[0].name, "Bhavya N", "viewer can see the winner");
  });

  await test("a viewer cannot change anything", async () => {
    const attempts = [
      ["/api/admin/organizations", "POST", { name: "Nope College", slug: "nope-1", questionSetId: setId }],
      [`/api/admin/organizations/${organizationId}`, "PATCH", { name: "Renamed", slug: "demo", questionSetId: setId }],
      ["/api/admin/questions", "POST", { setId, text: "Sneaky question", options: ["a", "b"], correctIndex: 0 }],
      [`/api/admin/organizations/${organizationId}?mode=entries&confirm=demo`, "DELETE", undefined],
      ["/api/admin/users", "POST", { name: "X Y", email: "x@y.com", role: "owner", password: "Password!!123" }],
    ];
    for (const [path, method, body] of attempts) {
      const { status } = await viewer.call(path, { method, body });
      assert(status === 403, `${method} ${path} returned ${status}, expected 403`);
    }

    // Uploading is a write too, and it does not go through the JSON helper.
    const up = await uploadTo(viewer, "/api/admin/uploads", {
      name: "nope.png",
      mime: "image/png",
      bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"),
    });
    assert(up.status === 403, `uploading returned ${up.status}, expected 403`);

    return "6 write attempts all 403, uploads included";
  });

  await test("a viewer cannot manage the team even to read-and-write itself", async () => {
    const { status } = await viewer.call("/api/admin/users/1", {
      method: "PATCH",
      body: { role: "owner" },
    });
    eq(status, 403, "status");
  });

  await test("the last owner cannot be demoted or disabled", async () => {
    const { data } = await admin.call("/api/admin/users");
    const owner = data.users.find((u) => u.role === "owner");
    const demote = await admin.call(`/api/admin/users/${owner.id}`, {
      method: "PATCH",
      body: { role: "admin" },
    });
    eq(demote.status, 409, "demote status");
    const disable = await admin.call(`/api/admin/users/${owner.id}`, {
      method: "PATCH",
      body: { isActive: false },
    });
    eq(disable.status, 409, "disable status");
    return "both refused with 409";
  });

  await test("you cannot delete the account you are signed in with", async () => {
    const { data } = await admin.call("/api/admin/session");
    const { status } = await admin.call(`/api/admin/users/${data.admin.id}`, { method: "DELETE" });
    eq(status, 409, "status");
  });

  await test("a disabled account cannot sign in", async () => {
    const { data } = await admin.call("/api/admin/users");
    const v = data.users.find((u) => u.email === "viewer@garbhagudi.com");
    await admin.call(`/api/admin/users/${v.id}`, { method: "PATCH", body: { isActive: false } });
    const c = client("disabled");
    const { status, data: body } = await c.call("/api/admin/session", {
      method: "POST",
      body: { email: "viewer@garbhagudi.com", password: "ViewerPassword!1" },
    });
    eq(status, 403, "status");
    assert(body.error.includes("disabled"), `message was: ${body.error}`);
  });

  await test("changing your own password requires the current one", async () => {
    const wrong = await admin.call("/api/admin/password", {
      method: "POST",
      body: { currentPassword: "wrong", newPassword: "BrandNewPassword!9" },
    });
    eq(wrong.status, 401, "wrong-current status");

    const tooShort = await admin.call("/api/admin/password", {
      method: "POST",
      body: { currentPassword: ADMIN.password, newPassword: "short" },
    });
    eq(tooShort.status, 422, "too-short status");

    const okChange = await admin.call("/api/admin/password", {
      method: "POST",
      body: { currentPassword: ADMIN.password, newPassword: "BrandNewPassword!9" },
    });
    eq(okChange.status, 200, "change status");

    const fresh = client("after-change");
    const oldPass = await fresh.call("/api/admin/session", { method: "POST", body: ADMIN });
    eq(oldPass.status, 401, "the old password still works");
    const newPass = await fresh.call("/api/admin/session", {
      method: "POST",
      body: { email: ADMIN.email, password: "BrandNewPassword!9" },
    });
    eq(newPass.status, 200, "the new password does not work");
    return "old password rejected, new one accepted";
  });

  section("Admin — the per-organization staff URL");

  await test("/s/<code>/admin shows a sign-in form to an anonymous visitor", async () => {
    const c = client("anon-staff");
    const { status, data } = await c.call("/s/demo/admin");
    eq(status, 200, "status");
    assert(data.includes("Staff sign in"), "the staff sign-in form is missing");
    assert(data.includes("Demo College"), "the organization name is missing");
    assert(!data.includes("9800000001"), "results leaked to an anonymous visitor");
    return "form shown, no data leaked";
  });

  await test("/s/<code>/admin shows that organization's results once signed in", async () => {
    const { status, data } = await admin.call("/s/demo/admin");
    eq(status, 200, "status");
    assert(data.includes("Demo College"), "the organization name is missing");
    assert(data.includes("Full admin panel"), "the link to the full panel is missing");
    return "results view rendered on the organization URL";
  });

  section("Admin — clearing and deleting");

  await test("clearing entries needs the code typed correctly", async () => {
    const { status, data } = await admin.call(
      `/api/admin/organizations/${organizationId}?mode=entries&confirm=wrong-code`,
      { method: "DELETE" },
    );
    eq(status, 400, "status");
    eq(data.field, "confirm", "field");
  });

  await test("clearing entries empties the results but keeps the code working", async () => {
    const { status, data } = await admin.call(
      `/api/admin/organizations/${organizationId}?mode=entries&confirm=demo`,
      { method: "DELETE" },
    );
    eq(status, 200, "status");
    eq(data.deletedEvent, false, "deletedEvent");
    assert(data.removed >= 4, `removed was ${data.removed}`);

    const after = await admin.call(`/api/admin/organizations/${organizationId}`);
    eq(after.data.summary.registered, 0, "registered after clearing");
    eq(after.data.results.length, 0, "results after clearing");

    const still = await admin.call("/api/public/organization?code=demo");
    eq(still.status, 200, "the code stopped working after clearing");
    return `${data.removed} entries removed, code "demo" still live`;
  });

  await test("clearing does not touch the question bank", async () => {
    const { data } = await admin.call(`/api/admin/questions?setId=${setId}`);
    eq(data.questions.length, 15, "question count after clearing");
  });

  await test("deleting an organization removes it and its link", async () => {
    const { status, data } = await admin.call(
      `/api/admin/organizations/${secondId}?mode=all&confirm=xavier-2026`,
      { method: "DELETE" },
    );
    eq(status, 200, "status");
    eq(data.deletedEvent, true, "deletedEvent");

    const gone = await admin.call("/api/public/organization?code=xavier-2026");
    eq(gone.status, 404, "the deleted code still resolves");
    return `deleted, ${data.removed} entries with it`;
  });

  section("Admin — nothing is really deleted");

  await test("a deleted event is still in the database, flagged", async () => {
    const { status, data } = await admin.call("/api/admin/deleted");
    eq(status, 200, "status");
    const events = data.deleted.organization;
    const row = events.find((e) => e.detail === "xavier-2026");
    assert(row, `the deleted event is not in the recycle bin: ${JSON.stringify(events)}`);
    assert(row.deleted_by === ADMIN.email, `deleted_by was ${row.deleted_by}`);
    assert(row.deleted_at, "no deletion timestamp was recorded");
    return `listed, removed by ${row.deleted_by}`;
  });

  await test("the students deleted with it are listed too", async () => {
    const { data } = await admin.call("/api/admin/deleted");
    const people = data.deleted.participant.filter((p) => p.parent_deleted);
    assert(people.length >= 4, `expected the event's students, found ${people.length}`);
    return `${people.length} students kept`;
  });

  await test("a deleted event is hidden from every live view", async () => {
    const list = await admin.call("/api/admin/organizations");
    assert(
      !list.data.organizations.some((o) => o.slug === "xavier-2026"),
      "the deleted event still appears in the organizations list",
    );
    const people = await admin.call("/api/admin/participants?q=Student");
    assert(
      people.data.participants.every((p) => p.organization_slug !== "xavier-2026"),
      "students of a deleted event still appear in the people search",
    );
    return "absent from the event list and the people search";
  });

  await test("asking for deleted rows explicitly brings them back into view", async () => {
    const list = await admin.call("/api/admin/organizations?deleted=1");
    const row = list.data.organizations.find((o) => o.slug === "xavier-2026");
    assert(row, "?deleted=1 did not include the deleted event");
    assert(row.is_deleted === true, "the row is not flagged as deleted");
    return "?deleted=1 shows it, flagged";
  });

  await test("its code is free for a new event to take", async () => {
    const { status, data } = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: { name: "Xavier Again", slug: "xavier-2026", questionSetId: setId },
    });
    eq(status, 201, "status");
    // Put it back the way it was, so the restore test below is the real thing.
    await admin.call(
      `/api/admin/organizations/${data.organization.id}?mode=all&confirm=xavier-2026`,
      { method: "DELETE" },
    );
    return "the freed code was accepted";
  });

  await test("restoring is refused while a live event holds the code", async () => {
    const created = await admin.call("/api/admin/organizations", {
      method: "POST",
      body: { name: "Squatter College", slug: "xavier-2026", questionSetId: setId },
    });
    eq(created.status, 201, "squatter created");

    const { status, data } = await admin.call("/api/admin/deleted", {
      method: "POST",
      body: { kind: "organization", id: secondId },
    });
    eq(status, 409, "status");
    assert(data.error.includes("xavier-2026"), `message was: ${data.error}`);

    await admin.call(
      `/api/admin/organizations/${created.data.organization.id}?mode=all&confirm=xavier-2026`,
      { method: "DELETE" },
    );
    return "refused with the clash named";
  });

  await test("restoring the event brings back its students and attempts", async () => {
    const { status, data } = await admin.call("/api/admin/deleted", {
      method: "POST",
      body: { kind: "organization", id: secondId },
    });
    eq(status, 200, "status");
    assert(data.counts.participants >= 4, `only ${data.counts.participants} students came back`);

    const live = await admin.call("/api/admin/organizations");
    assert(
      live.data.organizations.some((o) => o.slug === "xavier-2026"),
      "the event is not back in the list",
    );
    const code = await admin.call("/api/public/organization?code=xavier-2026");
    eq(code.status, 200, "the code does not work again");
    return `event, ${data.counts.participants} students and ${data.counts.attempts} attempts back`;
  });

  await test("cleared entries can be restored to an event that was never deleted", async () => {
    const before = await admin.call(`/api/admin/organizations/${organizationId}`);
    eq(before.data.summary.registered, 0, "the demo event should still be cleared");

    const bin = await admin.call("/api/admin/deleted");
    const mine = bin.data.deleted.participant.filter(
      (p) => p.parent === "Demo College" && !p.parent_deleted,
    );
    assert(mine.length >= 4, `expected the cleared students in the bin, found ${mine.length}`);

    for (const person of mine) {
      const r = await admin.call("/api/admin/deleted", {
        method: "POST",
        body: { kind: "participant", id: person.id },
      });
      eq(r.status, 200, `restoring ${person.label}`);
    }

    const after = await admin.call(`/api/admin/organizations/${organizationId}`);
    assert(after.data.summary.registered >= 4, "the students did not come back");
    assert(after.data.results.length >= 4, "their results did not come back");
    eq(after.data.results[0].name, "Bhavya N", "the leaderboard did not rebuild correctly");
    return `${after.data.summary.registered} students and their scores restored`;
  });

  await test("a deleted question stays in the bank and can be put back", async () => {
    const liveBefore = (await admin.call(`/api/admin/questions?setId=${setId}`)).data.questions;
    const allBefore = (await admin.call(`/api/admin/questions?setId=${setId}&deleted=1`)).data
      .questions;
    const victim = liveBefore[0];

    const del = await admin.call(`/api/admin/questions/${victim.id}`, { method: "DELETE" });
    eq(del.status, 200, "delete status");
    eq(del.data.recoverable, true, "the response does not say it is recoverable");

    const liveAfter = (await admin.call(`/api/admin/questions?setId=${setId}`)).data.questions;
    const allAfter = (await admin.call(`/api/admin/questions?setId=${setId}&deleted=1`)).data
      .questions;
    eq(liveAfter.length, liveBefore.length - 1, "live question count after deleting");
    // The whole point: the row is still there.
    eq(allAfter.length, allBefore.length, "nothing left the questions table");

    const back = await admin.call("/api/admin/deleted", {
      method: "POST",
      body: { kind: "question", id: victim.id },
    });
    eq(back.status, 200, "restore status");
    const restored = (await admin.call(`/api/admin/questions?setId=${setId}`)).data.questions;
    eq(restored.length, liveBefore.length, "live question count after restoring");
    return `${liveBefore.length} live of ${allBefore.length} kept, one removed and put back`;
  });

  await test("a deleted team member cannot sign in, and can be reinstated", async () => {
    const created = await admin.call("/api/admin/users", {
      method: "POST",
      body: {
        name: "Temp Staff",
        email: "temp@garbhagudi.com",
        role: "admin",
        password: "TempPassword!123",
      },
    });
    eq(created.status, 201, "create status");
    const tempId = created.data.user.id;

    await admin.call(`/api/admin/users/${tempId}`, { method: "DELETE" });

    const blocked = client("deleted-staff");
    const attempt = await blocked.call("/api/admin/session", {
      method: "POST",
      body: { email: "temp@garbhagudi.com", password: "TempPassword!123" },
    });
    eq(attempt.status, 401, "a deleted account could still sign in");

    const back = await admin.call("/api/admin/deleted", {
      method: "POST",
      body: { kind: "adminUser", id: tempId },
    });
    eq(back.status, 200, "restore status");

    const retry = client("restored-staff");
    const ok2 = await retry.call("/api/admin/session", {
      method: "POST",
      body: { email: "temp@garbhagudi.com", password: "TempPassword!123" },
    });
    eq(ok2.status, 200, "the restored account cannot sign in");
    await admin.call(`/api/admin/users/${tempId}`, { method: "DELETE" });
    return "sign-in blocked while deleted, working again after restore";
  });

  await test("a student whose entry was deleted can register again", async () => {
    // An earlier test closed this event; reopen it so registration is possible.
    await admin.call(`/api/admin/organizations/${organizationId}`, {
      method: "PATCH",
      body: { isOpen: true },
    });
    const c = client("re-register");
    const first = await c.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Rejoin R", phone: "9855000001", email: "r@x.com" },
    });
    eq(first.status, 200, "first registration");

    const people = await admin.call("/api/admin/participants?q=9855000001");
    const id = people.data.participants[0].id;
    await admin.call(`/api/admin/participants?id=${id}`, { method: "DELETE" });

    const again = client("re-register-2");
    const second = await again.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Rejoin R", phone: "9855000001", email: "r@x.com" },
    });
    eq(second.status, 200, "the freed mobile number was refused");

    // The point of this change: one row, revived — not a second row with a
    // second copy of their email address.
    const all = await admin.call("/api/admin/participants?q=9855000001&deleted=1");
    eq(all.data.participants.length, 1, "registering again created a duplicate row");
    eq(all.data.participants[0].is_deleted, false, "the row is still flagged as deleted");
    eq(String(all.data.participants[0].id), String(id), "a different row was used");

    // Finish the quiz this time. The retake rule counts completed attempts, so
    // only now is the number spoken for again.
    const answers = await answersFor(emu.db, second.data.attemptId, 5);
    const submitted = await again.call("/api/quiz/submit", {
      method: "POST",
      body: { attemptId: second.data.attemptId, answers, elapsedMs: 9000 },
    });
    eq(submitted.status, 200, "submit status");

    const third = client("re-register-3");
    const blocked = await third.call("/api/quiz/start", {
      method: "POST",
      body: { slug: "demo", name: "Rejoin R", phone: "9855000001", email: "r@x.com" },
    });
    eq(blocked.status, 409, "the revived student was allowed to play a second time");
    return "one row revived, played once, then blocked again";
  });

  await test("the recycle bin records who deleted what", async () => {
    const { data } = await admin.call("/api/admin/deleted");
    const rows = Object.values(data.deleted).flat();
    assert(rows.length > 0, "the bin is empty");
    assert(
      rows.every((r) => r.deleted_at),
      "a row in the bin has no deletion timestamp",
    );
    const named = rows.filter((r) => r.deleted_by === ADMIN.email).length;
    assert(named > 0, "no row records who deleted it");
    return `${rows.length} rows kept, ${named} attributed`;
  });

  section("Admin — audit trail");

  await test("the activity log recorded what happened", async () => {
    const { status, data } = await admin.call("/api/admin/audit?limit=200");
    eq(status, 200, "status");
    const actions = new Set(data.entries.map((e) => e.action));
    for (const expected of [
      "signin",
      "organization.create",
      "organization.update",
      "organization.delete",
      "organization.clearEntries",
      "organization.export",
      "question.create",
      "question.update",
      "question.delete",
      "question.reorder",
      "user.create",
      "password.change",
    ]) {
      assert(actions.has(expected), `"${expected}" is missing from the log`);
    }
    assert(
      data.entries.every((e) => e.admin_email),
      "an entry has no admin email attached",
    );
    return `${data.entries.length} entries covering ${actions.size} action types`;
  });

  await test("signing out invalidates the admin session", async () => {
    await admin.call("/api/admin/session", { method: "DELETE" });
    assert(!admin.jar.has("gg_admin"), "the admin cookie survived sign-out");
    const { status } = await admin.call("/api/admin/organizations");
    eq(status, 401, "status after sign-out");
  });

  await test("a tampered session cookie is rejected", async () => {
    const c = client("tampered");
    await c.call("/api/admin/session", {
      method: "POST",
      body: { email: ADMIN.email, password: "BrandNewPassword!9" },
    });
    const token = c.jar.get("gg_admin");
    // Change the first character of the signature. The trailing base64url
    // character only carries a few significant bits, so flipping *that* can
    // decode to the same signature — the first one always differs.
    const [header, payload, signature] = token.split(".");
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    c.jar.set("gg_admin", `${header}.${payload}.${flipped}`);
    const { status } = await c.call("/api/admin/organizations");
    eq(status, 401, "status with a tampered cookie");
  });

  await finish();
} catch (e) {
  console.log(`\n  Harness error: ${e.stack ?? e.message}`);
  await finish(1);
}
