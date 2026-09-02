/**
 * One-shot database setup for Neon.
 *
 *   npm run db:setup          create/upgrade tables, seed the question bank + owner login
 *   npm run db:reset -- --drop   DESTRUCTIVE: drop every table first, then recreate
 *
 * Safe to re-run: the schema is idempotent and seeding only fills gaps.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Load .env.local first (Next's convention), then .env as a fallback.
const dotenv = require("dotenv");
dotenv.config({ path: join(root, ".env.local") });
dotenv.config({ path: join(root, ".env") });

const { neon, neonConfig } = require("@neondatabase/serverless");
const bcrypt = require("bcryptjs");

const DROP = process.argv.includes("--drop");
const url = process.env.DATABASE_URL;

if (!url) {
  console.error(
    "\n  DATABASE_URL is not set.\n\n" +
      "  Create .env.local in the project root with your Neon pooled connection string:\n" +
      '    DATABASE_URL="postgresql://...-pooler...neon.tech/neondb?sslmode=require"\n' +
      '    SESSION_SECRET="<48 random bytes>"\n',
  );
  process.exit(1);
}

// Same override as src/lib/db.ts: local development points the driver at a
// Postgres-over-HTTP endpoint on this machine instead of Neon's. Without it the
// driver derives `https://<host>/sql` from the connection string, which pins it
// to port 443. Unset in production, as intended.
const endpoint = process.env.DATABASE_HTTP_ENDPOINT;
if (endpoint) neonConfig.fetchEndpoint = endpoint;

const sql = neon(url);

/**
 * Splits the schema file into single statements. It contains no semicolons
 * inside literals - including inside the dollar-quoted function body - so a
 * plain split is enough, and every statement is independently idempotent.
 */
function statements(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TABLES = [
  "audit_log",
  "app_settings",
  "media",
  "answers",
  "attempts",
  "participants",
  "organizations",
  "schools", // pre-rename name, so --drop also clears an older database
  "questions",
  "question_sets",
  "admin_users",
];

/** The original 15 embryology questions, so a fresh install is usable immediately. */
const SEED_QUESTIONS = [
  ["Approximately what proportion of adults worldwide experience infertility during their lifetime?",
    ["1 in 50", "1 in 20", "1 in 6", "1 in 2"], 2],
  ["Which factor has the strongest biological association with declining female fertility?",
    ["Height", "Blood group", "Increasing maternal age", "Eye colour"], 2],
  ["Which of the following represents the correct sequence?",
    ["Egg → Embryo → Fertilisation → Zygote",
     "Sperm + Oocyte → Fertilisation → Zygote → Cleavage → Blastocyst",
     "Sperm → Blastocyst → Zygote → Implantation",
     "Oocyte → Implantation → Fertilisation → Embryo"], 1],
  ["In ICSI, approximately how many sperm are injected directly into the oocyte?",
    ["100", "10", "1,000", "One selected sperm"], 3],
  ["Which developmental stage is typically reached around Day 5-6 after fertilisation?",
    ["Zygote", "2-cell embryo", "Morula", "Blastocyst"], 3],
  ["Why is an embryo stored in liquid nitrogen during vitrification?",
    ["To slowly freeze it", "To increase its metabolism",
     "To bring it into a glass-like state with minimal ice-crystal formation",
     "To increase cell division"], 2],
  ["Which combination is most strongly associated with male infertility?",
    ["High sperm concentration + high motility",
     "Low concentration + poor motility + abnormal morphology",
     "High testosterone + high motility", "Large semen volume alone"], 1],
  ["Which technology allows embryos to be continuously monitored without repeatedly removing them from the incubator?",
    ["Conventional microscope", "PCR", "Time-lapse imaging", "Karyotyping"], 2],
  ["What is the main purpose of PGT-A?",
    ["Determine blood group", "Measure sperm concentration",
     "Screen embryos for numerical chromosome abnormalities", "Increase ovarian reserve"], 2],
  ["Which statement about the future of embryology is MOST accurate?",
    ["Embryologists will be completely replaced by AI", "IVF will eliminate natural conception",
     "AI, automation, genetics and advanced imaging are likely to augment embryologists' work",
     "Embryology will become unnecessary"], 2],
  ["Which was the major milestone that made ICSI possible?",
    ["Discovery of the sperm", "Development of vitrification",
     "Direct injection of a single sperm into the oocyte", "Discovery of the blastocyst"], 2],
  ["Which of these is the correct approximate temperature of liquid nitrogen?",
    ["−20°C", "−80°C", "−120°C", "−196°C"], 3],
  ["Which cell contributes the maternal and paternal genomes to the embryo?",
    ["Sperm only", "Oocyte only", "Both sperm and oocyte", "Polar body only"], 2],
  ["Which statement about age and IVF is correct?",
    ["Age has no effect once IVF is used", "IVF completely reverses reproductive ageing",
     "Oocyte age remains an important determinant of reproductive potential",
     "Sperm age is the only important factor"], 2],
  ["Final question - you have an oocyte, one sperm and an embryologist. What is the embryologist's job?",
    ["Just put them together", "Just freeze them",
     "Control, monitor and optimise the laboratory environment and procedures that support fertilisation and embryo development",
     "Choose whether the baby will be a boy or girl"], 2],
];

/**
 * "School" was renamed to "organization" everywhere. A database created before
 * that rename is upgraded in place here, keeping every row, rather than being
 * left behind with tables the app no longer looks for.
 *
 * Does nothing on a fresh database, and nothing on one already renamed.
 */
async function migrateSchoolsToOrganizations() {
  const [{ exists: hasOld }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schools'
    ) AS exists`;
  if (!hasOld) return;

  console.log('\n  Found the older "schools" tables - renaming to "organizations"…');

  const steps = [
    `ALTER TABLE schools RENAME TO organizations`,
    `ALTER TABLE participants RENAME COLUMN school_id TO organization_id`,
    `ALTER TABLE attempts RENAME COLUMN school_id TO organization_id`,
    `ALTER INDEX IF EXISTS schools_slug_key RENAME TO organizations_slug_key`,
    `ALTER INDEX IF EXISTS schools_created_idx RENAME TO organizations_created_idx`,
    `ALTER INDEX IF EXISTS participants_school_phone_key RENAME TO participants_organization_phone_key`,
    `ALTER INDEX IF EXISTS participants_school_idx RENAME TO participants_organization_idx`,
    `ALTER TABLE organizations RENAME CONSTRAINT schools_question_count_positive
       TO organizations_question_count_positive`,
    `ALTER INDEX IF EXISTS schools_pkey RENAME TO organizations_pkey`,
  ];

  for (const stmt of steps) {
    try {
      await sql.query(stmt);
    } catch (e) {
      // Each step is independently skippable: an index or constraint may already
      // carry the new name, or never have existed on a hand-edited database.
      if (!/does not exist|already exists/i.test(e.message)) throw e;
    }
  }

  // The board index is partial, so it is simplest to drop and let the schema
  // below recreate it under the new column name.
  await sql.query(`DROP INDEX IF EXISTS attempts_board_idx`);

  const [{ count }] = await sql`SELECT count(*)::int AS count FROM organizations`;
  console.log(`    renamed, ${count} organization(s) kept with all their entries`);
}

async function main() {
  console.log(`\n  Connecting to Neon…`);
  const [{ version }] = await sql`SELECT version()`;
  console.log(`  ${version.split(",")[0]}`);

  if (DROP) {
    console.log("\n  --drop given: removing existing tables");
    for (const t of TABLES) {
      await sql.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
      console.log(`    dropped ${t}`);
    }
  }

  await migrateSchoolsToOrganizations();

  /* ------------------------------------------------------------------------
     "One email per event" is a new rule. Creating that unique index on a
     database that already holds two students sharing an address fails with a
     Postgres error nobody can act on, so look first and say exactly which rows
     are in the way.
  ------------------------------------------------------------------------- */
  const [{ exists: hasParticipants }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'participants'
    ) AS exists`;

  if (hasParticipants) {
    const [{ exists: hasFlag }] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'participants'
           AND column_name = 'is_deleted'
      ) AS exists`;

    // On a database that predates soft delete every row counts as live.
    const liveOnly = hasFlag ? "AND p.is_deleted = false" : "";
    const clashes = await sql.query(
      `SELECT o.name AS event, o.slug, lower(p.email) AS email, count(*)::int AS n,
              string_agg(p.name || ' (' || p.phone || ')', ', ' ORDER BY p.id) AS who
         FROM participants p
         JOIN organizations o ON o.id = p.organization_id
        WHERE p.email <> '' ${liveOnly}
        GROUP BY o.name, o.slug, lower(p.email)
       HAVING count(*) > 1
        ORDER BY n DESC`,
    );

    if (clashes.length) {
      console.error(
        `\n  Cannot apply the new "one email per event" rule: ` +
          `${clashes.length} email address${clashes.length === 1 ? "" : "es"} ` +
          `${clashes.length === 1 ? "is" : "are"} used more than once.\n`,
      );
      for (const c of clashes) {
        console.error(`    ${c.email}  -  ${c.event} (${c.slug}), ${c.n} students`);
        console.error(`      ${c.who}`);
      }
      console.error(
        "\n  Fix each one first, then run this again. In the admin panel:\n" +
          "    People → search the address → delete the entries that should not keep it.\n" +
          "  Deleting only hides a row, so nothing is lost either way.\n",
      );
      process.exit(1);
    }
  }

  console.log("\n  Applying schema…");
  const schema = readFileSync(join(root, "db", "schema.sql"), "utf8");
  let applied = 0;
  for (const stmt of statements(schema)) {
    await sql.query(stmt);
    applied++;
  }
  console.log(`    ${applied} statements applied`);

  /* ---------------------------- question bank ---------------------------- */
  const [{ count: setCount }] = await sql`SELECT count(*)::int AS count FROM question_sets`;
  let setId;
  if (setCount === 0) {
    const [set] = await sql`
      INSERT INTO question_sets (name, description)
      VALUES ('Embryology Quiz Challenge',
              'The 15-question set used for career guidance talks. Edit freely from the admin panel.')
      RETURNING id`;
    setId = set.id;
    for (let i = 0; i < SEED_QUESTIONS.length; i++) {
      const [text, options, correct] = SEED_QUESTIONS[i];
      await sql`
        INSERT INTO questions (set_id, position, text, options, correct_index, correct_indexes)
        VALUES (${setId}, ${i}, ${text}, ${JSON.stringify(options)}::jsonb, ${correct},
                ${JSON.stringify([correct])}::jsonb)`;
    }
    console.log(`\n  Seeded question set #${setId} with ${SEED_QUESTIONS.length} questions`);
  } else {
    const [set] = await sql`SELECT id FROM question_sets ORDER BY id ASC LIMIT 1`;
    setId = set.id;
    console.log(`\n  Question sets already exist (${setCount}) - left untouched`);
  }

  /* ------------------------------ owner login ---------------------------- */
  const [{ count: adminCount }] = await sql`SELECT count(*)::int AS count FROM admin_users`;
  if (adminCount === 0) {
    const email = process.env.SEED_ADMIN_EMAIL || "admin@garbhagudi.com";
    const password = process.env.SEED_ADMIN_PASSWORD;
    const name = process.env.SEED_ADMIN_NAME || "GarbhaGudi Admin";
    if (!password || password.length < 10) {
      console.error(
        "\n  No admin account exists and SEED_ADMIN_PASSWORD is missing or under 10 characters.\n" +
          "  Add SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD to .env.local and run this again.\n",
      );
      process.exit(1);
    }
    const hash = await bcrypt.hash(password, 12);
    await sql`
      INSERT INTO admin_users (email, password_hash, name, role)
      VALUES (${email}, ${hash}, ${name}, 'owner')`;
    console.log(`\n  Created owner account: ${email}`);
    console.log(`  Sign in at /admin/login, then change the password under Team.`);
  } else {
    console.log(`\n  ${adminCount} admin account(s) already exist - left untouched`);
  }

  /* ------------------------------ demo event ----------------------------- */
  const [{ count: organizationCount }] = await sql`SELECT count(*)::int AS count FROM organizations`;
  if (organizationCount === 0) {
    await sql`
      INSERT INTO organizations (slug, name, city, question_set_id, notes)
      VALUES ('demo', 'Demo College', 'Bengaluru', ${setId},
              'Sample event created by db:setup. Delete it once you have made a real one.')`;
    console.log(`\n  Created a sample event you can try straight away: code "demo"`);
  }

  console.log("\n  Database ready.\n");
}

main().catch((e) => {
  console.error("\n  Setup failed:", e.message, "\n");
  process.exit(1);
});
