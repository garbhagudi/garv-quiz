import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { ok, route, readJson, requireAdmin, requireOwner, audit } from "@/lib/api";
import { adminUserSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/users — the staff list. Password hashes never leave the server. */
export const GET = route(async (req: Request) => {
  await requireAdmin();
  const includeDeleted = new URL(req.url).searchParams.get("deleted") === "1";
  const users = await sql`
    SELECT id, email, name, role, is_active, created_at, last_login_at,
           is_deleted, deleted_at
      FROM admin_users
     WHERE ${includeDeleted} OR is_deleted = false
     ORDER BY is_deleted ASC,
              CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name ASC`;
  return ok({ users });
});

/** POST /api/admin/users — invite a colleague. Owner only. */
export const POST = route(async (req: Request) => {
  const admin = await requireOwner();
  const v = adminUserSchema.parse(await readJson(req));

  const hash = await bcrypt.hash(v.password, 12);
  const [user] = (await sql`
    INSERT INTO admin_users (email, password_hash, name, role)
    VALUES (${v.email}, ${hash}, ${v.name}, ${v.role})
    RETURNING id, email, name, role, is_active, created_at, last_login_at`) as unknown as Record<
    string,
    unknown
  >[];

  await audit(admin, "user.create", v.email, { role: v.role });
  return ok({ user }, 201);
});
