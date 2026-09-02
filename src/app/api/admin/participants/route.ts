import { sql } from "@/lib/db";
import { ok, route, requireAdmin, requireWriter, audit, fail } from "@/lib/api";
import { deleteParticipant } from "@/lib/softDelete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 100;

/**
 * GET /api/admin/participants?q=&organizationId=&page=0
 *
 * The people database: everyone who has ever registered, across every event,
 * searchable by name, mobile or email. This is the contact list the team came
 * for, so it is admin-only and never cached.
 */
export const GET = route(async (req: Request) => {
  await requireAdmin();
  const params = new URL(req.url).searchParams;
  const includeDeleted = params.get("deleted") === "1";
  const q = (params.get("q") ?? "").trim();
  const like = `%${q}%`;
  const organizationId = Number(params.get("organizationId") ?? 0) || null;
  const page = Math.max(0, Number(params.get("page") ?? 0) || 0);

  const rows = await sql`
    SELECT p.id, p.name, p.phone, p.email, p.class_or_year, p.created_at,
           p.is_deleted, p.deleted_at,
           s.id AS organization_id, s.name AS organization_name, s.slug AS organization_slug,
           s.is_deleted AS organization_deleted,
           (SELECT count(*)::int FROM attempts a
             WHERE a.participant_id = p.id AND a.status = 'completed'
               AND a.is_deleted = false)                                AS attempts,
           (SELECT max(a.score) FROM attempts a
             WHERE a.participant_id = p.id AND a.status = 'completed'
               AND a.is_deleted = false)                                AS best_score,
           (SELECT max(a.max_score) FROM attempts a
             WHERE a.participant_id = p.id AND a.status = 'completed'
               AND a.is_deleted = false)                                AS out_of,
           (SELECT max(a.submitted_at) FROM attempts a
             WHERE a.participant_id = p.id AND a.status = 'completed'
               AND a.is_deleted = false)                                AS last_played
      FROM participants p
      JOIN organizations s ON s.id = p.organization_id
     WHERE (p.name ILIKE ${like} OR p.phone ILIKE ${like} OR p.email ILIKE ${like})
       AND (${organizationId}::bigint IS NULL OR p.organization_id = ${organizationId}::bigint)
       AND (${includeDeleted} OR (p.is_deleted = false AND s.is_deleted = false))
     ORDER BY p.is_deleted ASC, p.created_at DESC
     LIMIT ${PAGE} OFFSET ${page * PAGE}`;

  const [{ count }] = (await sql`
    SELECT count(*)::int AS count
      FROM participants p
      JOIN organizations s ON s.id = p.organization_id
     WHERE (p.name ILIKE ${like} OR p.phone ILIKE ${like} OR p.email ILIKE ${like})
       AND (${organizationId}::bigint IS NULL OR p.organization_id = ${organizationId}::bigint)
       AND (${includeDeleted} OR (p.is_deleted = false AND s.is_deleted = false))`) as unknown as {
    count: number;
  }[];

  return ok({ participants: rows, total: count, page, pageSize: PAGE });
});

/** DELETE /api/admin/participants?id=123 - remove a person and all their attempts. */
export const DELETE = route(async (req: Request) => {
  const admin = await requireWriter();
  const id = Number(new URL(req.url).searchParams.get("id") ?? 0);
  if (!id) return fail("Which participant?", 400, "id");

  const [gone] = (await sql`
    SELECT name, phone, organization_id FROM participants
     WHERE id = ${id} AND is_deleted = false`) as unknown as {
    name: string;
    phone: string;
    organization_id: number;
  }[];
  if (!gone) return fail("Participant not found.", 404);

  const counts = await deleteParticipant(id, admin.aid);
  await audit(admin, "participant.delete", gone.phone, {
    name: gone.name,
    organizationId: gone.organization_id,
    ...counts,
  });
  return ok({ deleted: true, recoverable: true, counts });
});
