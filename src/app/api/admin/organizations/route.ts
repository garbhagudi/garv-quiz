import { sql } from "@/lib/db";
import { ok, route, readJson, requireAdmin, requireWriter, audit } from "@/lib/api";
import { organizationSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/organizations — every event, with live counts for the list view. */
export const GET = route(async (req: Request) => {
  await requireAdmin();
  const params = new URL(req.url).searchParams;
  // The admin panel asks for deleted rows explicitly, so they can be reviewed
  // and restored; nothing else ever sees them.
  const includeDeleted = params.get("deleted") === "1";
  const q = (params.get("q") ?? "").trim();
  // An empty search becomes '%%', which every non-null name matches — so the
  // same query serves both "list all" and "search".
  const like = `%${q}%`;

  const organizations = await sql`
    SELECT s.*,
           qs.name AS set_name,
           -- The status badge needs this: a timed event that is open with no
           -- deadline is a waiting room, an untimed one is simply open, and
           -- closes_at is null for both.
           qs.time_limit_seconds,
           (SELECT count(*)::int FROM participants p
             WHERE p.organization_id = s.id AND p.is_deleted = false)             AS registered,
           (SELECT count(*)::int FROM attempts a
             WHERE a.organization_id = s.id AND a.status = 'completed'
               AND a.is_deleted = false)                                          AS completed,
           (SELECT count(*)::int FROM questions qn
             WHERE qn.set_id = s.question_set_id AND qn.is_active = true
               AND qn.is_deleted = false)                                         AS set_questions,
           (SELECT max(a.score) FROM attempts a
             WHERE a.organization_id = s.id AND a.status = 'completed'
               AND a.is_deleted = false)                                          AS top_score
      FROM organizations s
      LEFT JOIN question_sets qs ON qs.id = s.question_set_id
     WHERE (s.name ILIKE ${like} OR s.slug ILIKE ${like} OR s.city ILIKE ${like})
       AND (${includeDeleted} OR s.is_deleted = false)
     ORDER BY s.is_deleted ASC, s.created_at DESC`;

  return ok({ organizations });
});

/** POST /api/admin/organizations — create an event; the slug becomes the student code. */
export const POST = route(async (req: Request) => {
  const admin = await requireWriter();
  const v = organizationSchema.parse(await readJson(req));

  const [row] = (await sql`
    INSERT INTO organizations (
      slug, name, city, contact_name, contact_phone, event_date, notes,
      question_set_id, is_open, question_count, shuffle_questions, shuffle_options,
      allow_retake, show_score, require_email, collect_class,
      prize_note, created_by
    ) VALUES (
      ${v.slug}, ${v.name}, ${v.city}, ${v.contactName}, ${v.contactPhone},
      ${v.eventDate || null}, ${v.notes},
      ${v.questionSetId}, ${v.isOpen}, ${v.questionCount}, ${v.shuffleQuestions},
      ${v.shuffleOptions}, ${v.allowRetake}, ${v.showScore},
      ${v.requireEmail}, ${v.collectClass},
      ${v.prizeNote || "Winners get exciting gifts from the GarbhaGudi team."},
      ${admin.aid}
    )
    RETURNING *`) as unknown as Record<string, unknown>[];

  await audit(admin, "organization.create", v.slug, { name: v.name });
  return ok({ organization: row }, 201);
});
