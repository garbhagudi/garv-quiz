import { sql } from "@/lib/db";
import { ok, route, readJson, requireAdmin, requireWriter, audit } from "@/lib/api";
import { z } from "zod";
import { timeLimitMinutesField } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const setSchema = z.object({
  name: z.string().transform((s) => s.trim()).refine((s) => s.length >= 3, "Name the question set."),
  description: z.string().max(500).optional().default(""),
  isArchived: z.boolean().optional().default(false),
  /** Whole-quiz limit in minutes; null means no limit. Stored as seconds. */
  timeLimitMinutes: timeLimitMinutesField.optional().default(null),
});

/** Minutes as the form sends them, to the seconds the column holds. */
const toSeconds = (m: number | null) => (m === null ? null : m * 60);

/** GET /api/admin/sets — question sets with how many questions and events use each. */
export const GET = route(async (req: Request) => {
  await requireAdmin();
  const includeDeleted = new URL(req.url).searchParams.get("deleted") === "1";
  const sets = await sql`
    SELECT qs.*,
           (SELECT count(*)::int FROM questions q
             WHERE q.set_id = qs.id AND q.is_deleted = false)  AS question_count,
           (SELECT count(*)::int FROM questions q
             WHERE q.set_id = qs.id AND q.is_active
               AND q.is_deleted = false)                       AS active_count,
           (SELECT count(*)::int FROM organizations s
             WHERE s.question_set_id = qs.id
               AND s.is_deleted = false)                       AS organization_count
      FROM question_sets qs
     WHERE ${includeDeleted} OR qs.is_deleted = false
     ORDER BY qs.is_deleted ASC, qs.is_archived ASC, qs.created_at ASC`;
  return ok({ sets });
});

/** POST /api/admin/sets — create a set, optionally copying an existing one. */
export const POST = route(async (req: Request) => {
  const admin = await requireWriter();
  const body = await readJson(req);
  const v = setSchema.parse(body);
  const copyFrom = Number(body.copyFrom ?? 0) || null;

  const [set] = (await sql`
    INSERT INTO question_sets (name, description, time_limit_seconds)
    VALUES (${v.name}, ${v.description}, ${toSeconds(v.timeLimitMinutes)})
    RETURNING *`) as unknown as { id: number }[];

  if (copyFrom) {
    await sql`
      INSERT INTO questions (
        set_id, position, text, options, correct_index, correct_indexes,
        image_url, image_alt, explanation, points, is_active
      )
      SELECT ${set.id}, position, text, options, correct_index, correct_indexes,
             image_url, image_alt, explanation, points, is_active
        FROM questions WHERE set_id = ${copyFrom} AND is_deleted = false
       ORDER BY position ASC, id ASC`;
  }

  await audit(admin, "set.create", v.name, {
    id: set.id,
    copiedFrom: copyFrom,
    timeLimitMinutes: v.timeLimitMinutes,
  });
  return ok({ set }, 201);
});
