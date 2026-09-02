import { sql } from "@/lib/db";
import { ok, fail, route, requireAdmin, requireWriter, audit } from "@/lib/api";
import { deleteAttempt } from "@/lib/softDelete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/admin/attempts/:id - one student's full answer sheet. */
export const GET = route(async (_req: Request, ctx: Ctx) => {
  await requireAdmin();
  const id = Number((await ctx.params).id);

  const [attempt] = (await sql`
    SELECT a.id, a.public_id, a.status, a.score, a.max_score, a.correct_count,
           a.question_count, a.answer_ms, a.elapsed_ms, a.started_at, a.submitted_at,
           a.user_agent, a.ip_hash,
           p.name, p.phone, p.email, p.class_or_year,
           s.name AS organization_name, s.slug AS organization_slug, s.id AS organization_id
      FROM attempts a
      JOIN participants p ON p.id = a.participant_id
      JOIN organizations s      ON s.id = a.organization_id
     WHERE a.id = ${id} AND a.is_deleted = false
     LIMIT 1`) as unknown as Record<string, unknown>[];

  if (!attempt) return fail("Attempt not found.", 404);

  const answers = await sql`
    SELECT position, question_text, chosen_text, correct_text, is_correct, points, ms
      FROM answers WHERE attempt_id = ${id} ORDER BY position ASC`;

  return ok({ attempt, answers });
});

/** DELETE /api/admin/attempts/:id - remove a test run or a duplicate entry. */
export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  const admin = await requireWriter();
  const id = Number((await ctx.params).id);

  const [row] = (await sql`
    SELECT participant_id, organization_id, score FROM attempts
     WHERE id = ${id} AND is_deleted = false`) as unknown as {
    participant_id: number;
    organization_id: number;
    score: number;
  }[];
  if (!row) return fail("Attempt not found.", 404);

  await deleteAttempt(id, admin.aid);
  await audit(admin, "attempt.delete", String(id), row);
  return ok({ deleted: true, recoverable: true });
});
