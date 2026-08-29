import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { ok, fail, route, readJson, audit } from "@/lib/api";
import { adminLoginSchema } from "@/lib/validate";
import {
  createAdminSession,
  clearAdminSession,
  getAdminSession,
  type Role,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AdminRow = {
  id: number;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  is_active: boolean;
};

/** A hash to compare against when the email is unknown, so both paths cost the
 *  same time and the response can't be used to enumerate valid accounts. */
const DUMMY_HASH = "$2b$12$4SIIASaG3YrXZhWK0D7uruSN8l/WtmML3kJC2btBogMnjDdKQZNHq";

/* ------------------------------- who am I ------------------------------- */

export const GET = route(async () => {
  const s = await getAdminSession();
  if (!s) return fail("Not signed in.", 401);
  return ok({ admin: { id: s.aid, email: s.email, name: s.name, role: s.role } });
});

/* -------------------------------- sign in ------------------------------- */

export const POST = route(async (req: Request) => {
  const input = adminLoginSchema.parse(await readJson(req));

  const [row] = (await sql`
    SELECT id, email, name, role, password_hash, is_active
      FROM admin_users
     WHERE lower(email) = lower(${input.email}) AND is_deleted = false
     LIMIT 1`) as unknown as AdminRow[];

  const valid = await bcrypt.compare(input.password, row?.password_hash ?? DUMMY_HASH);

  if (!row || !valid) return fail("Wrong email or password.", 401);
  if (!row.is_active) return fail("This account has been disabled.", 403);

  await createAdminSession({
    aid: Number(row.id),
    email: row.email,
    name: row.name,
    role: row.role,
  });
  await sql`UPDATE admin_users SET last_login_at = now() WHERE id = ${row.id}`;
  await audit({ aid: Number(row.id), email: row.email, name: row.name, role: row.role }, "signin");

  return ok({ admin: { id: Number(row.id), email: row.email, name: row.name, role: row.role } });
});

/* -------------------------------- sign out ------------------------------ */

export const DELETE = route(async () => {
  await clearAdminSession();
  return ok();
});
