import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { z } from "zod";
import { sql, ConfigError } from "./db";
import { getAdminSession, canWrite, isOwner, type AdminSession } from "./session";
import { firstError } from "./validate";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export const ok = <T extends object>(data: T = {} as T, status = 200) =>
  NextResponse.json({ ok: true, ...data }, { status, headers: NO_STORE });

export const fail = (error: string, status = 400, field?: string) =>
  NextResponse.json({ ok: false, error, ...(field ? { field } : {}) }, { status, headers: NO_STORE });

/** Thrown by the guards below; caught by `route()` and turned into a response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/**
 * Wraps a handler so every route gets the same error contract: validation
 * problems and guard failures become clean JSON, and anything unexpected
 * becomes a 500 without leaking a stack trace to the client.
 */
export function route<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (e) {
      // A misconfigured environment is nobody's typo - report it in full, or
      // whoever has to fix it gets "something went wrong" and no lead to follow.
      if (e instanceof ConfigError) {
        console.error("[config]", e.message);
        return fail(e.message, 503);
      }
      if (e instanceof HttpError) return fail(e.message, e.status, e.field);
      if (e instanceof z.ZodError) {
        const { error, field } = firstError(e);
        return fail(error, 422, field);
      }
      const msg = e instanceof Error ? e.message : String(e);
      // Unique-violation on a slug is a user mistake, not a server fault.
      if (msg.includes("organizations_slug_key")) return fail("That code is already taken.", 409, "slug");
      if (msg.includes("admin_users_email_key")) return fail("That email already has an account.", 409, "email");
      if (msg.includes("participants_organization_email_key"))
        return fail(
          "This email address has already been used for this event.",
          409,
          "email",
        );
      if (msg.includes("participants_organization_phone_key"))
        return fail("This mobile number has already registered for this event.", 409, "phone");
      console.error("[api]", msg);
      return fail("Something went wrong on our side. Please try again.", 500);
    }
  };
}

/* ------------------------------- guards --------------------------------- */

export async function requireAdmin(): Promise<AdminSession> {
  const s = await getAdminSession();
  if (!s) throw new HttpError(401, "Please sign in again.");
  return s;
}

/** Admin session that is also allowed to change data (i.e. not a viewer). */
export async function requireWriter(): Promise<AdminSession> {
  const s = await requireAdmin();
  if (!canWrite(s)) throw new HttpError(403, "Your account has view-only access.");
  return s;
}

export async function requireOwner(): Promise<AdminSession> {
  const s = await requireAdmin();
  if (!isOwner(s)) throw new HttpError(403, "Only the account owner can do this.");
  return s;
}

/* ------------------------------ utilities -------------------------------- */

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Malformed request.");
  }
}

/**
 * A stable, non-reversible fingerprint of the caller's IP. Enough to spot
 * "thirty entries from one phone" without storing anyone's address.
 */
export function ipHash(req: Request): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "";
  if (!ip) return "";
  return createHash("sha256").update(ip + (process.env.SESSION_SECRET ?? "")).digest("hex").slice(0, 32);
}

export async function audit(
  admin: AdminSession,
  action: string,
  target = "",
  detail: Record<string, unknown> = {},
) {
  try {
    await sql`
      INSERT INTO audit_log (admin_id, admin_email, action, target, detail)
      VALUES (${admin.aid}, ${admin.email}, ${action}, ${target}, ${JSON.stringify(detail)}::jsonb)`;
  } catch (e) {
    // Never let a bookkeeping failure break the action the user asked for.
    console.error("[audit]", e);
  }
}
