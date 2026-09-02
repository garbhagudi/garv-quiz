import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { ok, fail, route, readJson, requireOwner, audit } from "@/lib/api";
import { z } from "zod";
import { deleteAdminUser } from "@/lib/softDelete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 3, "Enter a name.")
    .optional(),
  role: z.enum(["owner", "admin", "viewer"]).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(10, "Use at least 10 characters.").max(200).optional(),
});

/** How many owners are left, so the last one can't lock everyone out. */
async function activeOwners(excludeId?: number) {
  const [{ count }] = (await sql`
    SELECT count(*)::int AS count FROM admin_users
     WHERE role = 'owner' AND is_active = true AND is_deleted = false
       AND (${excludeId ?? null}::bigint IS NULL OR id <> ${excludeId ?? null}::bigint)`) as unknown as {
    count: number;
  }[];
  return count;
}

/** PATCH /api/admin/users/:id - rename, change role, disable, or reset a password. */
export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const admin = await requireOwner();
  const id = Number((await ctx.params).id);
  const v = patchSchema.parse(await readJson(req));

  const [target] = (await sql`
    SELECT id, email, name, role, is_active FROM admin_users
     WHERE id = ${id} AND is_deleted = false LIMIT 1`) as unknown as {
    id: number;
    email: string;
    name: string;
    role: string;
    is_active: boolean;
  }[];
  if (!target) return fail("Account not found.", 404);

  // Guard the last way in: demoting or disabling the only active owner is refused.
  const losingOwner =
    target.role === "owner" &&
    ((v.role && v.role !== "owner") || v.isActive === false);
  if (losingOwner && (await activeOwners(id)) === 0)
    return fail("This is the only owner account. Make someone else an owner first.", 409);

  const hash = v.password ? await bcrypt.hash(v.password, 12) : null;

  const [user] = (await sql`
    UPDATE admin_users SET
      name          = COALESCE(${v.name ?? null}, name),
      role          = COALESCE(${v.role ?? null}, role),
      is_active     = COALESCE(${v.isActive ?? null}, is_active),
      password_hash = COALESCE(${hash}, password_hash)
    WHERE id = ${id}
    RETURNING id, email, name, role, is_active, created_at, last_login_at`) as unknown as Record<
    string,
    unknown
  >[];

  await audit(admin, "user.update", target.email, {
    role: v.role,
    isActive: v.isActive,
    passwordReset: !!v.password,
  });
  return ok({ user });
});

/** DELETE /api/admin/users/:id - remove a staff account. */
export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  const admin = await requireOwner();
  const id = Number((await ctx.params).id);

  if (id === admin.aid) return fail("You cannot delete the account you are signed in with.", 409);

  const [target] = (await sql`
    SELECT email, role FROM admin_users
     WHERE id = ${id} AND is_deleted = false LIMIT 1`) as unknown as {
    email: string;
    role: string;
  }[];
  if (!target) return fail("Account not found.", 404);
  if (target.role === "owner" && (await activeOwners(id)) === 0)
    return fail("This is the only owner account and cannot be deleted.", 409);

  await deleteAdminUser(id, admin.aid);
  await audit(admin, "user.delete", target.email, {});
  return ok({ deleted: true, recoverable: true });
});
