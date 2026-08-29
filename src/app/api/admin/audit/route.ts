import { sql } from "@/lib/db";
import { ok, route, requireAdmin } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/audit — recent staff actions, so a shared login is still traceable. */
export const GET = route(async (req: Request) => {
  await requireAdmin();
  const limit = Math.min(300, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 100)));

  const entries = await sql`
    SELECT id, admin_email, action, target, detail, created_at
      FROM audit_log
     ORDER BY created_at DESC
     LIMIT ${limit}`;

  return ok({ entries });
});
