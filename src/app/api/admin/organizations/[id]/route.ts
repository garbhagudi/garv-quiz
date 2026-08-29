import { sql } from "@/lib/db";
import { ok, fail, route, readJson, requireAdmin, requireWriter, audit } from "@/lib/api";
import { organizationPatchSchema } from "@/lib/validate";
import { deleteOrganization, deleteOrganizationEntries } from "@/lib/softDelete";
import {
  getOrganizationById,
  allAttemptsRanked,
  organizationSummary,
  questionAnalysis,
} from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = async (ctx: Ctx) => Number((await ctx.params).id);

/**
 * GET /api/admin/organizations/:id
 *
 * The full picture for one event: settings, headline numbers, every completed
 * attempt with contact details, students who registered but never finished,
 * and the per-question difficulty breakdown.
 */
export const GET = route(async (_req: Request, ctx: Ctx) => {
  await requireAdmin();
  const id = await idOf(ctx);
  // Deleted events stay openable, so their results can be read and restored.
  const organization = await getOrganizationById(id, true);
  if (!organization) return fail("Event not found.", 404);

  const [summary, results, analysis, notFinished] = await Promise.all([
    organizationSummary(id),
    allAttemptsRanked(id),
    questionAnalysis(id),
    sql`
      SELECT p.id, p.name, p.phone, p.email, p.class_or_year, p.created_at,
             (SELECT count(*)::int FROM attempts a
               WHERE a.participant_id = p.id AND a.is_deleted = false)   AS attempts
        FROM participants p
       WHERE p.organization_id = ${id} AND p.is_deleted = false
         AND NOT EXISTS (
           SELECT 1 FROM attempts a
            WHERE a.participant_id = p.id AND a.status = 'completed'
              AND a.is_deleted = false
         )
       ORDER BY p.created_at DESC`,
  ]);

  return ok({
    organization,
    summary,
    results: results.map((r) => ({
      ...r,
      accuracy: r.question_count ? Math.round((r.correct_count / r.question_count) * 1000) / 10 : 0,
      repeat: r.attempts_by_student > 1,
    })),
    analysis,
    notFinished,
  });
});

/**
 * PATCH /api/admin/organizations/:id — update the event and its quiz settings.
 *
 * A true partial update: anything the caller leaves out keeps its stored value,
 * so `{ isOpen: false }` closes entries without quietly resetting the shuffle,
 * retake or leaderboard settings alongside it.
 */
export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const admin = await requireWriter();
  const id = await idOf(ctx);
  const existing = await getOrganizationById(id);
  if (!existing) return fail("Event not found.", 404);

  const body = await readJson(req);
  const v = organizationPatchSchema.parse(body);

  // `undefined` means "not sent"; for the two nullable columns, null is a real
  // value ("ask every question", "no set"), so those check the raw body instead.
  const sent = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const pick = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value);

  const next = {
    slug: pick(v.slug, existing.slug),
    name: pick(v.name, existing.name),
    city: pick(v.city, existing.city),
    contactName: pick(v.contactName, existing.contact_name),
    contactPhone: pick(v.contactPhone, existing.contact_phone),
    eventDate: sent("eventDate") ? v.eventDate || null : existing.event_date,
    notes: pick(v.notes, existing.notes),
    questionSetId: sent("questionSetId") ? (v.questionSetId ?? null) : existing.question_set_id,
    isOpen: pick(v.isOpen, existing.is_open),
    questionCount: sent("questionCount") ? (v.questionCount ?? null) : existing.question_count,
    shuffleQuestions: pick(v.shuffleQuestions, existing.shuffle_questions),
    shuffleOptions: pick(v.shuffleOptions, existing.shuffle_options),
    allowRetake: pick(v.allowRetake, existing.allow_retake),
    showScore: pick(v.showScore, existing.show_score),
    showLeaderboard: pick(v.showLeaderboard, existing.show_leaderboard),
    requireEmail: pick(v.requireEmail, existing.require_email),
    collectClass: pick(v.collectClass, existing.collect_class),
    prizeNote: pick(v.prizeNote, existing.prize_note),
  };

  const [row] = (await sql`
    UPDATE organizations SET
      slug = ${next.slug}, name = ${next.name}, city = ${next.city},
      contact_name = ${next.contactName}, contact_phone = ${next.contactPhone},
      event_date = ${next.eventDate}, notes = ${next.notes},
      question_set_id = ${next.questionSetId}, is_open = ${next.isOpen},
      question_count = ${next.questionCount},
      shuffle_questions = ${next.shuffleQuestions}, shuffle_options = ${next.shuffleOptions},
      allow_retake = ${next.allowRetake}, show_score = ${next.showScore},
      show_leaderboard = ${next.showLeaderboard}, require_email = ${next.requireEmail},
      collect_class = ${next.collectClass}, prize_note = ${next.prizeNote}
    WHERE id = ${id}
    RETURNING *`) as unknown as Record<string, unknown>[];

  await audit(admin, "organization.update", next.slug, {
    id,
    renamedFrom: existing.slug === next.slug ? undefined : existing.slug,
    changed: Object.keys(body),
  });
  return ok({ organization: row });
});

/**
 * DELETE /api/admin/organizations/:id
 *
 * Two modes, because "clear the entries before the next visit" and "remove this
 * event entirely" are different jobs:
 *   ?mode=entries  keep the event and its code, remove participants + attempts
 *   ?mode=all      remove the event too
 * Both require ?confirm=<slug> so a mistyped click cannot wipe an event.
 *
 * Neither actually deletes. Rows are marked `is_deleted` and can be restored
 * from the admin panel, so the worst case is a few minutes of confusion rather
 * than a lost college.
 */
export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const admin = await requireWriter();
  const id = await idOf(ctx);
  const organization = await getOrganizationById(id);
  if (!organization) return fail("Event not found.", 404);

  const params = new URL(req.url).searchParams;
  const mode = params.get("mode") === "all" ? "all" : "entries";
  const confirm = (params.get("confirm") ?? "").trim().toLowerCase();

  if (confirm !== organization.slug.toLowerCase())
    return fail(`Type the event code "${organization.slug}" to confirm.`, 400, "confirm");

  const counts =
    mode === "all"
      ? await deleteOrganization(id, admin.aid)
      : await deleteOrganizationEntries(id, admin.aid);

  await audit(
    admin,
    mode === "all" ? "organization.delete" : "organization.clearEntries",
    organization.slug,
    { id, ...counts },
  );

  return ok({
    mode,
    removed: counts.participants ?? 0,
    deletedEvent: mode === "all",
    recoverable: true,
    counts,
  });
});
