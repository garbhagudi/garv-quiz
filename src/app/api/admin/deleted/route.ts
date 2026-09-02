import { sql } from "@/lib/db";
import { ok, fail, route, readJson, requireAdmin, requireWriter, audit } from "@/lib/api";
import {
  restore,
  restoreBlockedReason,
  isSoftDeleteKind,
  KIND_LABEL,
  type SoftDeleteKind,
} from "@/lib/softDelete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/deleted
 *
 * Everything that has been deleted, in one list, newest first - the recycle bin
 * behind the admin panel. Each row carries enough to recognise it, who removed
 * it and when, so the team can decide whether to restore.
 */
export const GET = route(async (req: Request) => {
  await requireAdmin();
  const limit = Math.min(
    500,
    Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 200)),
  );

  const [organizations, participants, attempts, questions, sets, users] = await Promise.all([
    sql`
      SELECT o.id, o.name AS label, o.slug AS detail, o.deleted_at, u.email AS deleted_by,
             (SELECT count(*)::int FROM participants p
               WHERE p.organization_id = o.id AND p.is_deleted = true) AS children
        FROM organizations o
        LEFT JOIN admin_users u ON u.id = o.deleted_by
       WHERE o.is_deleted = true
       ORDER BY o.deleted_at DESC LIMIT ${limit}`,
    sql`
      SELECT p.id, p.name AS label, p.phone AS detail, p.deleted_at, u.email AS deleted_by,
             o.name AS parent, o.is_deleted AS parent_deleted
        FROM participants p
        JOIN organizations o ON o.id = p.organization_id
        LEFT JOIN admin_users u ON u.id = p.deleted_by
       WHERE p.is_deleted = true
       ORDER BY p.deleted_at DESC LIMIT ${limit}`,
    sql`
      SELECT a.id, p.name AS label,
             (a.score || ' / ' || a.max_score) AS detail,
             a.deleted_at, u.email AS deleted_by,
             o.name AS parent, p.is_deleted AS parent_deleted
        FROM attempts a
        JOIN participants p ON p.id = a.participant_id
        JOIN organizations o ON o.id = a.organization_id
        LEFT JOIN admin_users u ON u.id = a.deleted_by
       WHERE a.is_deleted = true
       ORDER BY a.deleted_at DESC LIMIT ${limit}`,
    sql`
      SELECT q.id, q.text AS label, '' AS detail, q.deleted_at, u.email AS deleted_by,
             qs.name AS parent, qs.is_deleted AS parent_deleted
        FROM questions q
        JOIN question_sets qs ON qs.id = q.set_id
        LEFT JOIN admin_users u ON u.id = q.deleted_by
       WHERE q.is_deleted = true
       ORDER BY q.deleted_at DESC LIMIT ${limit}`,
    sql`
      SELECT qs.id, qs.name AS label, qs.description AS detail, qs.deleted_at,
             u.email AS deleted_by,
             (SELECT count(*)::int FROM questions q
               WHERE q.set_id = qs.id AND q.is_deleted = true) AS children
        FROM question_sets qs
        LEFT JOIN admin_users u ON u.id = qs.deleted_by
       WHERE qs.is_deleted = true
       ORDER BY qs.deleted_at DESC LIMIT ${limit}`,
    sql`
      SELECT a.id, a.name AS label, a.email AS detail, a.deleted_at, u.email AS deleted_by
        FROM admin_users a
        LEFT JOIN admin_users u ON u.id = a.deleted_by
       WHERE a.is_deleted = true
       ORDER BY a.deleted_at DESC LIMIT ${limit}`,
  ]);

  return ok({
    deleted: {
      organization: organizations,
      participant: participants,
      attempt: attempts,
      question: questions,
      questionSet: sets,
      adminUser: users,
    },
  });
});

/**
 * POST /api/admin/deleted  { kind, id }
 *
 * Puts a deleted row back, along with whatever was swept up with it. Refuses
 * when something live has taken the code, mobile number or email in the
 * meantime, and says which.
 */
export const POST = route(async (req: Request) => {
  const admin = await requireWriter();
  const body = await readJson(req);

  const kind = body.kind;
  const id = Number(body.id ?? 0);
  if (!isSoftDeleteKind(kind)) return fail("Unknown kind of record.", 400, "kind");
  if (!id) return fail("Which record?", 400, "id");

  const blocked = await restoreBlockedReason(kind as SoftDeleteKind, id);
  if (blocked) return fail(blocked, 409);

  const counts = await restore(kind as SoftDeleteKind, id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return fail("That record is not in the deleted list.", 404);

  await audit(admin, "restore", `${kind}:${id}`, counts);
  return ok({ restored: true, kind, id, counts, label: KIND_LABEL[kind as SoftDeleteKind] });
});
