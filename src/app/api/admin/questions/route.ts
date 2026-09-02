import { sql } from "@/lib/db";
import { ok, fail, route, readJson, requireAdmin, requireWriter, audit } from "@/lib/api";
import { questionSchema, answerKeyOf } from "@/lib/validate";
import { flattenQuestionText } from "@/lib/questionText";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/questions?setId=1
 *
 * The admin panel is the only place that ever sees `correct_index`. Everything
 * facing a student goes through /api/quiz/start, which strips it.
 */
export const GET = route(async (req: Request) => {
  await requireAdmin();
  const params = new URL(req.url).searchParams;
  const includeDeleted = params.get("deleted") === "1";
  const setId = Number(params.get("setId") ?? 0);
  if (!setId) return fail("Which question set?", 400, "setId");

  const questions = await sql`
    SELECT q.*,
           (SELECT count(*)::int FROM answers a WHERE a.question_id = q.id)                 AS times_asked,
           (SELECT count(*)::int FROM answers a WHERE a.question_id = q.id AND a.is_correct) AS times_right
      FROM questions q
     WHERE q.set_id = ${setId}
       AND (${includeDeleted} OR q.is_deleted = false)
     ORDER BY q.is_deleted ASC, q.position ASC, q.id ASC`;

  return ok({ questions });
});

/** POST /api/admin/questions - add a question to the end of a set. */
export const POST = route(async (req: Request) => {
  const admin = await requireWriter();
  const v = questionSchema.parse(await readJson(req));
  // `correct_index` stays in step with the first correct option, so the older
  // CHECK on it and anything still reading it both keep working.
  const key = answerKeyOf(v);

  const [{ next }] = (await sql`
    SELECT COALESCE(max(position) + 1, 0)::int AS next
      FROM questions
     WHERE set_id = ${v.setId} AND is_deleted = false`) as unknown as { next: number }[];

  const [q] = (await sql`
    INSERT INTO questions (
      set_id, position, text, options, correct_index, correct_indexes,
      image_url, image_alt, explanation, points, is_active
    )
    VALUES (${v.setId}, ${v.position ?? next}, ${v.text},
            ${JSON.stringify(v.options)}::jsonb, ${key[0]},
            ${JSON.stringify(key)}::jsonb,
            ${v.imageUrl}, ${v.imageAlt},
            ${v.explanation}, ${v.points}, ${v.isActive})
    RETURNING *`) as unknown as Record<string, unknown>[];

  // The wording can run to several lines; the log wants one.
  await audit(admin, "question.create", flattenQuestionText(v.text).slice(0, 60), {
    setId: v.setId,
    correctIndexes: key,
    hasImage: v.imageUrl !== "",
  });
  return ok({ question: q }, 201);
});

const reorderSchema = z.object({
  setId: z.coerce.number().int().positive(),
  order: z.array(z.coerce.number().int().positive()).min(1),
});

/** PUT /api/admin/questions - save a new question order for one set. */
export const PUT = route(async (req: Request) => {
  const admin = await requireWriter();
  const v = reorderSchema.parse(await readJson(req));

  // One statement: expand the id list to (id, index) pairs and join on it, so
  // there is no window where the set is half-reordered.
  await sql`
    UPDATE questions q
       SET position = t.pos, updated_at = now()
      FROM (
        SELECT (value)::bigint AS id, (ordinality - 1)::int AS pos
          FROM jsonb_array_elements_text(${JSON.stringify(v.order)}::jsonb)
               WITH ORDINALITY AS x(value, ordinality)
      ) t
     WHERE q.id = t.id AND q.set_id = ${v.setId} AND q.is_deleted = false`;

  await audit(admin, "question.reorder", String(v.setId), { count: v.order.length });
  return ok({ reordered: v.order.length });
});
