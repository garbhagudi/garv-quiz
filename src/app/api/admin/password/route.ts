import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { ok, fail, route, readJson, requireAdmin, audit } from "@/lib/api";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: z.string().min(10, "Use at least 10 characters."),
});

/**
 * POST /api/admin/password — change your own password.
 * Available to every role, including viewers, and always requires the old one.
 */
export const POST = route(async (req: Request) => {
  const admin = await requireAdmin();
  const v = schema.parse(await readJson(req));

  const [row] = (await sql`
    SELECT password_hash FROM admin_users
     WHERE id = ${admin.aid} AND is_deleted = false LIMIT 1`) as unknown as {
    password_hash: string;
  }[];
  if (!row) return fail("Account not found.", 404);

  if (!(await bcrypt.compare(v.currentPassword, row.password_hash)))
    return fail("That is not your current password.", 401, "currentPassword");

  if (await bcrypt.compare(v.newPassword, row.password_hash))
    return fail("The new password must be different.", 400, "newPassword");

  const hash = await bcrypt.hash(v.newPassword, 12);
  await sql`UPDATE admin_users SET password_hash = ${hash} WHERE id = ${admin.aid}`;
  await audit(admin, "password.change", admin.email, {});

  return ok({ changed: true });
});
