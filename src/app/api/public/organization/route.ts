import { sql } from "@/lib/db";
import { ok, fail, route } from "@/lib/api";
import { getOrganizationBySlug } from "@/lib/queries";
import { slugify } from "@/lib/validate";
import { acceptingEntries, closesInMs } from "@/lib/eventWindow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/public/organization?code=svcollege2026
 *
 * Turns the code a student types into the details their landing page needs.
 * Deliberately returns nothing sensitive: no contact list, no scores, no
 * question text, and a 404 whether the code is wrong or the event was deleted.
 */
export const GET = route(async (req: Request) => {
  const raw = new URL(req.url).searchParams.get("code") ?? "";
  const code = slugify(raw);
  if (!code) return fail("Enter an event code.", 400, "code");

  const organization = await getOrganizationBySlug(code);
  if (!organization) return fail("No event found with that code. Check the spelling and try again.", 404, "code");

  const [counts] = (await sql`
    SELECT
      (SELECT count(*)::int FROM questions
        WHERE set_id = ${organization.question_set_id}
          AND is_active = true AND is_deleted = false)                       AS total_questions,
      (SELECT count(*)::int FROM attempts
        WHERE organization_id = ${organization.id}
          AND status = 'completed' AND is_deleted = false)                   AS played
  `) as unknown as { total_questions: number; played: number }[];

  const total = organization.question_set_id ? counts.total_questions : 0;
  const asked = organization.question_count ? Math.min(organization.question_count, total) : total;

  return ok({
    organization: {
      slug: organization.slug,
      name: organization.name,
      city: organization.city,
      isOpen: acceptingEntries(organization) && asked > 0,
      closesInMs: closesInMs(organization),
      hasQuestions: asked > 0,
      questionCount: asked,
      played: counts.played,
      requireEmail: organization.require_email,
      collectClass: organization.collect_class,
      showLeaderboard: organization.show_leaderboard,
      allowRetake: organization.allow_retake,
      prizeNote: organization.prize_note,
    },
  });
});
