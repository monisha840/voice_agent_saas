import { NextResponse, type NextRequest } from "next/server";

/**
 * Protects every dashboard route. A visitor must hold a session cookie that
 * the API confirms is still valid; otherwise they are sent to /login. The API
 * remains the source of truth (and enforces login on every endpoint itself) —
 * this only keeps people from seeing empty/error pages.
 */
const API = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
const COOKIE = process.env.SESSION_COOKIE_NAME ?? "va_session";

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname === "/login" || pathname === "/accept-invite") return NextResponse.next();

  const token = req.cookies.get(COOKIE)?.value;
  if (token) {
    try {
      const res = await fetch(`${API}/api/auth/me`, {
        headers: { cookie: `${COOKIE}=${token}` },
        cache: "no-store",
      });
      if (res.ok) return NextResponse.next();
    } catch {
      // API unreachable: fall through to the login page, which explains it.
    }
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  const res = NextResponse.redirect(url);
  if (token) res.cookies.delete(COOKIE);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
