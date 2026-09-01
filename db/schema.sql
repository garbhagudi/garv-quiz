-- ===========================================================================
--  GarbhaGudi Quiz Platform — Neon Postgres schema
--  Safe to run more than once: every statement is IF NOT EXISTS / idempotent.
--  Run it with:  npm run db:setup
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Staff accounts. `owner` can manage other admins; `admin` can do everything
-- else; `viewer` is read-only (useful for a counsellor who only watches results).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          text        NOT NULL,
  password_hash  text        NOT NULL,
  name           text        NOT NULL,
  role           text        NOT NULL DEFAULT 'admin'
                             CHECK (role IN ('owner', 'admin', 'viewer')),
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
-- Case-insensitive uniqueness so Admin@x.com and admin@x.com are one account.
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_key
  ON admin_users (lower(email));

-- ---------------------------------------------------------------------------
-- A reusable bank of questions. One set can be pointed at many organizations, so
-- editing a question once updates every future event that uses that set.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_sets (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  is_archived  boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- `options` is a JSON array of strings; `correct_index` points into it (0-based).
-- The correct answer NEVER leaves the server — the API strips it before sending
-- questions to a phone, and scoring happens here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  set_id         bigint      NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  position       integer     NOT NULL DEFAULT 0,
  text           text        NOT NULL,
  options        jsonb       NOT NULL,
  correct_index  integer     NOT NULL DEFAULT 0,
  explanation    text        NOT NULL DEFAULT '',
  points         integer     NOT NULL DEFAULT 1 CHECK (points > 0),
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT questions_options_is_array CHECK (jsonb_typeof(options) = 'array'),
  CONSTRAINT questions_options_min_two  CHECK (jsonb_array_length(options) >= 2),
  CONSTRAINT questions_correct_in_range CHECK (
    correct_index >= 0 AND correct_index < jsonb_array_length(options)
  )
);
CREATE INDEX IF NOT EXISTS questions_set_pos_idx ON questions (set_id, position, id);

-- ---------------------------------------------------------------------------
-- A "organization" is one event: the college you are visiting on a given day.
-- `slug` is the code students type on the home page (e.g. "svcollege2026").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug              text        NOT NULL,
  name              text        NOT NULL,
  city              text        NOT NULL DEFAULT '',
  contact_name      text        NOT NULL DEFAULT '',
  contact_phone     text        NOT NULL DEFAULT '',
  event_date        date,
  notes             text        NOT NULL DEFAULT '',

  question_set_id   bigint      REFERENCES question_sets(id) ON DELETE SET NULL,

  -- Event controls, all editable from the admin panel.
  is_open           boolean     NOT NULL DEFAULT true,   -- accept new submissions?
  question_count    integer,                             -- NULL = ask every question in the set
  shuffle_questions boolean     NOT NULL DEFAULT false,
  shuffle_options   boolean     NOT NULL DEFAULT true,
  allow_retake      boolean     NOT NULL DEFAULT false,  -- one attempt per mobile unless true
  show_score        boolean     NOT NULL DEFAULT true,   -- show score on the finish screen
  -- Legacy. Students are shown no leaderboard and no dashboard at all now, so
  -- nothing reads or writes this. Kept so an existing database still matches
  -- this file; drop it by hand if you ever want it gone.
  show_leaderboard  boolean     NOT NULL DEFAULT true,
  require_email     boolean     NOT NULL DEFAULT true,
  collect_class     boolean     NOT NULL DEFAULT false,  -- ask for class / year / branch
  prize_note        text        NOT NULL DEFAULT 'Winners get exciting gifts from the GarbhaGudi team.',

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  CONSTRAINT organizations_question_count_positive CHECK (question_count IS NULL OR question_count > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_key ON organizations (lower(slug));
CREATE INDEX IF NOT EXISTS organizations_created_idx ON organizations (created_at DESC);

-- ---------------------------------------------------------------------------
-- One row per student per organization. Mobile number is the identity, which is also
-- what they type to get back into their own dashboard later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS participants (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id     bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  phone         text        NOT NULL,
  email         text        NOT NULL DEFAULT '',
  class_or_year text        NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS participants_organization_phone_key
  ON participants (organization_id, phone);
CREATE INDEX IF NOT EXISTS participants_organization_idx ON participants (organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- One row per run through the quiz. `served` records exactly which questions
-- were asked and in which option order, so the submission can be scored
-- against what the student actually saw — and so a tampered payload can't win.
--
-- `public_id` is the unguessable handle used in result URLs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attempts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  participant_id   bigint      NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  organization_id        bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question_set_id  bigint      REFERENCES question_sets(id) ON DELETE SET NULL,
  served           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status           text        NOT NULL DEFAULT 'in_progress'
                               CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  score            integer     NOT NULL DEFAULT 0,
  max_score        integer     NOT NULL DEFAULT 0,
  correct_count    integer     NOT NULL DEFAULT 0,
  question_count   integer     NOT NULL DEFAULT 0,
  answer_ms        integer     NOT NULL DEFAULT 0,   -- summed per-question thinking time
  elapsed_ms       integer     NOT NULL DEFAULT 0,   -- wall clock, start to submit
  started_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at     timestamptz,
  ip_hash          text        NOT NULL DEFAULT '',
  user_agent       text        NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_public_id_key ON attempts (public_id);
CREATE INDEX IF NOT EXISTS attempts_participant_idx ON attempts (participant_id, started_at DESC);
-- The leaderboard query: completed attempts for one organization, best first.
CREATE INDEX IF NOT EXISTS attempts_board_idx
  ON attempts (organization_id, score DESC, answer_ms ASC, submitted_at ASC)
  WHERE status = 'completed';

-- ---------------------------------------------------------------------------
-- Every individual answer, kept for the per-question analysis in the admin
-- panel. `question_id` goes NULL if the question is later deleted, but the
-- text snapshot stays so old reports still read correctly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answers (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id    bigint      NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id   bigint      REFERENCES questions(id) ON DELETE SET NULL,
  position      integer     NOT NULL DEFAULT 0,
  question_text text        NOT NULL DEFAULT '',
  chosen_text   text        NOT NULL DEFAULT '',
  correct_text  text        NOT NULL DEFAULT '',
  is_correct    boolean     NOT NULL DEFAULT false,
  points        integer     NOT NULL DEFAULT 0,
  ms            integer     NOT NULL DEFAULT 0,
  answered_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS answers_attempt_position_key ON answers (attempt_id, position);
CREATE INDEX IF NOT EXISTS answers_question_idx ON answers (question_id);

-- ---------------------------------------------------------------------------
-- Free-form global settings, so text like the site tagline can be changed
-- without a redeploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Who changed what, so a shared admin login is still traceable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id    bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  admin_email text        NOT NULL DEFAULT '',
  action      text        NOT NULL,
  target      text        NOT NULL DEFAULT '',
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

-- ===========================================================================
--  Soft delete
--
--  Nothing in this application is ever removed from the database. "Delete" in
--  the admin panel sets `is_deleted` instead, so a mistyped confirmation on the
--  night of an event cannot destroy a college's data. Every read path filters
--  on `is_deleted = false`; the admin panel can show deleted rows on request
--  and restore them.
--
--  These run as ALTER statements rather than being inlined in the CREATE TABLE
--  blocks above, so the same file upgrades a database that already has data.
-- ===========================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_by bigint REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE participants ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS deleted_by bigint REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS deleted_by bigint REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE questions ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS deleted_by bigint REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE question_sets ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE question_sets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE question_sets ADD COLUMN IF NOT EXISTS deleted_by bigint REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS deleted_by bigint REFERENCES admin_users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- The three "one of these per X" rules now apply only to live rows, so a code,
-- a mobile number or an email address becomes reusable once its row is deleted.
-- Without this, deleting an event would keep its code locked up forever.
--
-- Recreated on every run: the names stay the same, so the friendly error
-- messages in src/lib/api.ts still recognise a clash.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS organizations_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_key
  ON organizations (lower(slug)) WHERE is_deleted = false;

-- Participants are the exception: one row per mobile per event, always, deleted
-- or not. Registering with a number whose entry was deleted revives that row
-- instead of adding a second one (see /api/quiz/start), so a student never ends
-- up with two records and two email addresses on file.
DROP INDEX IF EXISTS participants_organization_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS participants_organization_phone_key
  ON participants (organization_id, phone);

-- One email address per event too, so two students cannot share one inbox.
-- Two conditions, both deliberate:
--   email <> ''          the address is optional on some events, and any number
--                        of students may leave it blank
--   is_deleted = false   a removed student does not keep an address reserved,
--                        unlike their mobile number, because the mobile is the
--                        identity their row is revived by and the email is not
-- Compared on lower(email), so Asha@x.com and asha@x.com are the same person.
CREATE UNIQUE INDEX IF NOT EXISTS participants_organization_email_key
  ON participants (organization_id, lower(email))
  WHERE email <> '' AND is_deleted = false;

DROP INDEX IF EXISTS admin_users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_key
  ON admin_users (lower(email)) WHERE is_deleted = false;

-- ---------------------------------------------------------------------------
-- Every list in the app filters on is_deleted, so the common indexes should too.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS organizations_live_idx
  ON organizations (created_at DESC) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS participants_live_idx
  ON participants (organization_id, created_at DESC) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS questions_live_idx
  ON questions (set_id, position, id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS attempts_live_board_idx
  ON attempts (organization_id, score DESC, answer_ms ASC, submitted_at ASC)
  WHERE status = 'completed' AND is_deleted = false;

-- ===========================================================================
--  Multiple correct answers, and a picture on a question
--
--  Two additions, both backwards compatible:
--
--    correct_indexes   a JSON array of 0-based indexes into `options`. A single
--                      answer is just an array of one. `correct_index` is kept
--                      in step with the *first* of them, so an older read path
--                      and the original CHECK above both still work.
--
--    image_url         an optional picture shown above the question. Either
--                      /api/media/<uuid> for a file uploaded in the admin panel
--                      (stored in `media` below) or a full https:// link.
--
--  A question whose correct_indexes is an empty array falls back to
--  correct_index when it is marked, so a row written by hand-rolled SQL — the
--  seeds and the verify scripts do exactly that — still behaves correctly.
-- ===========================================================================

ALTER TABLE questions ADD COLUMN IF NOT EXISTS correct_indexes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_url       text  NOT NULL DEFAULT '';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_alt       text  NOT NULL DEFAULT '';

-- Every question that predates the column gets its single answer written into
-- the new shape. Idempotent: a second run finds nothing left to fill.
UPDATE questions
   SET correct_indexes = jsonb_build_array(correct_index)
 WHERE jsonb_typeof(correct_indexes) = 'array'
   AND jsonb_array_length(correct_indexes) = 0;

-- ---------------------------------------------------------------------------
-- The answer key has to stay pointing at options that exist, which needs more
-- than a plain expression: the indexes must be whole numbers, in range, and
-- none repeated. A CHECK cannot hold a subquery, so the test lives in an
-- IMMUTABLE function instead — which a CHECK is allowed to call.
--
-- Returns false rather than raising for every shape of bad input, so a mistake
-- surfaces as "violates check constraint", not as a cast error.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION quiz_answer_key_ok(keys jsonb, option_count integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN keys IS NULL OR jsonb_typeof(keys) <> 'array' THEN false
    WHEN jsonb_array_length(keys) < 1 THEN false
    WHEN jsonb_array_length(keys) > option_count THEN false
    ELSE (
      SELECT bool_and(k IS NOT NULL AND k >= 0 AND k < option_count)
             AND count(DISTINCT k) = jsonb_array_length(keys)
        FROM (
          SELECT CASE
                   WHEN jsonb_typeof(e) = 'number'
                    AND (e #>> '{}')::numeric = trunc((e #>> '{}')::numeric)
                   THEN (e #>> '{}')::int
                 END AS k
            FROM jsonb_array_elements(keys) AS e
        ) t
    )
  END
$fn$;

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_correct_indexes_valid;
ALTER TABLE questions ADD CONSTRAINT questions_correct_indexes_valid CHECK (
  correct_indexes = '[]'::jsonb
  OR quiz_answer_key_ok(correct_indexes, jsonb_array_length(options))
);

-- ---------------------------------------------------------------------------
-- Uploaded pictures live in the database rather than on disk, because the app
-- runs on serverless functions with no writable filesystem and no object store
-- to configure. A question image is a few tens of kilobytes and is read once
-- per student with a year-long cache header, so this costs very little.
--
-- The id is a random uuid and the serving route is public: a student's phone
-- has no admin session, so the picture cannot sit behind the admin guard. The
-- id is the only handle, and it is not guessable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mime           text        NOT NULL,
  bytes          bytea       NOT NULL,
  byte_size      integer     NOT NULL,
  original_name  text        NOT NULL DEFAULT '',
  uploaded_by    bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_mime_allowed CHECK (
    mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  ),
  CONSTRAINT media_size_sane CHECK (byte_size > 0 AND byte_size <= 2097152)
);
CREATE INDEX IF NOT EXISTS media_created_idx ON media (created_at DESC);

-- ===========================================================================
--  A time limit for a whole quiz
--
--  Lives on the question set rather than on the event, so a set carries its own
--  duration everywhere it is used and nobody has to remember to set it when
--  they create the event.
--
--  NULL means no limit, which is what every existing set gets — so this changes
--  nothing until somebody fills it in. Seconds rather than minutes because the
--  client counts down in seconds; the admin panel asks for minutes and converts.
-- ===========================================================================

ALTER TABLE question_sets ADD COLUMN IF NOT EXISTS time_limit_seconds integer;

ALTER TABLE question_sets DROP CONSTRAINT IF EXISTS question_sets_time_limit_sane;
ALTER TABLE question_sets ADD CONSTRAINT question_sets_time_limit_sane CHECK (
  time_limit_seconds IS NULL
  OR (time_limit_seconds >= 30 AND time_limit_seconds <= 6 * 60 * 60)
);

-- ===========================================================================
--  A round with an end of its own
--
--  `is_open` is the switch a host throws by hand. `closes_at` is the deadline a
--  round was started with: press Start and the event opens for as long as the
--  question set's time limit says, then stops accepting entries on its own.
--
--  NULL means no deadline — the event stays open until somebody closes it,
--  which is how every event behaved before this and how an untimed set still
--  behaves. An event is accepting entries when `is_open` is true AND the
--  deadline is either absent or still ahead; see src/lib/eventWindow.ts, which
--  is the one place that decides it.
--
--  Nothing flips `is_open` when the deadline passes. There is no job to run it,
--  and there does not need to be: a past deadline already means closed
--  everywhere it is read, and pressing Start again simply sets a new one.
-- ===========================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS closes_at timestamptz;
