import { sql } from "@/lib/db";
import { ok, fail, route, readJson, ipHash } from "@/lib/api";
import { getOrganizationBySlug } from "@/lib/queries";
import { buildServedQuestions, stripAnswers } from "@/lib/quiz";
import { registerSchema, emailField, normalizePhone } from "@/lib/validate";
import { nameMatches } from "@/lib/identity";
import { acceptingEntries, beginsInMs, questionsReady, roundNotStarted } from "@/lib/eventWindow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/quiz/start
 *
 * Registers the student against this event and opens an attempt. The response
 * carries the questions with the answer key stripped out; the key stays on the
 * attempt row so the submission can be marked here rather than in the browser.
 */
export const POST = route(async (req: Request) => {
  const body = await readJson(req);
  const input = registerSchema.parse(body);

  const organization = await getOrganizationBySlug(input.slug);
  if (!organization) return fail("No event found with that code.", 404, "slug");
  // The whole-quiz limit lives on the set, so it travels with the questions
  // wherever they are used. NULL means no limit, which is the common case.
  // Read before the door is checked, because for a timed event it is part of
  // the door: there is no round to join until Start has given it a deadline.
  const [limitRow] = (await sql`
    SELECT time_limit_seconds FROM question_sets
     WHERE id = ${organization.question_set_id} AND is_deleted = false
     LIMIT 1`) as unknown as { time_limit_seconds: number | null }[];
  const timeLimitSeconds = limitRow?.time_limit_seconds ?? null;

  // Closed by hand, or the round ran out — the student cannot tell the
  // difference and does not need to. A timed event that is open but unstarted
  // is *not* closed: that is the waiting room, and registering is exactly what
  // a student does there, so it falls through to the branch further down.
  if (!acceptingEntries(organization))
    return fail("This quiz is closed.", 403);

  // Email is optional per event, but validated when it is required or supplied.
  let email = "";
  if (organization.require_email || String(input.email ?? "").trim()) {
    email = emailField.parse(input.email ?? "");
  }
  const classOrYear = organization.collect_class ? String(input.classOrYear ?? "").trim().slice(0, 60) : "";
  const phone = normalizePhone(input.phone);

  const served = await buildServedQuestions(organization);
  if (!served.length)
    return fail("This event has no questions set up yet.", 409);

  /* -------------------------- find or create the student -----------------
     There is exactly one row per mobile number per event, for ever. If the
     team deleted this student's entry, registering again revives that same row
     rather than adding a second one — so nobody ends up with two records and
     two email addresses on file.

     Their old attempts stay deleted, which is what lets them play again: the
     retake check below only counts attempts that are not deleted. Once this
     new attempt is in, the number is spoken for again.

     The mobile number is the identity, but the email address is unique per
     event too — so both have to be looked at before deciding who this is.
     A student who registers, comes back, and retypes their number differently
     is the same student: recognising them by their address and moving the row
     to the new number is right, and refusing them for reusing their own
     address is not. Only the retake rule below may turn somebody away. */

  // The phone index is absolute, deleted rows included, so this must not filter
  // on is_deleted or the upsert below could still collide with a hidden row.
  const [byPhone] = (await sql`
    SELECT id FROM participants
     WHERE organization_id = ${organization.id} AND phone = ${phone}
     LIMIT 1`) as unknown as { id: number }[];

  // The email index only covers live rows, so this matches it.
  const [byEmail] = (email
    ? await sql`
        SELECT id, name FROM participants
         WHERE organization_id = ${organization.id}
           AND lower(email) = lower(${email}) AND is_deleted = false
         LIMIT 1`
    : []) as unknown as { id: number; name: string }[];

  // Two different rows: the address really does belong to somebody else, which
  // is exactly what the one-address-per-event rule is for.
  if (byPhone && byEmail && Number(byPhone.id) !== Number(byEmail.id))
    return fail(
      "That email address is already registered for this event with a different mobile number.",
      409,
      "email",
    );

  // The address is on file under a number nobody has registered. Same name, and
  // this is the student coming back having typed their number differently.
  // A different name, and it is two students sharing one inbox — which is what
  // the address rule is for, so this stays refused.
  const returningByEmail = Boolean(byEmail) && !byPhone;
  if (returningByEmail && !nameMatches(input.name, byEmail.name))
    return fail(
      "That email address is already registered for this event by someone else. " +
        "Use your own address, or the mobile number you registered with.",
      409,
      "email",
    );

  /* ---- decide, and only then write ------------------------------------
     The retake rule is checked before anything is stored, because a refused
     registration must leave the database exactly as it found it. Moving the
     row first and refusing afterwards is what made a finished student's number
     drift onto whatever was typed next: their row would follow the new number,
     that number would then be spoken for, and the person it really belonged to
     could never register. Read first, refuse, then write. */
  const existingId = byPhone ? byPhone.id : returningByEmail ? byEmail.id : null;

  const [{ finished }] = (existingId === null
    ? [{ finished: 0 }]
    : ((await sql`
        SELECT count(*)::int AS finished
          FROM attempts
         WHERE participant_id = ${existingId} AND status = 'completed'
           AND is_deleted = false`) as unknown as { finished: number }[])) as {
    finished: number;
  }[];

  // Turning somebody away happens here and only here: once they have actually
  // finished a run. Whether they came back by number or by address, the reason
  // is the same, so say the same thing and point at the field they can act on.
  if (finished > 0 && !organization.allow_retake)
    return fail(
      "You have already played this quiz. Open your dashboard to see your score.",
      409,
      returningByEmail ? "email" : "phone",
    );

  const [participant] = (returningByEmail
    ? // Same student, new number. Move their row rather than refuse them.
      await sql`
        UPDATE participants
           SET name          = ${input.name},
               phone         = ${phone},
               class_or_year = CASE WHEN ${classOrYear} = '' THEN class_or_year
                                    ELSE ${classOrYear} END,
               is_deleted    = false,
               deleted_at    = NULL,
               deleted_by    = NULL
         WHERE id = ${byEmail.id}
        RETURNING id`
    : await sql`
        INSERT INTO participants (organization_id, name, phone, email, class_or_year)
        VALUES (${organization.id}, ${input.name}, ${phone}, ${email}, ${classOrYear})
        ON CONFLICT (organization_id, phone) DO UPDATE
           SET name          = EXCLUDED.name,
               email         = CASE WHEN EXCLUDED.email = '' THEN participants.email
                                    ELSE EXCLUDED.email END,
               class_or_year = CASE WHEN EXCLUDED.class_or_year = '' THEN participants.class_or_year
                                    ELSE EXCLUDED.class_or_year END,
               is_deleted    = false,
               deleted_at    = NULL,
               deleted_by    = NULL
        RETURNING id`) as unknown as { id: number }[];

  /* ---- the waiting room -------------------------------------------------
     Everything above has happened: they are registered, their number and
     address are theirs, and the retake rule has let them through. What has not
     happened is the round — so no attempt is opened, and no questions leave the
     server. Registering early is the whole point: typing a name and a mobile
     number is not something to spend a five-minute round on.

     The phone waits, watching /api/public/organization, and calls this route
     again when the lead-in runs out. That second call finds this same
     participant by number, opens the attempt, and stamps `started_at` at the
     moment the questions actually appear — which is what the clock is read
     from, here and at submit. */
  if (!questionsReady(organization, timeLimitSeconds)) {
    // Shape only — how many questions, how many marks, how many take more than
    // one answer. Derived from the stripped copy, so it is provably free of the
    // answer key: the room can read the rules while it waits without a single
    // question leaving the server before the round starts.
    const shape = stripAnswers(served);
    return ok({
      waiting: true,
      beginsInMs: beginsInMs(organization, timeLimitSeconds),
      timeLimitSeconds,
      summary: {
        total: shape.length,
        marks: shape.reduce((t, q) => t + q.pts, 0),
        multiCount: shape.filter((q) => q.multi).length,
        pointsEach: shape[0]?.pts ?? 1,
        mixedMarks: new Set(shape.map((q) => q.pts)).size > 1,
      },
      student: { name: input.name },
      organization: { name: organization.name, slug: organization.slug, prizeNote: organization.prize_note },
    });
  }

  /* --------------------------- open the attempt -------------------------- */
  const [attempt] = (await sql`
    INSERT INTO attempts (
      participant_id, organization_id, question_set_id, served,
      question_count, max_score, ip_hash, user_agent
    )
    VALUES (
      ${participant.id}, ${organization.id}, ${organization.question_set_id},
      ${JSON.stringify(served)}::jsonb, ${served.length},
      ${served.reduce((t, q) => t + q.pts, 0)},
      ${ipHash(req)}, ${(req.headers.get("user-agent") ?? "").slice(0, 300)}
    )
    RETURNING public_id`) as unknown as { public_id: string }[];

  return ok({
    attemptId: attempt.public_id,
    questions: stripAnswers(served),
    timeLimitSeconds,
    student: { name: input.name },
    organization: { name: organization.name, slug: organization.slug, prizeNote: organization.prize_note },
  });
});
