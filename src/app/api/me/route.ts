import { sql } from "@/lib/db";
import { ok, fail, route, readJson } from "@/lib/api";
import { getOrganizationBySlug, getOrganizationById, bestAttemptsRanked } from "@/lib/queries";
import { participantLoginSchema } from "@/lib/validate";
import { nameMatches } from "@/lib/identity";
import {
  createParticipantSession,
  clearParticipantSession,
  getParticipantSession,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ParticipantRow = {
  id: number;
  organization_id: number;
  name: string;
  phone: string;
  email: string;
  class_or_year: string;
  created_at: string;
};

/**
 * Everything a student is allowed to see about themselves: their attempts,
 * their rank, and — once the host has closed the event — a question-by-question
 * review. The review stays hidden while the quiz is open so a finished student
 * can't read the answers out to the row behind them.
 */
async function dashboard(participantId: number, organizationId: number) {
  const organization = await getOrganizationById(organizationId);
  if (!organization) return null;

  const [participant] = (await sql`
    SELECT id, organization_id, name, phone, email, class_or_year, created_at
      FROM participants
     WHERE id = ${participantId} AND organization_id = ${organizationId}
       AND is_deleted = false
     LIMIT 1`) as unknown as ParticipantRow[];
  if (!participant) return null;

  const attempts = (await sql`
    SELECT public_id, status, score, max_score, correct_count, question_count,
           answer_ms, elapsed_ms, started_at, submitted_at
      FROM attempts
     WHERE participant_id = ${participantId} AND is_deleted = false
     ORDER BY started_at DESC`) as unknown as {
    public_id: string;
    status: string;
    score: number;
    max_score: number;
    correct_count: number;
    question_count: number;
    answer_ms: number;
    elapsed_ms: number;
    started_at: string;
    submitted_at: string | null;
  }[];

  const ranked = organization.show_leaderboard ? await bestAttemptsRanked(organization.id) : [];
  const mine = ranked.find((r) => Number(r.participant_id) === Number(participantId));

  const reviewUnlocked = !organization.is_open;
  const best = attempts.find((a) => a.status === "completed");
  let review: {
    position: number;
    question: string;
    chosen: string;
    correct: string;
    isCorrect: boolean;
    /** Marks earned, and what the question was worth. */
    points: number;
    maxPoints: number;
    ms: number;
  }[] = [];

  if (reviewUnlocked && best) {
    // `answers.points` records what was earned, which is 0 on a wrong answer —
    // so what the question was *worth* has to come from the attempt's own
    // snapshot, where every question kept its `pts`.
    const rows = (await sql`
      SELECT ans.position, ans.question_text, ans.chosen_text, ans.correct_text,
             ans.is_correct, ans.points, ans.ms,
             COALESCE((a.served -> ans.position ->> 'pts')::int, ans.points) AS max_points
        FROM answers ans
        JOIN attempts a ON a.id = ans.attempt_id
       WHERE a.public_id = ${best.public_id}::uuid AND a.is_deleted = false
       ORDER BY ans.position ASC`) as unknown as {
      position: number;
      question_text: string;
      chosen_text: string;
      correct_text: string;
      is_correct: boolean;
      points: number;
      max_points: number;
      ms: number;
    }[];
    review = rows.map((r) => ({
      position: r.position,
      question: r.question_text,
      chosen: r.chosen_text,
      correct: r.correct_text,
      isCorrect: r.is_correct,
      points: Number(r.points) || 0,
      maxPoints: Number(r.max_points) || 0,
      ms: r.ms,
    }));
  }

  return {
    student: {
      name: participant.name,
      phone: participant.phone,
      email: participant.email,
      classOrYear: participant.class_or_year,
      registeredAt: participant.created_at,
    },
    organization: {
      slug: organization.slug,
      name: organization.name,
      city: organization.city,
      isOpen: organization.is_open,
      showLeaderboard: organization.show_leaderboard,
      prizeNote: organization.prize_note,
    },
    attempts: attempts.map((a) => ({
      attemptId: a.public_id,
      status: a.status,
      score: organization.show_score ? a.score : null,
      maxScore: a.max_score,
      correctCount: organization.show_score ? a.correct_count : null,
      questionCount: a.question_count,
      answerMs: a.answer_ms,
      elapsedMs: a.elapsed_ms,
      startedAt: a.started_at,
      submittedAt: a.submitted_at,
    })),
    rank: mine ? { position: mine.rank, of: ranked.length } : null,
    leaderboard: organization.show_leaderboard
      ? ranked.slice(0, 10).map((r) => ({ rank: r.rank, name: r.name, score: r.score }))
      : [],
    review,
    reviewUnlocked,
  };
}

/* ------------------------------- GET: resume ---------------------------- */

export const GET = route(async () => {
  const session = await getParticipantSession();
  if (!session) return fail("Not signed in.", 401);
  const data = await dashboard(session.pid, session.sid);
  if (!data) {
    await clearParticipantSession();
    return fail("Your record is no longer available.", 404);
  }
  return ok(data);
});

/* ------------------------------- POST: sign in -------------------------- */

export const POST = route(async (req: Request) => {
  const input = participantLoginSchema.parse(await readJson(req));

  const organization = await getOrganizationBySlug(input.slug);
  if (!organization) return fail("No event found with that code.", 404, "slug");

  const [participant] = (await sql`
    SELECT id, name FROM participants
     WHERE organization_id = ${organization.id} AND phone = ${input.phone}
       AND is_deleted = false
     LIMIT 1`) as unknown as { id: number; name: string }[];

  // One message for both "no such number" and "name doesn't match", so the form
  // can't be used to check whether a given number played.
  const bad = "We could not match those details. Check the name and mobile number you registered with.";
  if (!participant) return fail(bad, 404, "phone");
  if (input.name && !nameMatches(input.name, participant.name)) return fail(bad, 404, "name");

  // Bigints come back from Postgres as strings; the dashboard compares them
  // numerically, so coerce here rather than at every comparison downstream.
  await createParticipantSession({
    pid: Number(participant.id),
    sid: Number(organization.id),
    name: participant.name,
  });
  const data = await dashboard(Number(participant.id), Number(organization.id));
  if (!data) return fail(bad, 404);
  return ok(data);
});

/* ------------------------------ DELETE: sign out ------------------------ */

export const DELETE = route(async () => {
  await clearParticipantSession();
  return ok();
});
