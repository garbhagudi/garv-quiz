import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import type { Role } from "./types";

export type { Role };

let cachedSecret: Uint8Array | null = null;

/** Read lazily so a missing secret fails the request, not the build. */
function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32)
    throw new Error(
      "SESSION_SECRET is missing or shorter than 32 characters. Generate one with:\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

export const ADMIN_COOKIE = "gg_admin";
export const PARTICIPANT_COOKIE = "gg_participant";

const ADMIN_TTL = "12h";
const PARTICIPANT_TTL = "30d";

export type AdminSession = { aid: number; email: string; name: string; role: Role };
export type ParticipantSession = { pid: number; sid: number; name: string };

async function sign(payload: Record<string, unknown>, ttl: string) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(getSecret());
}

async function read<T>(name: string): Promise<T | null> {
  const jar = await cookies();
  const token = jar.get(name)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    return payload as T;
  } catch {
    // Expired, tampered with, or signed under an older SESSION_SECRET.
    return null;
  }
}

const cookieOptions = (maxAge: number) =>
  ({
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  });

/* ------------------------------- admin ---------------------------------- */

export async function createAdminSession(s: AdminSession) {
  const token = await sign(s, ADMIN_TTL);
  (await cookies()).set(ADMIN_COOKIE, token, cookieOptions(60 * 60 * 12));
}

export const getAdminSession = () => read<AdminSession>(ADMIN_COOKIE);

export async function clearAdminSession() {
  (await cookies()).delete(ADMIN_COOKIE);
}

/* ---------------------------- participant ------------------------------- */

export async function createParticipantSession(s: ParticipantSession) {
  const token = await sign(s, PARTICIPANT_TTL);
  (await cookies()).set(PARTICIPANT_COOKIE, token, cookieOptions(60 * 60 * 24 * 30));
}

export const getParticipantSession = () => read<ParticipantSession>(PARTICIPANT_COOKIE);

export async function clearParticipantSession() {
  (await cookies()).delete(PARTICIPANT_COOKIE);
}

/** A viewer may read everything but change nothing. */
export const canWrite = (s: AdminSession | null) =>
  !!s && (s.role === "owner" || s.role === "admin");

export const isOwner = (s: AdminSession | null) => !!s && s.role === "owner";
