/**
 * Proves every schema change since the first release is a safe upgrade for a
 * database that already has data: builds the schema as it was *before* soft
 * delete, fills it with an event, students and answers, then applies the
 * current schema.sql on top and checks nothing was lost or altered.
 *
 * That covers soft delete, the one-email-per-event rule, and - added later -
 * multiple correct answers per question and question pictures.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const full = readFileSync("db/schema.sql", "utf8");

const statements = (text) =>
  text
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

// Everything before the soft-delete section is the schema as it used to be.
const marker = full.indexOf("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_deleted");
if (marker < 0) throw new Error("could not find the soft-delete section");
const before = statements(full.slice(0, marker));
const after = statements(full);

const db = new PGlite();
let failures = 0;
const check = (label, cond, note = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${note ? ` - ${note}` : ""}`);
  if (!cond) failures++;
};

console.log("\nUpgrading a database that already has data\n");

for (const s of before) await db.exec(s);
console.log(`  applied the previous schema (${before.length} statements)`);

// ---- populate it the way a real event would ------------------------------
const set = await db.query(
  `INSERT INTO question_sets (name) VALUES ('Embryology') RETURNING id`,
);
const setId = set.rows[0].id;
for (let i = 0; i < 3; i++) {
  await db.query(
    `INSERT INTO questions (set_id, position, text, options, correct_index)
     VALUES ($1,$2,$3,$4::jsonb,0)`,
    [setId, i, `Q${i + 1}`, JSON.stringify(["a", "b"])],
  );
}
const org = await db.query(
  `INSERT INTO organizations (slug, name, question_set_id) VALUES ('demo','Demo College',$1)
   RETURNING id`,
  [setId],
);
const orgId = org.rows[0].id;
const adm = await db.query(
  `INSERT INTO admin_users (email, password_hash, name, role)
   VALUES ('owner@x.com','hash','Owner','owner') RETURNING id`,
);
const person = await db.query(
  `INSERT INTO participants (organization_id, name, phone, email)
   VALUES ($1,'Asha Rao','9800000001','asha@x.com') RETURNING id`,
  [orgId],
);
const att = await db.query(
  `INSERT INTO attempts (participant_id, organization_id, question_set_id, served,
                         status, score, max_score, correct_count, question_count,
                         answer_ms, elapsed_ms, submitted_at)
   VALUES ($1,$2,$3,'[]'::jsonb,'completed',3,3,3,3,1200,2000,now()) RETURNING id, public_id`,
  [person.rows[0].id, orgId, setId],
);
for (let i = 0; i < 3; i++) {
  await db.query(
    `INSERT INTO answers (attempt_id, position, question_text, chosen_text, correct_text,
                          is_correct, points, ms)
     VALUES ($1,$2,$3,'a','a',true,1,400)`,
    [att.rows[0].id, i, `Q${i + 1}`],
  );
}

const snapshot = async () =>
  (
    await db.query(`
    SELECT (SELECT count(*)::int FROM organizations)  AS orgs,
           (SELECT count(*)::int FROM participants)   AS people,
           (SELECT count(*)::int FROM attempts)       AS attempts,
           (SELECT count(*)::int FROM answers)        AS answers,
           (SELECT count(*)::int FROM questions)      AS questions,
           (SELECT count(*)::int FROM admin_users)    AS admins,
           (SELECT score FROM attempts LIMIT 1)       AS score,
           (SELECT public_id::text FROM attempts LIMIT 1) AS public_id,
           (SELECT phone FROM participants LIMIT 1)   AS phone`)
  ).rows[0];

const pre = await snapshot();
console.log(`  seeded: ${JSON.stringify(pre)}`);

// ---- apply the current schema on top -------------------------------------
console.log("\n  applying the current schema.sql over it…");
for (const s of after) await db.exec(s);

const post = await snapshot();

check("no rows lost", JSON.stringify(pre) === JSON.stringify(post), JSON.stringify(post));

const cols = await db.query(`
  SELECT table_name, count(*)::int n FROM information_schema.columns
   WHERE column_name IN ('is_deleted','deleted_at','deleted_by') AND table_schema='public'
   GROUP BY 1 ORDER BY 1`);
check(
  "soft-delete columns added to all six tables",
  cols.rows.length === 6 && cols.rows.every((r) => r.n === 3),
  cols.rows.map((r) => r.table_name).join(", "),
);

const live = await db.query(`
  SELECT (SELECT count(*)::int FROM organizations WHERE is_deleted = false) AS o,
         (SELECT count(*)::int FROM participants  WHERE is_deleted = false) AS p,
         (SELECT count(*)::int FROM attempts      WHERE is_deleted = false) AS a,
         (SELECT count(*)::int FROM questions     WHERE is_deleted = false) AS q`);
check(
  "existing rows default to live, not deleted",
  live.rows[0].o === 1 && live.rows[0].p === 1 && live.rows[0].a === 1 && live.rows[0].q === 3,
  JSON.stringify(live.rows[0]),
);

const idx = await db.query(`
  SELECT indexname, indexdef FROM pg_indexes
   WHERE schemaname='public'
     AND indexname IN ('organizations_slug_key','participants_organization_phone_key',
                       'admin_users_email_key')`);
const partial = (name) =>
  idx.rows.find((r) => r.indexname === name)?.indexdef.includes("is_deleted = false");
check(
  "a deleted event frees its code, and a deleted account frees its email",
  partial("organizations_slug_key") === true && partial("admin_users_email_key") === true,
);
check(
  "one entry per mobile stays absolute, so a student can never be duplicated",
  partial("participants_organization_phone_key") === false,
);

// the upsert the app runs must still work against the rebuilt index
await db.query(
  `INSERT INTO participants (organization_id, name, phone, email)
   VALUES ($1,'Asha Rao','9800000001','asha@x.com')
   ON CONFLICT (organization_id, phone) DO UPDATE
      SET name = EXCLUDED.name`,
  [orgId],
);
const stillOne = (
  await db.query(`SELECT count(*)::int n FROM participants WHERE phone = '9800000001'`)
).rows[0].n;
check("the app's upsert still matches the rebuilt index", stillOne === 1);

// The new "one email per event" rule has to hold on the upgraded database too.
const emailIdx = await db.query(`
  SELECT indexdef FROM pg_indexes
   WHERE schemaname='public' AND indexname='participants_organization_email_key'`);
check(
  "one email per event, ignoring blanks and deleted rows",
  emailIdx.rows.length === 1 &&
    emailIdx.rows[0].indexdef.includes("lower(email)") &&
    emailIdx.rows[0].indexdef.includes("email <> ''") &&
    emailIdx.rows[0].indexdef.includes("is_deleted = false"),
  emailIdx.rows[0]?.indexdef ?? "index missing",
);

let emailRejected = false;
try {
  await db.query(
    `INSERT INTO participants (organization_id, name, phone, email)
     VALUES ($1,'Copycat','9800000099','asha@x.com')`,
    [orgId],
  );
} catch (e) {
  emailRejected = e.message.includes("participants_organization_email_key");
}
check("a second student cannot take an address already in use", emailRejected);

// A database that already holds a duplicate address cannot take the index, and
// `npm run db:setup` says which rows are in the way rather than failing blindly.
const probe = new PGlite();
for (const s2 of before) await probe.exec(s2);
await probe.query(
  `INSERT INTO question_sets (name) VALUES ('S')`,
);
await probe.query(
  `INSERT INTO organizations (slug, name) VALUES ('dupe','Dupe College')`,
);
const dupeOrg = (await probe.query(`SELECT id FROM organizations LIMIT 1`)).rows[0].id;
for (const [name, phone] of [
  ["First", "9811111111"],
  ["Second", "9822222222"],
]) {
  await probe.query(
    `INSERT INTO participants (organization_id, name, phone, email)
     VALUES ($1,$2,$3,'shared@x.com')`,
    [dupeOrg, name, phone],
  );
}
let indexFailed = false;
try {
  for (const s2 of after) await probe.exec(s2);
} catch (e) {
  indexFailed = /duplicate key|uniqueness|unique/i.test(e.message);
}
check(
  "a database with a shared address is caught rather than half-migrated",
  indexFailed,
  "db:setup checks for this first and names the rows",
);
const stillThere = (
  await probe.query(`SELECT count(*)::int n FROM participants WHERE email = 'shared@x.com'`)
).rows[0].n;
check("and nothing was lost when it stopped", stillThere === 2);
await probe.close();

// ---- multiple correct answers and question pictures ----------------------
const newCols = await db.query(`
  SELECT column_name, data_type, column_default FROM information_schema.columns
   WHERE table_schema='public' AND table_name='questions'
     AND column_name IN ('correct_indexes','image_url','image_alt')
   ORDER BY column_name`);
check(
  "the multi-answer and picture columns were added to questions",
  newCols.rows.length === 3,
  newCols.rows.map((r) => `${r.column_name} ${r.data_type}`).join(", "),
);

const keys = await db.query(`SELECT correct_index, correct_indexes FROM questions ORDER BY id`);
check(
  "every existing single answer was rewritten as a one-entry key",
  keys.rows.length === 3 &&
    keys.rows.every((r) => JSON.stringify(r.correct_indexes) === `[${r.correct_index}]`),
  JSON.stringify(keys.rows),
);

check(
  "no existing question was given a picture it did not have",
  (await db.query(`SELECT count(*)::int n FROM questions WHERE image_url <> ''`)).rows[0].n === 0,
);

// A question written the old way - correct_index only - still goes in, and the
// next schema run picks its key up. That is what keeps the seeds and the
// verify scripts working after the upgrade.
await db.query(
  `INSERT INTO questions (set_id, position, text, options, correct_index)
   VALUES ($1, 9, 'Written the old way', $2::jsonb, 1)`,
  [setId, JSON.stringify(["a", "b", "c"])],
);
check(
  "a question written without the new column is still accepted",
  (await db.query(`SELECT count(*)::int n FROM questions WHERE position = 9`)).rows[0].n === 1,
);

// And a multi-answer question written the new way goes in beside it.
await db.query(
  `INSERT INTO questions (set_id, position, text, options, correct_index, correct_indexes,
                          image_url, image_alt)
   VALUES ($1, 10, 'Pick both gametes', $2::jsonb, 0, $3::jsonb,
           '/api/media/2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'Two gametes')`,
  [setId, JSON.stringify(["Sperm", "Oocyte", "Zygote"]), JSON.stringify([0, 1])],
);
const multi = await db.query(
  `SELECT correct_indexes, image_alt FROM questions WHERE position = 10`,
);
check(
  "a two-answer question with a picture can be added to the upgraded database",
  JSON.stringify(multi.rows[0].correct_indexes) === "[0,1]" &&
    multi.rows[0].image_alt === "Two gametes",
  JSON.stringify(multi.rows[0]),
);

let keyRejected = false;
try {
  await db.query(
    `INSERT INTO questions (set_id, text, options, correct_index, correct_indexes)
     VALUES ($1, 'bad', $2::jsonb, 0, $3::jsonb)`,
    [setId, JSON.stringify(["a", "b"]), JSON.stringify([0, 7])],
  );
} catch (e) {
  keyRejected = e.message.includes("questions_correct_indexes_valid");
}
check("the new answer-key CHECK is live on the upgraded database", keyRejected);

const mediaTable = await db.query(`
  SELECT count(*)::int n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='media'`);
check("the picture store was created", mediaTable.rows[0].n === 1);

// Clean up so the "re-running changes nothing" check below still compares like
// with like against the snapshot taken before these two inserts.
await db.query(`DELETE FROM questions WHERE position IN (9, 10)`);

// running it a second time must stay clean
for (const s of after) await db.exec(s);
const post2 = await snapshot();
check("re-running the upgrade changes nothing", JSON.stringify(post) === JSON.stringify(post2));

console.log(`\n  ${failures ? "FAILED" : "Safe to run on your live database"}\n`);
await db.close();
process.exit(failures ? 1 : 0);
