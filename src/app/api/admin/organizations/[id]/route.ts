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

  /* ---- Start round ------------------------------------------------------
     Its own action rather than a field, because one press means two things:
     open the entries, and give the round the deadline the question set asks
     for. An untimed set has no deadline to give, so Start there is simply
     "open", which is what the button has always done.

     Handled before the partial update below, so starting a round cannot happen
     by accident while somebody is renaming an event.

     The deadline is worked out here rather than in SQL because every reader
     compares it against its own clock — the browser's, or this server's — and
     never against the database's. Computing it the same way it is read keeps
     one clock in the story instead of two. */
  if (body.startRound === true) {
    const [limit] = (await sql`
      SELECT time_limit_seconds FROM question_sets
       WHERE id = ${existing.question_set_id} AND is_deleted = false
       LIMIT 1`) as unknown as { time_limit_seconds: number | null }[];
    const seconds = limit?.time_limit_seconds ?? null;
    const closesAt =
      seconds === null ? null : new Date(Date.now() + seconds * 1000).toISOString();

    const [row] = (await sql`
      UPDATE organizations
         SET is_open = true, closes_at = ${closesAt}
       WHERE id = ${id} AND is_deleted = false
      RETURNING *`) as unknown as Record<string, unknown>[];
    if (!row) return fail("Event not found.", 404);

    await audit(admin, "organization.startRound", existing.slug, { id, seconds });
    return ok({ organization: row });
  }

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
    // Throwing the switch by hand ends whatever round was running, in either
    // direction: closing must not leave a deadline ticking behind it, and
    // reopening by hand means "open until I say otherwise". Any other edit
    // leaves the running round alone.
    closesAt: sent("isOpen") ? null : existing.closes_at,
  };

  const [row] = (await sql`
    UPDATE organizations SET
      slug = ${next.slug}, name = ${next.name}, city = ${next.city},
      contact_name = ${next.contactName}, contact_phone = ${next.contactPhone},
      event_date = ${next.eventDate}, notes = ${next.notes},
      question_set_id = ${next.questionSetId}, is_open = ${next.isOpen},
      closes_at = ${next.closesAt},
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
