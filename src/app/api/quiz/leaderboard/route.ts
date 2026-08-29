import { sql } from "@/lib/db";
import { ok, fail, route } from "@/lib/api";
import { getOrganizationBySlug, bestAttemptsRanked } from "@/lib/queries";
import { slugify } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOP_N = 10;

/**
 * GET /api/quiz/leaderboard?code=<slug>&attempt=<publicId>
 *
 * The board students see: names and points, nothing else. Response times decide
 * ties but are never sent here, and neither are phone numbers or emails — which
 * is why the public board can legitimately differ from the announced winner.
 */
export const GET = route(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const code = slugify(params.get("code") ?? "");
  const attemptId = (params.get("attempt") ?? "").trim();

  const organization = await getOrganizationBySlug(code);
  if (!organization) return fail("No event found with that code.", 404);
  if (!organization.show_leaderboard)
    return fail("The leaderboard is hidden for this event.", 403);

  const ranked = await bestAttemptsRanked(organization.id);

  // Locate the caller by their attempt id, so "you" can be highlighted without
  // the page having to send a name or a phone number.
  let you: { rank: number; score: number; maxScore: number; name: string } | null = null;
  if (attemptId) {
    const [mine] = (await sql`
      SELECT participant_id FROM attempts
       WHERE public_id = ${attemptId}::uuid AND organization_id = ${organization.id}
         AND is_deleted = false
       LIMIT 1`) as unknown as { participant_id: number }[];
    if (mine) {
      const row = ranked.find((r) => Number(r.participant_id) === Number(mine.participant_id));
      if (row) you = { rank: row.rank, score: row.score, maxScore: row.max_score, name: row.name };
    }
  }

  return ok({
    count: ranked.length,
    outOf: ranked[0]?.max_score ?? 0,
    you,
    top: ranked.slice(0, TOP_N).map((r) => ({
      rank: r.rank,
      name: r.name,
      score: r.score,
      maxScore: r.max_score,
    })),
  });
});
