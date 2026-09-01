import { sql } from "@/lib/db";
import { ok, fail, route, requireAdmin } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/organizations/:id/live
 *
 * What the run screen needs while a round is going, and nothing else.
 *
 * The full detail route answers in five database round trips and carries the
 * whole results table, the per-question analysis and the did-not-finish list —
 * fine to open once, wasteful every few seconds for a screen showing four
 * numbers and five names. This is one round trip and a payload that does not
 * grow with the size of the room: the leaderboard is capped, and everything
 * else is a count.
 *
 * One row per student on the board, best attempt only, so a retake cannot put
 * somebody on it twice.
 */
export const GET = route(async (_req: Request, ctx: Ctx) => {
  await requireAdmin();
  const id = Number((await ctx.params).id);
  if (!Number.isFinite(id) || id <= 0) return fail("Event not found.", 404);

  const [row] = (await sql`
    SELECT
      (SELECT row_to_json(o) FROM (
         SELECT id, name, slug, city, is_open, closes_at
           FROM organizations WHERE id = ${id} AND is_deleted = false
       ) o)                                                                    AS organization,

      -- The run screen needs this to tell an untimed event apart from a timed
      -- one that has not been started: closes_at is null for both, but only
      -- the second still has a round to start.
      (SELECT qs.time_limit_seconds FROM organizations o
         JOIN question_sets qs ON qs.id = o.question_set_id
        WHERE o.id = ${id} AND qs.is_deleted = false)                          AS time_limit_seconds,

      (SELECT count(*)::int FROM participants
        WHERE organization_id = ${id} AND is_deleted = false)                  AS registered,

      (SELECT count(*)::int FROM attempts
        WHERE organization_id = ${id} AND status = 'completed'
          AND is_deleted = false)                                              AS completed,

      -- Still answering: only while their own countdown could still be running.
      -- Matches organizationSummary, and is explained there.
      (SELECT count(*)::int FROM attempts a
        WHERE a.organization_id = ${id} AND a.status = 'in_progress'
          AND a.is_deleted = false
          AND a.started_at > now() - (
                COALESCE(
                  (SELECT qs.time_limit_seconds FROM organizations o
                     JOIN question_sets qs ON qs.id = o.question_set_id
                    WHERE o.id = ${id}),
                  3600
                )::text || ' seconds')::interval)                              AS answering,

      (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
         SELECT b.id, b.name, b.score, b.max_score,
                ROW_NUMBER() OVER (
                  ORDER BY b.score DESC, b.answer_ms ASC, b.submitted_at ASC
                )::int AS rank
           FROM (
             SELECT DISTINCT ON (a.participant_id)
                    a.id, p.name, a.score, a.max_score, a.answer_ms, a.submitted_at
               FROM attempts a
               JOIN participants p ON p.id = a.participant_id
              WHERE a.organization_id = ${id} AND a.status = 'completed'
                AND a.is_deleted = false AND p.is_deleted = false
              ORDER BY a.participant_id, a.score DESC, a.answer_ms ASC, a.submitted_at ASC
           ) b
          ORDER BY b.score DESC, b.answer_ms ASC, b.submitted_at ASC
          LIMIT 5
       ) t)                                                                    AS top
  `) as unknown as {
    organization: { id: number; name: string; slug: string; city: string; is_open: boolean; closes_at: string | null } | null;
    time_limit_seconds: number | null;
    registered: number;
    completed: number;
    answering: number;
    top: { id: number; name: string; score: number; max_score: number; rank: number }[];
  }[];

  if (!row?.organization) return fail("Event not found.", 404);

  return ok({
    organization: row.organization,
    timeLimitSeconds: row.time_limit_seconds ?? null,
    summary: {
      registered: row.registered,
      completed: row.completed,
      answering: row.answering,
    },
    top: row.top,
  });
});
