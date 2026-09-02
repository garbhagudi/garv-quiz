import { sql } from "@/lib/db";
import { ok, fail, route, readJson } from "@/lib/api";
import { markSubmission, type ServedQuestion } from "@/lib/quiz";
import { submitSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AttemptRow = {
  id: number;
  organization_id: number;
  participant_id: number;
  status: string;
  served: ServedQuestion[];
  started_at: string;
  score: number;
  max_score: number;
  correct_count: number;
  question_count: number;
  answer_ms: number;
  show_score: boolean;
  slug: string;
  time_limit_seconds: number | null;
};

/**
 * How late a submission may be and still count.
 *
 * The student's countdown is started in their browser once the page has the
 * questions, which is always a moment after `started_at` was stamped here - so
 * an honest auto-submit at zero lands a little after the server's own deadline.
 * That gap is a round trip plus a render, never fifteen seconds.
 */
const GRACE_MS = 15_000;

/**
 * POST /api/quiz/submit
 *
 * Marks the attempt against the snapshot stored when it started. The client
 * only says which option index it tapped for each position - every point is
 * awarded here, so a hand-crafted request cannot inflate a score.
 */
export const POST = route(async (req: Request) => {
  const input = submitSchema.parse(await readJson(req));

  const [attempt] = (await sql`
    SELECT a.id, a.organization_id, a.participant_id, a.status, a.served, a.started_at,
           a.score, a.max_score, a.correct_count, a.question_count, a.answer_ms,
           s.show_score, s.slug,
           -- Read from the set the attempt was built against, not the event's
           -- current one, so re-pointing an event mid-quiz cannot move the
           -- deadline of a run that is already going.
           (SELECT qs.time_limit_seconds FROM question_sets qs
             WHERE qs.id = a.question_set_id) AS time_limit_seconds
      FROM attempts a
      JOIN organizations s ON s.id = a.organization_id
     WHERE a.public_id = ${input.attemptId}::uuid
       AND a.is_deleted = false AND s.is_deleted = false
     LIMIT 1`) as unknown as AttemptRow[];

  if (!attempt) return fail("We could not find this attempt. Please start again.", 404);

  // Re-submits (double tap, flaky network retry) return the first result rather
  // than erroring or overwriting it.
  if (attempt.status === "completed") {
    return ok({
      alreadySubmitted: true,
      score: attempt.show_score ? attempt.score : null,
      maxScore: attempt.max_score,
      correctCount: attempt.correct_count,
      questionCount: attempt.question_count,
      answerMs: attempt.answer_ms,
      slug: attempt.slug,
    });
  }
  if (attempt.status !== "in_progress") return fail("This attempt is no longer open.", 409);

  /* ---- the student's own clock, enforced here ---------------------------
     Every other number on an attempt is worked out on this server precisely so
     a crafted request cannot win; the time limit was the one rule left to the
     browser. It is a per-attempt window, not the round's: a student who starts
     four minutes into a five-minute round still gets their full five, which is
     why this counts from `started_at` and never looks at `closes_at`.

     An expired attempt is marked abandoned rather than left open. It is not
     coming back, and saying so keeps the host's "still answering" count honest
     instead of showing a student who walked out an hour ago. */
  const limitSeconds = attempt.time_limit_seconds;
  if (limitSeconds) {
    const startedAt = new Date(attempt.started_at).getTime();
    const expiredBy = Number.isFinite(startedAt)
      ? Date.now() - (startedAt + limitSeconds * 1000 + GRACE_MS)
      : 0;
    if (expiredBy > 0) {
      await sql`UPDATE attempts SET status = 'abandoned' WHERE id = ${attempt.id}`;
      return fail("Your time for this quiz has run out, so this cannot be submitted.", 409);
    }
  }

  const served = Array.isArray(attempt.served) ? attempt.served : [];
  if (!served.length) return fail("This attempt has no questions recorded. Please start again.", 409);

  const marked = markSubmission(served, input.answers);

  // Wall-clock time is client-reported, so keep it sane: never less than the
  // summed thinking time, never more than the real gap since the attempt opened.
  const sinceStart = Date.now() - new Date(attempt.started_at).getTime();
  const elapsedMs = Math.min(
    Math.max(marked.answerMs, input.elapsedMs),
    Math.max(marked.answerMs, sinceStart + 5000),
  );

  const answerRows = marked.rows.map((r) => ({
    questionId: r.questionId,
    position: r.position,
    questionText: r.questionText,
    chosenText: r.chosenText,
    correctText: r.correctText,
    isCorrect: r.isCorrect,
    points: r.points,
    ms: r.ms,
  }));

  await sql.transaction([
    sql`
      INSERT INTO answers (
        attempt_id, question_id, position, question_text,
        chosen_text, correct_text, is_correct, points, ms
      )
      SELECT ${attempt.id},
             NULLIF(r->>'questionId', '')::bigint,
             (r->>'position')::int,
             r->>'questionText',
             r->>'chosenText',
             r->>'correctText',
             (r->>'isCorrect')::boolean,
             (r->>'points')::int,
             (r->>'ms')::int
        FROM jsonb_array_elements(${JSON.stringify(answerRows)}::jsonb) AS r
      ON CONFLICT (attempt_id, position) DO NOTHING`,
    sql`
      UPDATE attempts
         SET status        = 'completed',
             score         = ${marked.score},
             max_score     = ${marked.maxScore},
             correct_count = ${marked.correctCount},
             question_count = ${served.length},
             answer_ms     = ${marked.answerMs},
             elapsed_ms    = ${elapsedMs},
             best_streak   = ${marked.bestStreak},
             -- Measured here, from this server's clock, because the tie-break
             -- rides on it. answer_ms above is only what the phone reported.
             server_ms     = LEAST(
                               2147483647,
                               GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)
                             )::int,
             submitted_at  = now()
       WHERE id = ${attempt.id} AND status = 'in_progress'`,
  ]);

  return ok({
    score: attempt.show_score ? marked.score : null,
    maxScore: marked.maxScore,
    correctCount: attempt.show_score ? marked.correctCount : null,
    questionCount: served.length,
    answerMs: marked.answerMs,
    slug: attempt.slug,
  });
});
