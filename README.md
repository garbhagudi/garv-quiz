# GarbhaGudi Quiz Platform

A multi-event live quiz for career guidance talks, with the admin panel to run it.

Students open one link, enter the code for their college, answer on their own
phones, and see a leaderboard. Staff create events, edit questions, watch scores
arrive, see who won, and export the event as an Excel workbook.

Next.js on Vercel, Neon Postgres for storage. Nothing to install at a venue.

```
Student   /                    enter an event code
          /s/<code>            register and play
          /s/<code>/dashboard  own score, rank, and answer review
Staff     /admin               the full panel
          /s/<code>/admin      one event's results, on the event's own URL
```

---

## How it works

**One organization is one event.** An organization row carries a `slug` — the code students
type — plus its own question set and settings: how many questions to ask,
whether to shuffle, whether one attempt per mobile, whether to show scores and
the leaderboard.

**Marking happens on the server, always.** When a student starts, the app picks
their questions, shuffles the options, and stores that exact arrangement —
answer key included — on the attempt row. The phone gets the questions with the
key stripped out, and on submit reports only which option index it tapped. So:

- page source reveals nothing useful;
- a forged submission claiming a perfect score is marked like any other;
- a re-submit after a dropped connection returns the first result rather than
  scoring twice;
- editing a question later never changes how already-submitted quizzes were
  marked, because each attempt holds its own snapshot.

**A question can have more than one correct option.** Tick as many as apply in
the editor. The student then sees "Select all that apply", toggles options, and
confirms — instead of the single tap that locks an ordinary question. Marking is
all-or-nothing: the chosen set has to match the answer key exactly, so half of a
two-answer question scores nothing, and neither does ticking every option to
cover the possibilities. The phone is told only *that* a question takes several
answers, never how many, because the count would narrow the guess.

**Registering twice is allowed until they finish.** Pressing Continue registers
the student and opens an attempt, so anyone who goes back and fills the form in
again — or reads the rules and wanders off — leaves an attempt behind. That is
fine: they are recognised by mobile number *or* email address, get a fresh
attempt, and keep one participant row. Only a *completed* run turns somebody
away, with "You have already played this quiz", whichever of the two they came
back by. `allow_retake` on the event lifts even that.

**A rules screen sits between the form and the first question.** Every line on it
is built from the attempt that student was actually served rather than from a
fixed script: the counts are real, the "select all that apply" rule appears only
when their paper contains one, and the marks line claims questions are worth
different amounts only when they are. A rule that does not apply is worse than
none, because it sends a student looking for something that is not there. It
gives away nothing new — `multi` and `pts` already travel with the questions.

Two consequences worth knowing. The button on the form says **Continue**, not
"Start the quiz", because it does not start it. And the wall clock starts when
the rules screen is left, not at registration, so reading them carefully does not
cost a student their total time — per-question timing, which is what breaks ties,
is unaffected either way.

**Every question shows what it is worth**, beside the timer, and the student's
answer review shows the same per question as `2/2` or `0/1`. That last number
comes from the attempt's own snapshot, not from `answers.points`, which records
what was *earned* and is 0 on a wrong answer — so it cannot say what the question
was worth.

**A quiz can be timed.** A question set carries an optional whole-quiz limit in
minutes (blank means untimed, which is what every set is until somebody fills it
in). It lives on the *set* rather than on the event, so the duration travels with
the questions everywhere they are used and nobody has to remember it when they
create an event.

A student sees the limit on the rules screen, and a countdown replaces the
per-question stopwatch in the corner while they play. It turns red and pulses in
the last minute. At zero the quiz submits itself with whatever has been answered,
so running out costs a student the questions they did not reach and nothing more.
The countdown is read from a deadline instant rather than decremented, so a phone
that sleeps mid-quiz catches up instead of gaining the time it was asleep.

Two things it deliberately is not. It is **not** a per-question limit — one clock
runs for the whole paper, so a hard question can be paid for with a fast one. And
it is **not** an anti-cheat measure: the countdown runs in the browser, so
somebody willing to edit the page can outlast it. What the server does keep is
the true elapsed time of every attempt, from the row it created when the quiz
started, and that is shown in the results table and the export — so an attempt
that took far longer than the limit is visible to whoever is running the event.
Treat it as a pacing device for a live room, which is what it is for.

**A question can carry a list.** Question wording runs to as many lines as it
needs. A line that opens with `-`, `*` or `•` becomes a bullet; a line that
opens with `1.` or `2)` becomes a numbered item; everything else is ordinary
wording. The space after the marker is optional, because `-Estradiol is rising`
is how people actually type a bullet — but a marker with a digit or another dash
straight after it is left alone, so `-196°C is the temperature` and a rule of
dashes stay as wording. So this, typed straight into the editor:

```
Which of these are true of a blastocyst?
- It forms around Day 5–6
- It has an inner cell mass
```

reads as a stem with two bullets on the student's phone, in the question bank,
in the editor's live preview and on every answer sheet — all four draw it with the
same component, so it cannot look different in one of them.

This is *not* Markdown and it never becomes HTML. The parser in
`src/lib/questionText.ts` returns blocks of plain strings and
`src/components/QuestionText.tsx` renders them as text, so a question containing
`<`, `&` or a mid-sentence asterisk is safe and is left alone. A marker only
counts at the start of a line and only with text after it, so "Day 5-6",
"2 * 3" and "1.5 mm" stay as they were, and a stray dash never becomes an empty
bullet.
Where a list cannot be drawn — the audit log's label, a confirmation dialog, a
spreadsheet cell — `flattenQuestionText()` gives the one-line form with the
bullets kept as `•` markers.

**A question can carry a picture.** Choose a PNG, JPEG, WebP or GIF up to 2 MB in
the editor and it uploads immediately; the picture appears above the question on
the student's phone, and the answer options stay as text. You can also paste an
`https://` link to a picture hosted elsewhere.

Uploads are stored in the database (a `media` table) rather than on disk, because
the app runs on serverless functions with no writable filesystem and there is no
object store to configure. Each picture gets a random uuid and is read back from
`/api/media/<uuid>`:

- that route is public, because a student's phone has no admin session — the uuid
  is the only handle and it is never listed anywhere a student can reach;
- the type is sniffed from the file's own magic bytes, not from its name or the
  Content-Type the browser claimed, so a `.png` that is really an HTML document is
  refused, and so is an SVG, which can carry script;
- the bytes for a given uuid never change, so the response is `immutable` and
  cached for a year — one read per picture per phone on the day, not one per
  question screen.

**"Unfinished" counts people, not attempts.** The number on the event page is
students who registered and never completed a run, which is the same set the
*Did not finish* tab lists — click the tile to go straight to it. They cannot
disagree, because both come from one definition. The count of attempts still
open is a different number, useful mid-event and reported separately in the
export: one student who presses Continue five times and then finishes is five
open attempts and nobody unfinished.

**Ranking** is points, then fastest total answering time, then earliest
submission. Timing is per question — from render to tap — so a slow intro slide
costs nobody anything. Students see names and points only; times and contact
details never reach the browser.

**Two audiences, two session cookies.** Staff sign in with an email and password
(bcrypt, roles: `owner` / `admin` / `viewer`). Students "sign in" with the name
and mobile they registered with, which reaches only their own results. Both are
signed JWTs in httpOnly cookies.

**Nothing is ever deleted.** Every table that a person can remove rows from
carries `is_deleted`, `deleted_at` and `deleted_by`. "Delete" in the admin panel
sets the flag; every read path filters on it. So:

- the **Deleted** page lists everything anyone has removed, with who did it and
  when, and puts it back on request;
- deleting an event marks its students and their attempts in the same sweep, all
  stamped with one timestamp — restoring the event revives exactly that sweep and
  leaves anything deleted earlier alone;
- **students are never duplicated.** One row per mobile number per event, for
  ever. If the team deletes a student and that student registers again, the same
  row is revived — same record, updated details — rather than a second one being
  created. Their old attempts stay deleted, which is what lets them play; once
  they finish, the number is spoken for again and a further registration is
  refused;
- **one email address per event** as well, so two students cannot share an
  inbox. Compared case-insensitively, so `Asha@x.com` and `asha@x.com` are one
  person. Blank is exempt — the address is optional on some events and any
  number of students may leave it empty. The rule is per event, so the same
  student can attend two colleges. Unlike the mobile number, a deleted student
  *does* release their address, because the number is the identity their row is
  revived by and the address is not; restoring them is refused, naming who took
  it, if somebody has;
- **the same address arriving with a different number is the ambiguous case**,
  and the name decides it. It is either a student who came back and retyped
  their number wrongly — who must not be locked out of their own quiz — or two
  students sharing an inbox, which the rule above exists to stop. Nothing in the
  request separates them except the name, so `nameMatches()` in
  `src/lib/identity.ts` is the tie-breaker: the same name moves that row to the
  new number, a different name is refused. It is the same forgiving comparison
  that lets a student back into their own dashboard, so it is not a new trust
  assumption — but it is a heuristic, and somebody who knows both a name and an
  address could claim that row before its owner plays;
- an event code and a staff email *are* freed by deletion (those unique rules are
  partial, `WHERE is_deleted = false`), so a code can be reused straight away —
  and restoring is refused, with the clash named, if something has since taken it;
- a deleted event's link stops working and its students disappear from the people
  search, so the flag behaves like a deletion everywhere it should.

Exporting to Excel still works on a deleted event, so an event can be recovered
as a spreadsheet before anyone decides whether to restore it.

---

## Stack

| | |
|---|---|
| Framework | Next.js 15, App Router, React 19, TypeScript |
| Database | Neon Postgres via `@neondatabase/serverless` (HTTP driver) |
| Styling | Tailwind CSS 3, with the GarbhaGudi palette as theme tokens |
| Sessions | `jose` (HS256 JWT in an httpOnly cookie) |
| Passwords | `bcryptjs` |
| Validation | `zod`, shared between client and server |
| Export | `xlsx` |

The HTTP driver matters: each query is one HTTPS request, so there is no
connection pool to keep alive across serverless invocations.

---

## Layout

```
db/schema.sql                   every table, safe to re-run

docker-compose.yml              Postgres for local development

scripts/setup-db.mjs            create tables, seed questions + first admin
scripts/dev-local.mjs           run the app against the Docker database
scripts/verify-sql.mjs          SQL checks against real Postgres (PGlite)
scripts/verify-logic.mts        marking and validation checks
scripts/e2e.mjs                 end-to-end test of the built app
scripts/neon-http-emulator.mjs  Postgres-over-HTTP bridge (dev and tests only)

src/lib/db.ts                   Neon connection, opened on first use
src/lib/session.ts              signed cookies for staff and students
src/lib/quiz.ts                 serving questions, marking answers
src/lib/queries.ts              ranking, summaries, per-question analysis
src/lib/validate.ts             input rules, shared client and server
src/lib/api.ts                  one error contract for every route
src/lib/client.ts               fetch wrapper for that contract

src/app/page.tsx                enter an event code
src/app/s/[slug]/               the quiz, student dashboard, staff door
src/app/admin/                  overview, organizations, questions, people, team, log
src/app/api/                    the API
src/lib/identity.ts             decides whether two registrations are one student
src/lib/questionText.ts         turns question wording into blocks (lists, text)
src/components/QuestionText.tsx draws those blocks, everywhere a question appears
src/middleware.ts               redirects anonymous visitors away from /admin
```

### Data model

```
admin_users     staff logins and roles
question_sets   a reusable bank; one set can serve many organizations,
                and carries the optional whole-quiz time limit
questions       text, options (jsonb), the answer key, a picture, points, is_active
organizations   one event: slug, question set, and all its settings
participants    one per student per event; unique on phone, and on email
attempts        one run: the served snapshot, score, timings, status
answers         one row per question answered, with a text snapshot
media           uploaded question pictures (bytea), keyed by uuid
app_settings    free-form key/value
audit_log       who changed what
```

The answer key on `questions` is stored twice, on purpose. `correct_indexes` is
a jsonb array and is the real key — one entry for an ordinary question, several
for a "select all that apply" one. `correct_index` holds the first of them, so
the original CHECK still applies and any older read path keeps working. A row
whose `correct_indexes` is an empty array — one written by hand-rolled SQL, or
by a build that predates the column — is marked off `correct_index` instead, and
the next `npm run db:setup` fills the array in.

The key is validated in the database, not only in the app: `correct_indexes` has
to be whole numbers, in range, with none repeated. That needs a subquery, which a
CHECK cannot hold, so the test lives in an IMMUTABLE function
(`quiz_answer_key_ok`) that the CHECK calls.

`organizations`, `participants`, `attempts`, `questions`, `question_sets` and
`admin_users` all carry `is_deleted` / `deleted_at` / `deleted_by`. The foreign
keys still cascade, but nothing in the application issues a `DELETE` — see
**Nothing is ever deleted** above. Removing a *question* also leaves past answers
readable: they keep their own text snapshot, so old reports still make sense.

---

## Running it locally

Two ways.

**Against Postgres in Docker.** Starts the database, creates the tables, seeds
the questions and an admin account, then opens the dev server. No Neon account
needed, and nothing to put in `.env.local`.

```bash
npm install
docker compose up -d
npm run dev:local        # prints the student link and the admin login
```

Data lives in a Docker volume. `docker compose down -v` wipes it and the next
`npm run dev:local` rebuilds it from scratch.

This project runs its Postgres on **5433** and its dev server on **3001**, so
it can run beside the GGIRHR quiz (5432 and 3000) without either being stopped.
If 5433 is taken too, set `LOCAL_PG_PORT=5434` for both
commands, or point at an existing container with
`LOCAL_PG_URL="postgres://user:pass@127.0.0.1:5433/dbname"`.

**Against a real Neon database.** Put `DATABASE_URL` and `SESSION_SECRET` in
`.env.local` (see `.env.example`), then:

```bash
npm run db:setup         # once, to create tables and your first admin
npm run dev
```

Use a Neon **branch** for development rather than your production database —
branches are copy-on-write, so they are instant and free.

### Why a bridge in front of the local database

`@neondatabase/serverless` speaks SQL over HTTPS, not the port-5432 wire
protocol — which is what makes it work on Vercel, where there is no connection to
keep alive. A Postgres on your own machine speaks that wire protocol, so
`scripts/neon-http-emulator.mjs` sits between them and translates, and
`DATABASE_HTTP_ENDPOINT` points the driver at it.

The alternative would be a second database driver behind an `if` in
`src/lib/db.ts`. This way `src/` is byte-for-byte the same code locally and in
production, so there is no class of bug that only appears in one of them.

---

## Scripts

| | |
|---|---|
| `npm run dev` | dev server against `DATABASE_URL` |
| `npm run dev:local` | dev server against a local Postgres, seeded |
| `npm run build` | production build |
| `npm run start` | serve a production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:setup` | create tables, seed questions and the first admin |
| `npm run db:reset` | **destructive** — drop every table, then recreate |
| `npm run verify` | schema, SQL, upgrade, logic and render checks; no network, no database |
| `npm run e2e` | build and drive the real app end to end |

### Tests

```bash
npm run verify   # 160 checks
npm run e2e      # 139 checks
```

- **`verify:sql`** runs the real schema and every non-trivial query against
  Postgres compiled to WebAssembly — constraints, ranking, cascades, the jsonb
  handling, the reorder and renumber statements.
- **`db:setup` checks before it migrates.** If a database already holds two
  students sharing an address, the new index cannot be created — so setup stops
  first and prints exactly which rows clash, rather than failing halfway with a
  Postgres error.
- **`verify:upgrade`** builds the schema as it was before the soft-delete change,
  fills it with an event and answers, applies the current `schema.sql` on top and
  checks nothing was lost — the rehearsal for running `db:setup` against live data.
  It also proves the later additions land safely: every existing single answer is
  rewritten as a one-entry key, no question is given a picture it did not have,
  and a question written the old way is still accepted afterwards.
- **`verify:logic`** covers marking and validation: partial submissions, forged
  payloads, duplicate answers, clamped timings, tie-breaks, phone and slug
  normalisation, how question wording is split into lists, and the multi-answer
  rules — an exact set scores, a partial set
  and a tick-everything set both score zero, an attempt snapshot taken before
  multiple answers existed still marks off its single key, and neither form of the
  key ever appears in what the phone is sent.
- **`verify:render`** renders the component that draws question wording and reads
  the markup back. It is the only check on what a browser is actually handed, and
  it exists mainly for escaping: a question is written by staff and shown to every
  student in the room, so it asserts that `<script>` or an `onerror` handler in
  the wording arrives as text and that the only tags in the output are the ones
  the component itself chose.
- **`e2e`** starts the actual production server against a local stand-in for
  Neon's HTTP endpoint and plays the whole product over HTTP — registering,
  answering, the leaderboard, the dashboard, admin sign-in, question editing, the
  Excel export, and every permission and anti-cheat rule. That includes uploading
  a real PNG and reading it back byte for byte with no session, refusing an HTML
  file dressed as a `.png`, and playing a multi-answer event three ways: exactly
  right, half right, and every box ticked.

None of them need anything installed — no Docker, no network, no database. `e2e`
builds into `.next-e2e/` and runs its own database on port 5453, so it is safe to
run while a dev server is up.

---

## Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string (`-pooler` in the host) |
| `SESSION_SECRET` | yes | 32+ random characters. Changing it signs everybody out |
| `SEED_ADMIN_EMAIL` | setup only | Read by `db:setup` when no admin exists |
| `SEED_ADMIN_PASSWORD` | setup only | 10+ characters. Remove it once you have signed in |
| `SEED_ADMIN_NAME` | setup only | |
| `DATABASE_HTTP_ENDPOINT` | no | Local development only. Points the driver at a Postgres-over-HTTP endpoint you run yourself. Must stay unset in production |

Both required variables are read on first use rather than at import time, so a
missing one fails the request that needs it with a clear message instead of
breaking the build.

---

## Notes for whoever works on this next

- **Bigints arrive as strings.** Postgres `bigint` comes back from the driver as
  a string, not a number. Compare ids with `Number(...)` on both sides, or cast
  to `::int` in the query when the value is a count.
- **`PATCH /api/admin/organizations/:id` is a true partial update.** Anything the
  caller leaves out keeps its stored value. Send only what changed.
- **Every route is wrapped in `route()`** from `src/lib/api.ts`, which turns Zod
  errors into 422s, unique-constraint violations into readable 409s, and anything
  unexpected into a 500 without leaking a stack trace.
- **`viewer` is enforced server-side.** `requireWriter()` and `requireOwner()`
  guard the mutating routes; hiding buttons in the UI is a convenience, not the
  boundary.
- **The last active owner is protected** from demotion, disabling and deletion,
  so the team cannot lock itself out.
- **Answer keys must never be added to a response.** `stripAnswers()` exists for
  this; the e2e suite asserts that neither `ci` nor `cis` — nor anything else
  answer-shaped — appears in the payload sent to a phone.
- **`PATCH /api/admin/questions/:id` replaces the whole row**, unlike the
  organization route above. Send every field back, or a "Hide this question"
  click will quietly wipe its answer key or its picture. `answerKeyOfRow()` in
  `QuestionEditor.tsx` is there so callers can rebuild the key from a listed row.
- **Who a registration belongs to is decided in one place**, at the top of
  `/api/quiz/start`: look up by number, look up by address, and only then decide.
  Anything that turns a student away belongs after that, next to the retake
  check — not scattered through the lookups, which is how re-registering used to
  report an address clash when the real answer was "you already played".
- **Read, refuse, then write — in that order.** A registration that is going to
  be refused must leave the database exactly as it found it. Moving the row and
  refusing afterwards made a finished student's number drift onto whatever they
  typed next: their row followed the new number, that number became spoken for,
  and the student it really belonged to could never register at all.
- **Read the answer key through a helper, never off the field.** `answerKey()` in
  `src/lib/quiz.ts` for an attempt snapshot, `answerKeyOf()` in
  `src/lib/validate.ts` for an incoming request. Both fall back to the
  single-answer form, which is what keeps attempts started before the change —
  and rows seeded by hand-written SQL — marking correctly.
- **Question wording is text, and must stay text.** `QuestionText` takes a string
  and returns elements; there is no `dangerouslySetInnerHTML` anywhere near it and
  there must never be. If you extend the notation, extend the parser in
  `src/lib/questionText.ts` and add a case to `verify:logic` — do not reach for a
  Markdown library, which would hand an admin an HTML injection into every
  student's phone.
- **A question picture is served from our own origin**, so what a file claims to
  be is not good enough: `/api/admin/uploads` sniffs the magic bytes and stores
  the type it found, and `/api/media/:id` sends that stored type back with
  `nosniff`. If you ever add a format, add its signature too — do not widen the
  accepted list on the strength of a Content-Type header.

---

## Data kept

Each student's name, mobile number, email, optionally their class, their answers
and their timings. Nothing else. A one-way hash of the IP address is stored so
staff can spot many entries from one device; the address itself is not kept.

Pictures uploaded to questions are staff-supplied teaching material, not
personal data, and are not touched by any of the delete paths: removing a
question leaves its picture in the `media` table, so putting the question back
restores it whole. To reclaim the space, delete the `media` rows yourself.

*Clear all entries* on an event hides its students and answers while keeping the
event and its code. Nothing is erased: the rows stay in the database, flagged,
and the **Deleted** page can put them back. To purge for real — a data-retention
request, say — you have to delete the rows in the database yourself.
