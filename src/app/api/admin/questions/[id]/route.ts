import { sql } from "@/lib/db";
import { ok, fail, route, readJson, requireWriter, audit } from "@/lib/api";
import { questionSchema, answerKeyOf } from "@/lib/validate";
import { flattenQuestionText } from "@/lib/questionText";
import { deleteQuestion } from "@/lib/softDelete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/admin/questions/:id
 *
 * Editing a question does not change how already-submitted quizzes were marked:
 * each attempt stores its own snapshot of the questions it showed.
 */
export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const admin = await requireWriter();
  const id = Number((await ctx.params).id);
  const v = questionSchema.parse(await readJson(req));
  const key = answerKeyOf(v);

  const [q] = (await sql`
    UPDATE questions SET
      set_id          = ${v.setId},
      text            = ${v.text},
      options         = ${JSON.stringify(v.options)}::jsonb,
      correct_index   = ${key[0]},
      correct_indexes = ${JSON.stringify(key)}::jsonb,
      image_url       = ${v.imageUrl},
      image_alt       = ${v.imageAlt},
      explanation     = ${v.explanation},
      points          = ${v.points},
      is_active       = ${v.isActive},
      position        = COALESCE(${v.position ?? null}, position),
      updated_at      = now()
    WHERE id = ${id} AND is_deleted = false
    RETURNING *`) as unknown as Record<string, unknown>[];

  if (!q) return fail("Question not found.", 404);
  await audit(admin, "question.update", flattenQuestionText(v.text).slice(0, 60), {
    id,
    correctIndexes: key,
    hasImage: v.imageUrl !== "",
  });
  return ok({ question: q });
});

/**
 * DELETE /api/admin/questions/:id
 *
 * Past answers keep their text snapshot, so old reports still read correctly -
 * only the reusable question goes away.
 */
export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  const admin = await requireWriter();
  const id = Number((await ctx.params).id);

  const [gone] = (await sql`
    SELECT text, set_id FROM questions
     WHERE id = ${id} AND is_deleted = false`) as unknown as {
    text: string;
    set_id: number;
  }[];
  if (!gone) return fail("Question not found.", 404);

  await deleteQuestion(id, admin.aid);

  // Close the gap left in the ordering so positions stay 0..n-1.
  await sql`
    WITH renumbered AS (
      SELECT id, (ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) - 1)::int AS pos
        FROM questions WHERE set_id = ${gone.set_id} AND is_deleted = false
    )
    UPDATE questions q SET position = r.pos
      FROM renumbered r WHERE q.id = r.id AND q.position <> r.pos`;

  await audit(admin, "question.delete", flattenQuestionText(gone.text).slice(0, 60), { id });
  return ok({ deleted: true, recoverable: true });
});
