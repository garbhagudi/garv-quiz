import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * Gate on /admin/* so an unauthenticated visitor is bounced to the sign-in page
 * before any page code or query runs. The API routes verify the session again
 * on their own - this is the friendly redirect, not the security boundary.
 */
const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? "");

const PUBLIC_ADMIN_PATHS = ["/admin/login"];

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (PUBLIC_ADMIN_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/")))
    return NextResponse.next();

  const token = req.cookies.get("gg_admin")?.value;
  let valid = false;
  if (token && secret.length) {
    try {
      await jwtVerify(token, secret, { algorithms: ["HS256"] });
      valid = true;
    } catch {
      valid = false; // expired, tampered with, or signed under an older secret
    }
  }

  if (valid) return NextResponse.next();

  const login = new URL("/admin/login", req.url);
  // Remember where they were headed so sign-in can send them back.
  if (pathname !== "/admin") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Only the admin pages. API routes and the student-facing app are untouched.
  matcher: ["/admin", "/admin/((?!login).*)"],
};
