import { sql } from "@/lib/db";
import { ok, fail, route, readJson, requireWriter, audit } from "@/lib/api";
import { z } from "zod";
import { timeLimitMinutesField } from "@/lib/validate";
import { deleteQuestionSet } from "@/lib/softDelete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().transform((s) => s.trim()).refine((s) => s.length >= 3, "Name the question set."),
  description: z.string().max(500).optional().default(""),
  isArchived: z.boolean().optional().default(false),
  /** Whole-quiz limit in minutes; null means no limit. Stored as seconds. */
  timeLimitMinutes: timeLimitMinutesField.optional().default(null),
});

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const admin = await requireWriter();
  const id = Number((await ctx.params).id);
  const v = patchSchema.parse(await readJson(req));

  const [set] = (await sql`
    UPDATE question_sets
       SET name = ${v.name}, description = ${v.description},
           is_archived = ${v.isArchived},
           time_limit_seconds = ${v.timeLimitMinutes === null ? null : v.timeLimitMinutes * 60},
           updated_at = now()
     WHERE id = ${id} AND is_deleted = false
    RETURNING *`) as unknown as Record<string, unknown>[];
  if (!set) return fail("Question set not found.", 404);

  await audit(admin, "set.update", v.name, { id, timeLimitMinutes: v.timeLimitMinutes });
  return ok({ set });
});

/**
 * DELETE /api/admin/sets/:id
 *
 * Refused while any event still points at the set, because deleting it would
 * silently leave those events with no questions. Archive it instead.
 */
export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  const admin = await requireWriter();
  const id = Number((await ctx.params).id);

  const [{ count: inUse }] = (await sql`
    SELECT count(*)::int AS count FROM organizations
     WHERE question_set_id = ${id} AND is_deleted = false`) as unknown as {
    count: number;
  }[];
  if (inUse > 0)
    return fail(
      `${inUse} event${inUse === 1 ? "" : "s"} still use this set. Point them at another set first, or archive this one.`,
      409,
    );

  const [gone] = (await sql`
    SELECT name FROM question_sets
     WHERE id = ${id} AND is_deleted = false`) as unknown as { name: string }[];
  if (!gone) return fail("Question set not found.", 404);

  const counts = await deleteQuestionSet(id, admin.aid);
  await audit(admin, "set.delete", gone.name, { id, ...counts });
  return ok({ deleted: gone.name, recoverable: true, counts });
});
