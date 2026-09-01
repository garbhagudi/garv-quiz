/**
 * Runs the real schema and every non-trivial query in this app against a real
 * Postgres engine (PGlite — Postgres 16 compiled to WASM), so SQL mistakes are
 * caught here rather than at an event.
 *
 *   node scripts/verify-sql.mjs
 *
 * This touches no network and no Neon project. It is a developer check, not
 * part of the deployed app.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new PGlite();

let pass = 0;
const failures = [];

async function step(label, fn) {
  try {
    const out = await fn();
    pass++;
    console.log(`  ok    ${label}${out ? ` — ${out}` : ""}`);
  } catch (e) {
    failures.push({ label, message: e.message });
    console.log(`  FAIL  ${label}\n        ${e.message}`);
  }
}

function statements(text) {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

console.log("\nVerifying SQL against Postgres (PGlite)\n");

/* ------------------------------- schema ---------------------------------- */

await step("schema applies cleanly", async () => {
  const stmts = statements(readFileSync(join(root, "db", "schema.sql"), "utf8"));
  for (const s of stmts) await db.exec(s);
  return `${stmts.length} statements`;
});

await step("schema is idempotent (re-run)", async () => {
  for (const s of statements(readFileSync(join(root, "db", "schema.sql"), "utf8"))) await db.exec(s);
  return "no errors on second run";
});

/* -------------------------------- seed ----------------------------------- */

let setId, organizationId, questionIds = [];

await step("seed question set + questions", async () => {
  const set = await db.query(
    `INSERT INTO question_sets (name, description) VALUES ($1, $2) RETURNING id`,
    ["Embryology", "seed"],
  );
  setId = set.rows[0].id;
  for (let i = 0; i < 5; i++) {
    const q = await db.query(
      `INSERT INTO questions (set_id, position, text, options, correct_index, points)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
      [setId, i, `Question ${i + 1}?`, JSON.stringify(["A", "B", "C", "D"]), i % 4, i === 4 ? 2 : 1],
    );
    questionIds.push(q.rows[0].id);
  }
  return `set ${setId}, ${questionIds.length} questions`;
});

await step("question CHECK constraints reject a bad answer key", async () => {
  try {
    await db.query(
      `INSERT INTO questions (set_id, text, options, correct_index)
       VALUES ($1, 'bad', $2::jsonb, 9)`,
      [setId, JSON.stringify(["A", "B"])],
    );
    throw new Error("expected the correct_index CHECK to reject index 9");
  } catch (e) {
    if (e.message.includes("expected the correct_index")) throw e;
    return "rejected as designed";
  }
});

await step("question CHECK rejects fewer than two options", async () => {
  try {
    await db.query(
      `INSERT INTO questions (set_id, text, options, correct_index)
       VALUES ($1, 'bad', $2::jsonb, 0)`,
      [setId, JSON.stringify(["only one"])],
    );
    throw new Error("expected the min-two-options CHECK to fire");
  } catch (e) {
    if (e.message.includes("expected the min-two")) throw e;
    return "rejected as designed";
  }
});

await step("create organization", async () => {
  const r = await db.query(
    `INSERT INTO organizations (slug, name, city, question_set_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    ["demo", "Demo College", "Bengaluru", setId],
  );
  organizationId = r.rows[0].id;
  return `organization ${organizationId}`;
});

await step("slug uniqueness is case-insensitive", async () => {
  try {
    await db.query(`INSERT INTO organizations (slug, name) VALUES ('DEMO', 'Clash')`);
    throw new Error("expected organizations_slug_key to reject DEMO vs demo");
  } catch (e) {
    if (e.message.includes("expected organizations_slug_key")) throw e;
    if (!e.message.includes("organizations_slug_key"))
      throw new Error(`wrong constraint fired: ${e.message}`);
    return "rejected, and the error names organizations_slug_key";
  }
});

/* --------------------- quiz/start: upsert participant --------------------- */

const students = [
  { name: "Asha Rao", phone: "9800000001", email: "asha@x.com", score: 5, ms: 12000 },
  { name: "Bhavya N", phone: "9800000002", email: "bhavya@x.com", score: 5, ms: 9000 },
  { name: "Chetan K", phone: "9800000003", email: "chetan@x.com", score: 3, ms: 20000 },
  { name: "Divya S", phone: "9800000004", email: "divya@x.com", score: 0, ms: 40000 },
];
const participantIds = {};

await step("participant upsert (ON CONFLICT) works twice", async () => {
  for (const s of students) {
    for (const pass of [0, 1]) {
      const r = await db.query(
        `INSERT INTO participants (organization_id, name, phone, email, class_or_year)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (organization_id, phone) WHERE is_deleted = false DO UPDATE
            SET name = EXCLUDED.name,
                email = CASE WHEN EXCLUDED.email = '' THEN participants.email ELSE EXCLUDED.email END,
                class_or_year = CASE WHEN EXCLUDED.class_or_year = '' THEN participants.class_or_year
                                     ELSE EXCLUDED.class_or_year END
         RETURNING id`,
        [organizationId, s.name, s.phone, pass === 0 ? s.email : "", ""],
      );
      participantIds[s.phone] = r.rows[0].id;
    }
  }
  const c = await db.query(`SELECT count(*)::int n FROM participants WHERE organization_id = $1`, [organizationId]);
  if (c.rows[0].n !== students.length) throw new Error(`expected 4 participants, got ${c.rows[0].n}`);
  const e = await db.query(`SELECT email FROM participants WHERE phone = '9800000001'`);
  if (e.rows[0].email !== "asha@x.com")
    throw new Error("second insert with a blank email wiped the stored one");
  return "4 rows, blank email did not overwrite";
});

/* ---------------------- attempts + the answers insert -------------------- */

const attemptIds = {};

await step("open attempts and store the served snapshot", async () => {
  for (const s of students) {
    const served = questionIds.map((qid, i) => ({
      p: i,
      qid: Number(qid),
      text: `Question ${i + 1}?`,
      opts: ["A", "B", "C", "D"],
      ci: i % 4,
      pts: i === 4 ? 2 : 1,
    }));
    const r = await db.query(
      `INSERT INTO attempts (participant_id, organization_id, question_set_id, served,
                             question_count, max_score, ip_hash, user_agent)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING id, public_id`,
      [participantIds[s.phone], organizationId, setId, JSON.stringify(served), served.length, 6, "hash", "ua"],
    );
    attemptIds[s.phone] = r.rows[0];
  }
  return `${students.length} attempts, public_id generated by gen_random_uuid()`;
});

await step("answers bulk insert via jsonb_array_elements", async () => {
  for (const s of students) {
    const rows = questionIds.map((qid, i) => ({
      questionId: Number(qid),
      position: i,
      questionText: `Question ${i + 1}?`,
      chosenText: i < s.score ? "A" : "B",
      correctText: "A",
      isCorrect: i < s.score,
      points: i < s.score ? 1 : 0,
      ms: Math.round(s.ms / 5),
    }));
    await db.query(
      `INSERT INTO answers (attempt_id, question_id, position, question_text,
                            chosen_text, correct_text, is_correct, points, ms)
       SELECT $1,
              NULLIF(r->>'questionId','')::bigint,
              (r->>'position')::int,
              r->>'questionText',
              r->>'chosenText',
              r->>'correctText',
              (r->>'isCorrect')::boolean,
              (r->>'points')::int,
              (r->>'ms')::int
         FROM jsonb_array_elements($2::jsonb) AS r
       ON CONFLICT (attempt_id, position) DO NOTHING`,
      [attemptIds[s.phone].id, JSON.stringify(rows)],
    );
  }
  const c = await db.query(`SELECT count(*)::int n FROM answers`);
  if (c.rows[0].n !== students.length * 5)
    throw new Error(`expected ${students.length * 5} answers, got ${c.rows[0].n}`);
  return `${c.rows[0].n} answers`;
});

await step("re-submitting the same attempt inserts nothing (ON CONFLICT DO NOTHING)", async () => {
  const before = (await db.query(`SELECT count(*)::int n FROM answers`)).rows[0].n;
  const s = students[0];
  const rows = questionIds.map((qid, i) => ({
    questionId: Number(qid),
    position: i,
    questionText: "x",
    chosenText: "x",
    correctText: "A",
    isCorrect: false,
    points: 0,
    ms: 1,
  }));
  await db.query(
    `INSERT INTO answers (attempt_id, question_id, position, question_text,
                          chosen_text, correct_text, is_correct, points, ms)
     SELECT $1, NULLIF(r->>'questionId','')::bigint, (r->>'position')::int, r->>'questionText',
            r->>'chosenText', r->>'correctText', (r->>'isCorrect')::boolean,
            (r->>'points')::int, (r->>'ms')::int
       FROM jsonb_array_elements($2::jsonb) AS r
     ON CONFLICT (attempt_id, position) DO NOTHING`,
    [attemptIds[s.phone].id, JSON.stringify(rows)],
  );
  const after = (await db.query(`SELECT count(*)::int n FROM answers`)).rows[0].n;
  if (before !== after) throw new Error(`duplicate insert added ${after - before} rows`);
  return "no duplicates";
});

await step("complete the attempts", async () => {
  for (const s of students) {
    await db.query(
      `UPDATE attempts
          SET status='completed', score=$2, max_score=6, correct_count=$3,
              question_count=5, answer_ms=$4, elapsed_ms=$5, submitted_at=now()
        WHERE id=$1 AND status='in_progress'`,
      [attemptIds[s.phone].id, s.score, s.score, s.ms, s.ms + 3000],
    );
  }
  return "4 completed";
});

/* ---------------------------- ranking queries ----------------------------
   Students are shown no ranking at all any more, but the admin live board still
   picks one best attempt per student and orders by score then answer time, so
   these keep covering that. */

await step("the admin board orders by score then answer time", async () => {
  const r = await db.query(
    `WITH best AS (
       SELECT DISTINCT ON (a.participant_id)
              a.id, a.public_id, a.participant_id, a.score, a.max_score,
              a.correct_count, a.question_count, a.answer_ms, a.elapsed_ms, a.submitted_at,
              p.name, p.phone, p.email, p.class_or_year
         FROM attempts a
         JOIN participants p ON p.id = a.participant_id
        WHERE a.organization_id = $1 AND a.status = 'completed'
        ORDER BY a.participant_id, a.score DESC, a.answer_ms ASC, a.submitted_at ASC
     )
     SELECT *, ROW_NUMBER() OVER (ORDER BY score DESC, answer_ms ASC, submitted_at ASC)::int AS rank
       FROM best ORDER BY rank ASC`,
    [organizationId],
  );
  const order = r.rows.map((x) => x.name);
  // Bhavya ties Asha on 5 points but answered faster, so she must rank first.
  const want = ["Bhavya N", "Asha Rao", "Chetan K", "Divya S"];
  if (JSON.stringify(order) !== JSON.stringify(want))
    throw new Error(`wrong order: ${order.join(", ")}`);
  if (r.rows[0].rank !== 1) throw new Error("rank did not start at 1");
  return order.join(" > ");
});

await step("a retake does not put one student on the admin board twice", async () => {
  const asha = participantIds["9800000001"];
  const served = [{ p: 0, qid: Number(questionIds[0]), text: "q", opts: ["A", "B"], ci: 0, pts: 1 }];
  const r = await db.query(
    `INSERT INTO attempts (participant_id, organization_id, question_set_id, served, question_count,
                           max_score, status, score, correct_count, answer_ms, elapsed_ms, submitted_at)
     VALUES ($1,$2,$3,$4::jsonb,1,6,'completed',6,5,3000,4000,now()) RETURNING id`,
    [asha, organizationId, setId, JSON.stringify(served)],
  );
  const board = await db.query(
    `WITH best AS (
       SELECT DISTINCT ON (a.participant_id) a.participant_id, a.score, a.answer_ms, a.submitted_at, p.name
         FROM attempts a JOIN participants p ON p.id = a.participant_id
        WHERE a.organization_id = $1 AND a.status='completed'
        ORDER BY a.participant_id, a.score DESC, a.answer_ms ASC, a.submitted_at ASC)
     SELECT name, score, ROW_NUMBER() OVER (ORDER BY score DESC, answer_ms ASC, submitted_at ASC)::int rank
       FROM best ORDER BY rank`,
    [organizationId],
  );
  const names = board.rows.map((x) => x.name);
  if (new Set(names).size !== names.length) throw new Error(`duplicate on board: ${names.join(", ")}`);
  if (names[0] !== "Asha Rao")
    throw new Error(`Asha's better retake (6 pts) should lead, got ${names[0]}`);
  await db.query(`DELETE FROM attempts WHERE id = $1`, [r.rows[0].id]);
  return "best attempt only, 4 unique names";
});

await step("allAttemptsRanked returns attempt_no and attempts_by_student", async () => {
  const r = await db.query(
    `SELECT a.id, p.name,
            ROW_NUMBER() OVER (ORDER BY a.score DESC, a.answer_ms ASC, a.submitted_at ASC)::int AS rank,
            ROW_NUMBER() OVER (PARTITION BY a.participant_id ORDER BY a.started_at ASC)::int AS attempt_no,
            COUNT(*) OVER (PARTITION BY a.participant_id)::int AS attempts_by_student
       FROM attempts a JOIN participants p ON p.id = a.participant_id
      WHERE a.organization_id = $1 AND a.status = 'completed'
      ORDER BY rank ASC`,
    [organizationId],
  );
  if (r.rows.length !== 4) throw new Error(`expected 4 rows, got ${r.rows.length}`);
  if (!r.rows.every((x) => x.attempt_no === 1 && x.attempts_by_student === 1))
    throw new Error("attempt numbering is wrong for single-attempt students");
  return "4 rows numbered correctly";
});

await step("organizationSummary aggregates", async () => {
  const r = await db.query(
    `SELECT
       (SELECT count(*)::int FROM participants WHERE organization_id = $1) AS registered,
       (SELECT count(*)::int FROM attempts WHERE organization_id = $1 AND status='completed') AS completed,
       (SELECT count(*)::int FROM attempts WHERE organization_id = $1 AND status='in_progress') AS in_progress,
       (SELECT COALESCE(round(avg(score)::numeric,2),0)::float FROM attempts
          WHERE organization_id = $1 AND status='completed') AS avg_score,
       (SELECT COALESCE(max(score),0)::int FROM attempts
          WHERE organization_id = $1 AND status='completed') AS top_score,
       (SELECT COALESCE(max(max_score),0)::int FROM attempts
          WHERE organization_id = $1 AND status='completed') AS out_of,
       (SELECT COALESCE(round(avg(answer_ms)::numeric,0),0)::int FROM attempts
          WHERE organization_id = $1 AND status='completed') AS avg_answer_ms`,
    [organizationId],
  );
  const s = r.rows[0];
  if (s.registered !== 4 || s.completed !== 4) throw new Error(JSON.stringify(s));
  if (s.avg_score !== 3.25) throw new Error(`avg_score should be 3.25, got ${s.avg_score}`);
  return `registered ${s.registered}, avg ${s.avg_score}, top ${s.top_score}/${s.out_of}`;
});

await step("questionAnalysis groups per question", async () => {
  const r = await db.query(
    `SELECT ans.question_text,
            max(ans.correct_text) AS correct_text,
            count(*)::int AS asked,
            count(*) FILTER (WHERE ans.is_correct)::int AS got_right,
            round(100.0 * count(*) FILTER (WHERE ans.is_correct) / GREATEST(count(*),1),1)::float AS pct_correct,
            round(avg(ans.ms)::numeric,0)::int AS avg_ms
       FROM answers ans JOIN attempts a ON a.id = ans.attempt_id
      WHERE a.organization_id = $1 AND a.status='completed'
      GROUP BY ans.question_text
      ORDER BY pct_correct ASC`,
    [organizationId],
  );
  if (r.rows.length !== 5) throw new Error(`expected 5 questions, got ${r.rows.length}`);
  if (r.rows[0].pct_correct > r.rows[4].pct_correct)
    throw new Error("hardest-first ordering is inverted");
  return `${r.rows.length} questions, hardest ${r.rows[0].pct_correct}%`;
});

await step("platformStats aggregates", async () => {
  const r = await db.query(
    `SELECT
       (SELECT count(*)::int FROM organizations) AS organizations,
       (SELECT count(*)::int FROM organizations WHERE is_open) AS organizations_open,
       (SELECT count(*)::int FROM participants) AS participants,
       (SELECT count(*)::int FROM attempts WHERE status='completed') AS attempts,
       (SELECT count(*)::int FROM questions WHERE is_active) AS questions,
       (SELECT count(*)::int FROM question_sets WHERE NOT is_archived) AS sets`,
  );
  return JSON.stringify(r.rows[0]);
});

/* -------------------------- admin list queries --------------------------- */

await step("organizations list query with the '%%' search trick", async () => {
  for (const q of ["", "demo", "Bengaluru", "zzz"]) {
    const like = `%${q}%`;
    const r = await db.query(
      `SELECT s.*, qs.name AS set_name,
              (SELECT count(*)::int FROM participants p WHERE p.organization_id = s.id) AS registered,
              (SELECT count(*)::int FROM attempts a WHERE a.organization_id = s.id AND a.status='completed') AS completed,
              (SELECT count(*)::int FROM questions qn WHERE qn.set_id = s.question_set_id AND qn.is_active) AS set_questions,
              (SELECT max(a.score) FROM attempts a WHERE a.organization_id = s.id AND a.status='completed') AS top_score
         FROM organizations s LEFT JOIN question_sets qs ON qs.id = s.question_set_id
        WHERE s.name ILIKE $1 OR s.slug ILIKE $1 OR s.city ILIKE $1
        ORDER BY s.created_at DESC`,
      [like],
    );
    const expected = q === "zzz" ? 0 : 1;
    if (r.rows.length !== expected)
      throw new Error(`search "${q}" returned ${r.rows.length}, expected ${expected}`);
  }
  return "empty search lists all; a miss returns none";
});

await step("participants search with the nullable organizationId filter", async () => {
  for (const [q, sid, want] of [
    ["", null, 4],
    ["asha", null, 1],
    ["9800000002", null, 1],
    ["", organizationId, 4],
    ["nobody", organizationId, 0],
  ]) {
    const r = await db.query(
      `SELECT p.id FROM participants p JOIN organizations s ON s.id = p.organization_id
        WHERE (p.name ILIKE $1 OR p.phone ILIKE $1 OR p.email ILIKE $1)
          AND ($2::bigint IS NULL OR p.organization_id = $2::bigint)
        ORDER BY p.created_at DESC LIMIT 100 OFFSET 0`,
      [`%${q}%`, sid],
    );
    if (r.rows.length !== want)
      throw new Error(`q="${q}" organization=${sid} returned ${r.rows.length}, expected ${want}`);
  }
  return "all five filter combinations correct";
});

await step("notFinished finds registrations without a completed attempt", async () => {
  await db.query(
    `INSERT INTO participants (organization_id, name, phone, email) VALUES ($1,'Eshan T','9800000005','e@x.com')`,
    [organizationId],
  );
  const r = await db.query(
    `SELECT p.id, p.name,
            (SELECT count(*)::int FROM attempts a WHERE a.participant_id = p.id) AS attempts
       FROM participants p
      WHERE p.organization_id = $1
        AND NOT EXISTS (SELECT 1 FROM attempts a
                         WHERE a.participant_id = p.id AND a.status='completed')
      ORDER BY p.created_at DESC`,
    [organizationId],
  );
  if (r.rows.length !== 1 || r.rows[0].name !== "Eshan T")
    throw new Error(`expected only Eshan T, got ${r.rows.map((x) => x.name).join(", ")}`);
  return "1 unfinished registration found";
});

/* --------------------------- question ordering --------------------------- */

await step("reorder questions via jsonb_array_elements_text WITH ORDINALITY", async () => {
  const reversed = [...questionIds].reverse().map(Number);
  await db.query(
    `UPDATE questions q
        SET position = t.pos, updated_at = now()
       FROM (SELECT (value)::bigint AS id, (ordinality - 1)::int AS pos
               FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY AS x(value, ordinality)) t
      WHERE q.id = t.id AND q.set_id = $2`,
    [JSON.stringify(reversed), setId],
  );
  const r = await db.query(
    `SELECT id FROM questions WHERE set_id = $1 ORDER BY position ASC, id ASC`,
    [setId],
  );
  const got = r.rows.map((x) => Number(x.id));
  if (JSON.stringify(got) !== JSON.stringify(reversed))
    throw new Error(`order is ${got.join(",")}, expected ${reversed.join(",")}`);
  return "order reversed as requested";
});

await step("renumbering closes the gap after a delete", async () => {
  const victim = questionIds[2];
  await db.query(`DELETE FROM questions WHERE id = $1`, [victim]);
  await db.query(
    `WITH renumbered AS (
       SELECT id, (ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) - 1)::int AS pos
         FROM questions WHERE set_id = $1)
     UPDATE questions q SET position = r.pos
       FROM renumbered r WHERE q.id = r.id AND q.position <> r.pos`,
    [setId],
  );
  const r = await db.query(
    `SELECT position FROM questions WHERE set_id = $1 ORDER BY position ASC`,
    [setId],
  );
  const positions = r.rows.map((x) => x.position);
  if (JSON.stringify(positions) !== JSON.stringify([0, 1, 2, 3]))
    throw new Error(`positions are ${positions.join(",")}, expected 0,1,2,3`);
  return "positions are contiguous";
});

await step("deleting a question keeps its answers, with question_id NULL", async () => {
  const r = await db.query(
    `SELECT count(*)::int AS total, count(question_id)::int AS still_linked,
            count(*) FILTER (WHERE question_text <> '')::int AS with_text
       FROM answers`,
  );
  const { total, still_linked, with_text } = r.rows[0];
  if (with_text !== total) throw new Error("answer text snapshots were lost");
  if (still_linked >= total) throw new Error("expected some answers to have a NULL question_id");
  return `${total} answers kept, ${total - still_linked} unlinked but readable`;
});

/* ----------------------------- copy a set -------------------------------- */

await step("duplicating a question set copies its questions", async () => {
  const copy = await db.query(
    `INSERT INTO question_sets (name, description) VALUES ('Copy','') RETURNING id`,
  );
  const copyId = copy.rows[0].id;
  await db.query(
    `INSERT INTO questions (set_id, position, text, options, correct_index, explanation, points, is_active)
     SELECT $1, position, text, options, correct_index, explanation, points, is_active
       FROM questions WHERE set_id = $2 ORDER BY position ASC, id ASC`,
    [copyId, setId],
  );
  const a = await db.query(`SELECT count(*)::int n FROM questions WHERE set_id=$1`, [setId]);
  const b = await db.query(`SELECT count(*)::int n FROM questions WHERE set_id=$1`, [copyId]);
  if (a.rows[0].n !== b.rows[0].n)
    throw new Error(`original has ${a.rows[0].n}, copy has ${b.rows[0].n}`);
  await db.query(`DELETE FROM question_sets WHERE id=$1`, [copyId]);
  return `${b.rows[0].n} questions copied`;
});

/* ------------------- several correct answers, and pictures ---------------- */

await step("the answer key round-trips as a jsonb array", async () => {
  const r = await db.query(
    `INSERT INTO questions (set_id, position, text, options, correct_index, correct_indexes)
     VALUES ($1, 99, 'Which two are gametes?', $2::jsonb, 0, $3::jsonb)
     RETURNING id, correct_index, correct_indexes`,
    [setId, JSON.stringify(["Sperm", "Oocyte", "Zygote", "Morula"]), JSON.stringify([0, 1])],
  );
  const row = r.rows[0];
  if (JSON.stringify(row.correct_indexes) !== "[0,1]")
    throw new Error(`got ${JSON.stringify(row.correct_indexes)}`);
  await db.query(`DELETE FROM questions WHERE id = $1`, [row.id]);
  return "correct_indexes = [0,1]";
});

await step("the answer-key CHECK rejects every unusable shape", async () => {
  const bad = [
    ["an index past the last option", JSON.stringify([0, 9])],
    ["a repeated index", JSON.stringify([1, 1])],
    ["a negative index", JSON.stringify([-1])],
    ["a string where an index belongs", JSON.stringify(["b"])],
    ["a fractional index", JSON.stringify([1.5])],
    ["an object instead of an array", JSON.stringify({ a: 1 })],
    ["more indexes than there are options", JSON.stringify([0, 1, 2, 3, 4])],
    ["null inside the array", JSON.stringify([0, null])],
  ];
  for (const [label, keys] of bad) {
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO questions (set_id, text, options, correct_index, correct_indexes)
         VALUES ($1, 'bad key', $2::jsonb, 0, $3::jsonb)`,
        [setId, JSON.stringify(["A", "B", "C", "D"]), keys],
      );
    } catch (e) {
      // It has to be the named constraint, not a cast error leaking out of the
      // function that backs it.
      if (!e.message.includes("questions_correct_indexes_valid"))
        throw new Error(`${label} failed for the wrong reason: ${e.message}`);
      rejected = true;
    }
    if (!rejected) throw new Error(`the CHECK accepted ${label}`);
  }
  return `${bad.length} bad keys rejected by name`;
});

await step("an empty answer key is allowed, and the schema backfills it", async () => {
  // This is what hand-written SQL and any pre-upgrade row look like.
  const r = await db.query(
    `INSERT INTO questions (set_id, position, text, options, correct_index)
     VALUES ($1, 98, 'Legacy single answer', $2::jsonb, 2)
     RETURNING id, correct_indexes`,
    [setId, JSON.stringify(["A", "B", "C", "D"])],
  );
  const id = r.rows[0].id;
  if (JSON.stringify(r.rows[0].correct_indexes) !== "[]")
    throw new Error("expected the column to default to an empty array");

  // Re-applying the schema is exactly what `npm run db:setup` does on upgrade.
  for (const s of statements(readFileSync(join(root, "db", "schema.sql"), "utf8")))
    await db.exec(s);

  const after = await db.query(`SELECT correct_indexes FROM questions WHERE id = $1`, [id]);
  if (JSON.stringify(after.rows[0].correct_indexes) !== "[2]")
    throw new Error(`backfill wrote ${JSON.stringify(after.rows[0].correct_indexes)}, expected [2]`);
  await db.query(`DELETE FROM questions WHERE id = $1`, [id]);
  return "correct_index 2 became correct_indexes [2]";
});

await step("buildServedQuestions reads the key and the picture", async () => {
  const r = await db.query(
    `INSERT INTO questions (set_id, position, text, options, correct_index, correct_indexes,
                            image_url, image_alt, points)
     VALUES ($1, 97, 'Which two stages come after the zygote?', $2::jsonb, 1, $3::jsonb,
             '/api/media/2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'A dividing embryo', 2)
     RETURNING id`,
    [setId, JSON.stringify(["Oocyte", "Morula", "Blastocyst", "Sperm"]), JSON.stringify([1, 2])],
  );
  const id = r.rows[0].id;
  // The exact projection src/lib/quiz.ts uses to build an attempt.
  const served = await db.query(
    `SELECT id, text, options, correct_index, correct_indexes, image_url, image_alt, points
       FROM questions
      WHERE id = $1 AND is_deleted = false AND is_active = true`,
    [id],
  );
  const q = served.rows[0];
  if (JSON.stringify(q.correct_indexes) !== "[1,2]") throw new Error("answer key not readable");
  if (!q.image_url.startsWith("/api/media/")) throw new Error("image_url not readable");
  if (q.image_alt !== "A dividing embryo") throw new Error("image_alt not readable");
  await db.query(`DELETE FROM questions WHERE id = $1`, [id]);
  return "key [1,2], picture and its description all present";
});

await step("duplicating a set carries the answer key and the picture", async () => {
  const src = await db.query(
    `INSERT INTO question_sets (name) VALUES ('Multi source') RETURNING id`,
  );
  const srcId = src.rows[0].id;
  await db.query(
    `INSERT INTO questions (set_id, position, text, options, correct_index, correct_indexes,
                            image_url, image_alt)
     VALUES ($1, 0, 'Pick both gametes', $2::jsonb, 0, $3::jsonb,
             '/api/media/2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'Two gametes')`,
    [srcId, JSON.stringify(["Sperm", "Oocyte", "Zygote"]), JSON.stringify([0, 1])],
  );

  const copy = await db.query(
    `INSERT INTO question_sets (name) VALUES ('Multi copy') RETURNING id`,
  );
  const copyId = copy.rows[0].id;
  // The exact statement POST /api/admin/sets runs when copyFrom is given.
  await db.query(
    `INSERT INTO questions (set_id, position, text, options, correct_index, correct_indexes,
                            image_url, image_alt, explanation, points, is_active)
     SELECT $1, position, text, options, correct_index, correct_indexes,
            image_url, image_alt, explanation, points, is_active
       FROM questions WHERE set_id = $2 AND is_deleted = false
      ORDER BY position ASC, id ASC`,
    [copyId, srcId],
  );

  const c = await db.query(
    `SELECT correct_indexes, image_url, image_alt FROM questions WHERE set_id = $1`,
    [copyId],
  );
  if (c.rows.length !== 1) throw new Error(`copied ${c.rows.length} questions, expected 1`);
  if (JSON.stringify(c.rows[0].correct_indexes) !== "[0,1]")
    throw new Error("the copy lost its multi-answer key");
  if (c.rows[0].image_alt !== "Two gametes") throw new Error("the copy lost its picture");

  await db.query(`DELETE FROM question_sets WHERE id = ANY($1::bigint[])`, [[srcId, copyId]]);
  return "key and picture both copied";
});

/* ---------------------- a time limit on a question set -------------------- */

await step("a set can be untimed or carry a whole-quiz limit", async () => {
  const untimed = await db.query(
    `SELECT time_limit_seconds FROM question_sets WHERE id = $1`, [setId]);
  if (untimed.rows[0].time_limit_seconds !== null)
    throw new Error("an existing set should default to no limit");

  const timed = await db.query(
    `INSERT INTO question_sets (name, time_limit_seconds) VALUES ('Timed', 600)
     RETURNING id, time_limit_seconds`);
  if (timed.rows[0].time_limit_seconds !== 600) throw new Error("the limit did not stick");
  await db.query(`DELETE FROM question_sets WHERE id = $1`, [timed.rows[0].id]);
  return "null means untimed, 600 means ten minutes";
});

await step("the time-limit CHECK rejects a limit nobody could run", async () => {
  const bad = [
    ["zero", 0],
    ["a negative limit", -60],
    ["under half a minute", 29],
    ["over six hours", 6 * 60 * 60 + 1],
  ];
  for (const [label, seconds] of bad) {
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO question_sets (name, time_limit_seconds) VALUES ('bad', $1)`, [seconds]);
    } catch (e) {
      if (!e.message.includes("question_sets_time_limit_sane"))
        throw new Error(`${label} failed for the wrong reason: ${e.message}`);
      rejected = true;
    }
    if (!rejected) throw new Error(`the CHECK accepted ${label} (${seconds})`);
  }
  return `${bad.length} rejected by name`;
});

await step("the quiz reads the limit off the set the event points at", async () => {
  await db.query(`UPDATE question_sets SET time_limit_seconds = 900 WHERE id = $1`, [setId]);
  // The exact lookup /api/quiz/start runs once it has built the questions.
  const r = await db.query(
    `SELECT qs.time_limit_seconds
       FROM organizations o
       JOIN question_sets qs ON qs.id = o.question_set_id
      WHERE o.id = $1 AND qs.is_deleted = false`, [organizationId]);
  if (r.rows[0].time_limit_seconds !== 900)
    throw new Error(`got ${r.rows[0].time_limit_seconds}, expected 900`);
  await db.query(`UPDATE question_sets SET time_limit_seconds = NULL WHERE id = $1`, [setId]);
  return "15 minutes reached the event through its set";
});

/* ------------------------------- media table ----------------------------- */

await step("an uploaded picture round-trips through bytea as base64", async () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11, 0x22, 0x33,
  ]);
  const owner = await db.query(
    `INSERT INTO admin_users (email, password_hash, name, role)
     VALUES ('uploader@x.com','h','Uploader','admin') RETURNING id`,
  );
  // The exact statement POST /api/admin/uploads runs: bytes travel as base64
  // because the Neon HTTP driver sends every parameter as text.
  const ins = await db.query(
    `INSERT INTO media (mime, bytes, byte_size, original_name, uploaded_by)
     VALUES ('image/png', decode($1,'base64'), $2, 'embryo.png', $3)
     RETURNING id`,
    [png.toString("base64"), png.length, owner.rows[0].id],
  );
  const id = ins.rows[0].id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`id is not a uuid: ${id}`);

  const back = await db.query(
    `SELECT mime, encode(bytes,'base64') AS b64 FROM media WHERE id = $1::uuid`,
    [id],
  );
  const out = Buffer.from(back.rows[0].b64, "base64");
  if (!out.equals(png)) throw new Error("the bytes came back different");
  return `${png.length} bytes, byte-identical`;
});

await step("media CHECKs refuse a non-image type and an oversized file", async () => {
  for (const [label, mime, size] of [
    ["a non-image mime", "text/html", 10],
    ["an svg, which can carry script", "image/svg+xml", 10],
    ["a zero-byte file", "image/png", 0],
    ["a file over 2 MB", "image/png", 2 * 1024 * 1024 + 1],
  ]) {
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO media (mime, bytes, byte_size) VALUES ($1, decode('AAAA','base64'), $2)`,
        [mime, size],
      );
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`the CHECK accepted ${label}`);
  }
  return "4 refused";
});

await step("deleting the admin who uploaded a picture keeps the picture", async () => {
  const owner = await db.query(`SELECT id FROM admin_users WHERE email='uploader@x.com'`);
  await db.query(`DELETE FROM admin_users WHERE id = $1`, [owner.rows[0].id]);
  const r = await db.query(
    `SELECT count(*)::int AS n, count(uploaded_by)::int AS linked FROM media`,
  );
  if (r.rows[0].n === 0) throw new Error("the picture was deleted with the account");
  if (r.rows[0].linked !== 0) throw new Error("uploaded_by was not set to NULL");
  return `${r.rows[0].n} picture kept, uploaded_by is NULL`;
});

/* --------------------------- admin user guards --------------------------- */

await step("admin email uniqueness is case-insensitive", async () => {
  await db.query(
    `INSERT INTO admin_users (email, password_hash, name, role) VALUES ('Owner@x.com','h','Owner','owner')`,
  );
  try {
    await db.query(
      `INSERT INTO admin_users (email, password_hash, name) VALUES ('owner@X.COM','h','Clash')`,
    );
    throw new Error("expected admin_users_email_key to reject the duplicate");
  } catch (e) {
    if (e.message.includes("expected admin_users_email_key")) throw e;
    if (!e.message.includes("admin_users_email_key"))
      throw new Error(`wrong constraint fired: ${e.message}`);
    return "rejected, and the error names admin_users_email_key";
  }
});

await step("activeOwners excludes the row being changed", async () => {
  const r = await db.query(
    `SELECT count(*)::int AS count FROM admin_users
      WHERE role='owner' AND is_active=true
        AND ($1::bigint IS NULL OR id <> $1::bigint)`,
    [null],
  );
  const owner = await db.query(`SELECT id FROM admin_users WHERE role='owner' LIMIT 1`);
  const excluded = await db.query(
    `SELECT count(*)::int AS count FROM admin_users
      WHERE role='owner' AND is_active=true
        AND ($1::bigint IS NULL OR id <> $1::bigint)`,
    [owner.rows[0].id],
  );
  if (r.rows[0].count !== 1 || excluded.rows[0].count !== 0)
    throw new Error(`counts were ${r.rows[0].count} and ${excluded.rows[0].count}, expected 1 and 0`);
  return "1 owner overall, 0 once excluded — the last-owner guard will fire";
});

/* ------------------------------ soft delete ------------------------------ */

await step("deleting marks the row instead of removing it", async () => {
  const before = (await db.query(`SELECT count(*)::int n FROM participants`)).rows[0].n;
  const victim = participantIds["9800000004"];
  await db.query(
    `UPDATE participants SET is_deleted = true, deleted_at = now() WHERE id = $1`,
    [victim],
  );
  const after = (await db.query(`SELECT count(*)::int n FROM participants`)).rows[0].n;
  if (before !== after) throw new Error(`row count changed ${before} -> ${after}`);
  const row = (
    await db.query(`SELECT is_deleted, deleted_at FROM participants WHERE id = $1`, [victim])
  ).rows[0];
  if (!row.is_deleted || !row.deleted_at) throw new Error("the flag or timestamp was not set");
  return "row still present, flagged with a timestamp";
});

await step("a deleted student drops off the leaderboard", async () => {
  const board = await db.query(
    `WITH best AS (
       SELECT DISTINCT ON (a.participant_id) a.participant_id, a.score, a.answer_ms,
              a.submitted_at, p.name
         FROM attempts a JOIN participants p ON p.id = a.participant_id
        WHERE a.organization_id = $1 AND a.status='completed'
          AND a.is_deleted = false AND p.is_deleted = false
        ORDER BY a.participant_id, a.score DESC, a.answer_ms ASC, a.submitted_at ASC)
     SELECT name FROM best ORDER BY score DESC, answer_ms ASC, submitted_at ASC`,
    [organizationId],
  );
  const names = board.rows.map((r) => r.name);
  if (names.includes("Divya S")) throw new Error("the deleted student is still ranked");
  if (names.length !== 3) throw new Error(`expected 3 ranked, got ${names.length}`);
  return names.join(" > ");
});

await step("registering again revives the entry instead of duplicating it", async () => {
  const victim = participantIds["9800000004"];
  const r = await db.query(
    `INSERT INTO participants (organization_id, name, phone, email)
     VALUES ($1,'Divya S','9800000004','divya-new@x.com')
     ON CONFLICT (organization_id, phone) DO UPDATE
        SET name = EXCLUDED.name, email = EXCLUDED.email,
            is_deleted = false, deleted_at = NULL, deleted_by = NULL
     RETURNING id`,
    [organizationId],
  );
  if (Number(r.rows[0].id) !== Number(victim))
    throw new Error("a second row was created instead of reusing the first");

  const rows = await db.query(
    `SELECT count(*)::int n, bool_or(is_deleted) AS any_deleted
       FROM participants WHERE organization_id = $1 AND phone = '9800000004'`,
    [organizationId],
  );
  if (rows.rows[0].n !== 1) throw new Error(`expected 1 row, found ${rows.rows[0].n}`);
  if (rows.rows[0].any_deleted) throw new Error("the row is still flagged as deleted");
  return "one row, revived, email updated";
});

await step("the revived student can play, because their old attempts stay deleted", async () => {
  const victim = participantIds["9800000004"];
  await db.query(`UPDATE attempts SET is_deleted = true WHERE participant_id = $1`, [victim]);
  const live = (
    await db.query(
      `SELECT count(*)::int n FROM attempts
        WHERE participant_id = $1 AND status = 'completed' AND is_deleted = false`,
      [victim],
    )
  ).rows[0].n;
  if (live !== 0) throw new Error(`the retake check would still block them: ${live} live attempts`);
  const kept = (
    await db.query(`SELECT count(*)::int n FROM attempts WHERE participant_id = $1`, [victim])
  ).rows[0].n;
  if (kept === 0) throw new Error("the old attempts were removed rather than kept");
  await db.query(`UPDATE attempts SET is_deleted = false WHERE participant_id = $1`, [victim]);
  return `0 counted, ${kept} old attempts still on file`;
});

await step("two students cannot share an email address", async () => {
  try {
    await db.query(
      `INSERT INTO participants (organization_id, name, phone, email)
       VALUES ($1,'Copycat','9700000001','asha@x.com')`,
      [organizationId],
    );
    throw new Error("expected the email index to reject a duplicate address");
  } catch (e) {
    if (e.message.includes("expected the email index")) throw e;
    if (!e.message.includes("participants_organization_email_key"))
      throw new Error(`wrong constraint fired: ${e.message}`);
    return "rejected, and the error names participants_organization_email_key";
  }
});

await step("the email rule ignores case", async () => {
  try {
    await db.query(
      `INSERT INTO participants (organization_id, name, phone, email)
       VALUES ($1,'Shouty','9700000002','ASHA@X.COM')`,
      [organizationId],
    );
    throw new Error("expected ASHA@X.COM to clash with asha@x.com");
  } catch (e) {
    if (e.message.includes("expected ASHA")) throw e;
    if (!e.message.includes("participants_organization_email_key"))
      throw new Error(`wrong constraint fired: ${e.message}`);
    return "ASHA@X.COM and asha@x.com are one address";
  }
});

await step("any number of students may leave the email blank", async () => {
  for (const [name, phone] of [
    ["Blank One", "9700000011"],
    ["Blank Two", "9700000012"],
    ["Blank Three", "9700000013"],
  ]) {
    await db.query(
      `INSERT INTO participants (organization_id, name, phone, email)
       VALUES ($1,$2,$3,'')`,
      [organizationId, name, phone],
    );
  }
  const n = (
    await db.query(
      `SELECT count(*)::int n FROM participants WHERE organization_id = $1 AND email = ''`,
      [organizationId],
    )
  ).rows[0].n;
  if (n < 3) throw new Error(`blank emails were rejected: only ${n} rows`);
  await db.query(
    `DELETE FROM participants WHERE organization_id = $1 AND phone LIKE '97000000%'`,
    [organizationId],
  );
  return `${n} students with no address, all accepted`;
});

await step("the same email is fine at a different event", async () => {
  const other = await db.query(
    `INSERT INTO organizations (slug, name, question_set_id) VALUES ('other','Other College',$1)
     RETURNING id`,
    [setId],
  );
  const otherId = other.rows[0].id;
  await db.query(
    `INSERT INTO participants (organization_id, name, phone, email)
     VALUES ($1,'Asha Rao','9800000001','asha@x.com')`,
    [otherId],
  );
  const n = (
    await db.query(`SELECT count(*)::int n FROM participants WHERE lower(email) = 'asha@x.com'`)
  ).rows[0].n;
  if (n !== 2) throw new Error(`expected the address at two events, found ${n}`);
  await db.query(`DELETE FROM organizations WHERE id = $1`, [otherId]);
  return "one address, two events";
});

await step("deleting a student frees their email for somebody else", async () => {
  const victim = participantIds["9800000002"];
  const addr = (await db.query(`SELECT email FROM participants WHERE id = $1`, [victim])).rows[0]
    .email;
  await db.query(`UPDATE participants SET is_deleted = true, deleted_at = now() WHERE id = $1`, [
    victim,
  ]);
  const r = await db.query(
    `INSERT INTO participants (organization_id, name, phone, email)
     VALUES ($1,'New Owner','9700000021',$2) RETURNING id`,
    [organizationId, addr],
  );
  // ...and restoring the original would now clash, which the app checks before trying.
  const clash = (
    await db.query(
      `SELECT count(*)::int n FROM participants
        WHERE organization_id = $1 AND lower(email) = lower($2) AND is_deleted = false`,
      [organizationId, addr],
    )
  ).rows[0].n;
  if (clash !== 1) throw new Error(`expected exactly one live holder, found ${clash}`);
  await db.query(`DELETE FROM participants WHERE id = $1`, [r.rows[0].id]);
  await db.query(`UPDATE participants SET is_deleted = false, deleted_at = NULL WHERE id = $1`, [
    victim,
  ]);
  return "address released while the row sits deleted";
});

await step("two rows can never share a mobile number", async () => {
  try {
    await db.query(
      `INSERT INTO participants (organization_id, name, phone) VALUES ($1,'Clash','9800000001')`,
      [organizationId],
    );
    throw new Error("expected the unique index to reject a duplicate mobile number");
  } catch (e) {
    if (e.message.includes("expected the unique index")) throw e;
    if (!e.message.includes("participants_organization_phone_key"))
      throw new Error(`wrong constraint fired: ${e.message}`);
    return "rejected, and the error still names participants_organization_phone_key";
  }
});

await step("a deleted event frees its code for reuse", async () => {
  await db.query(`UPDATE organizations SET is_deleted = true, deleted_at = now() WHERE id = $1`, [
    organizationId,
  ]);
  const r = await db.query(
    `INSERT INTO organizations (slug, name, question_set_id) VALUES ('demo','Demo College 2024',$1)
     RETURNING id`,
    [setId],
  );
  const live = (
    await db.query(`SELECT count(*)::int n FROM organizations WHERE lower(slug) = 'demo'`)
  ).rows[0].n;
  if (live !== 2) throw new Error(`expected the old and new event to coexist, found ${live}`);
  await db.query(`DELETE FROM organizations WHERE id = $1`, [r.rows[0].id]);
  await db.query(`UPDATE organizations SET is_deleted = false, deleted_at = NULL WHERE id = $1`, [
    organizationId,
  ]);
  return "old event kept, code reusable";
});

await step("restoring revives only what was swept up with the parent", async () => {
  // One attempt is removed on its own, an hour before the event is deleted.
  const solo = attemptIds["9800000003"].id;
  await db.query(
    `UPDATE attempts SET is_deleted = true, deleted_at = now() - interval '1 hour' WHERE id = $1`,
    [solo],
  );
  await db.query(`UPDATE organizations SET is_deleted = true, deleted_at = now() WHERE id = $1`, [
    organizationId,
  ]);
  await db.query(
    `UPDATE attempts SET is_deleted = true, deleted_at = now()
      WHERE organization_id = $1 AND is_deleted = false`,
    [organizationId],
  );
  await db.query(
    `UPDATE participants SET is_deleted = true, deleted_at = now()
      WHERE organization_id = $1 AND is_deleted = false`,
    [organizationId],
  );

  const stamp = (
    await db.query(`SELECT deleted_at FROM organizations WHERE id = $1`, [organizationId])
  ).rows[0].deleted_at;

  await db.query(`UPDATE organizations SET is_deleted = false, deleted_at = NULL WHERE id = $1`, [
    organizationId,
  ]);
  await db.query(
    `UPDATE participants SET is_deleted = false, deleted_at = NULL
      WHERE organization_id = $1 AND is_deleted = true AND deleted_at >= $2`,
    [organizationId, stamp],
  );
  await db.query(
    `UPDATE attempts SET is_deleted = false, deleted_at = NULL
      WHERE organization_id = $1 AND is_deleted = true AND deleted_at >= $2`,
    [organizationId, stamp],
  );

  const stillGone = (await db.query(`SELECT is_deleted FROM attempts WHERE id = $1`, [solo]))
    .rows[0].is_deleted;
  if (!stillGone) throw new Error("an attempt deleted earlier came back with the restore");

  const revived = (
    await db.query(
      `SELECT count(*)::int n FROM attempts WHERE organization_id = $1 AND is_deleted = false`,
      [organizationId],
    )
  ).rows[0].n;
  if (revived < 2) throw new Error(`expected the swept attempts back, found ${revived}`);

  // Put everything back so the later cascade checks start from a clean state.
  await db.query(`UPDATE attempts SET is_deleted = false, deleted_at = NULL WHERE id = $1`, [solo]);
  await db.query(
    `UPDATE participants SET is_deleted = false, deleted_at = NULL WHERE organization_id = $1`,
    [organizationId],
  );
  return "swept rows revived, the earlier one left deleted";
});

await step("counts ignore deleted rows", async () => {
  await db.query(`UPDATE questions SET is_deleted = true WHERE set_id = $1 AND position = 0`, [
    setId,
  ]);
  const r = await db.query(
    `SELECT (SELECT count(*)::int FROM questions
               WHERE is_active AND is_deleted = false)                  AS live,
            (SELECT count(*)::int FROM questions)                       AS kept`,
  );
  const { live, kept } = r.rows[0];
  if (live >= kept) throw new Error(`filter had no effect: ${live} of ${kept}`);
  await db.query(`UPDATE questions SET is_deleted = false WHERE set_id = $1`, [setId]);
  return `${live} counted, ${kept} still in the table`;
});

/* ------------------------------- cascades -------------------------------- */

await step("clearing entries keeps the organization but removes attempts and answers", async () => {
  const before = await db.query(`SELECT count(*)::int n FROM answers`);
  if (before.rows[0].n === 0) throw new Error("no answers to clear — test setup is wrong");
  await db.query(`DELETE FROM participants WHERE organization_id = $1`, [organizationId]);
  const after = await db.query(
    `SELECT (SELECT count(*)::int FROM participants) AS p,
            (SELECT count(*)::int FROM attempts) AS a,
            (SELECT count(*)::int FROM answers) AS ans,
            (SELECT count(*)::int FROM organizations WHERE id = $1) AS s`,
    [organizationId],
  );
  const { p, a, ans, s } = after.rows[0];
  if (p || a || ans) throw new Error(`cascade left rows behind: ${JSON.stringify(after.rows[0])}`);
  if (s !== 1) throw new Error("the organization itself was deleted");
  return "participants, attempts and answers gone; organization intact";
});

await step("deleting an organization cascades everything", async () => {
  await db.query(
    `INSERT INTO participants (organization_id, name, phone) VALUES ($1,'Temp','9900000001')`,
    [organizationId],
  );
  await db.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
  const r = await db.query(
    `SELECT (SELECT count(*)::int FROM organizations) AS s, (SELECT count(*)::int FROM participants) AS p`,
  );
  if (r.rows[0].s !== 0 || r.rows[0].p !== 0) throw new Error(JSON.stringify(r.rows[0]));
  return "organization and its participants removed";
});

await step("audit log insert", async () => {
  const owner = await db.query(`SELECT id, email FROM admin_users LIMIT 1`);
  await db.query(
    `INSERT INTO audit_log (admin_id, admin_email, action, target, detail)
     VALUES ($1,$2,'organization.create','demo',$3::jsonb)`,
    [owner.rows[0].id, owner.rows[0].email, JSON.stringify({ name: "Demo College" })],
  );
  const r = await db.query(
    `SELECT admin_email, action, target, detail FROM audit_log ORDER BY created_at DESC LIMIT 1`,
  );
  if (r.rows[0].detail.name !== "Demo College") throw new Error("jsonb detail did not round-trip");
  return "jsonb detail round-trips";
});

/* -------------------------------- report --------------------------------- */

console.log(
  `\n${failures.length ? "FAILED" : "All good"}: ${pass} passed, ${failures.length} failed\n`,
);
if (failures.length) {
  for (const f of failures) console.log(`  ${f.label}\n    ${f.message}`);
  process.exit(1);
}
await db.close();
