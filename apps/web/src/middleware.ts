import { NextResponse, type NextRequest } from "next/server";

/**
 * Protects every dashboard route. A visitor must hold a session cookie that
 * the API confirms is still valid; otherwise they are sent to /login. The API
 * remains the source of truth (and enforces login on every endpoint itself) —
 * this only keeps people from seeing empty/error pages.
 */
const API = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
const COOKIE = process.env.SESSION_COOKIE_NAME ?? "va_session";

/**
 * Sends the visitor to /login. NextResponse.redirect() runs the target through NextURL, which rewrites a loopback IP
 * host (127.0.0.1) to "localhost": the browser then lands on a different origin, loses the host-only session cookie
 * and is refused by the API CORS list (the sign-in page cannot tell it is half-way through two-step verification).
 * So when the app is opened at 127.0.0.1 the login page is served in place (rewrite, same origin) instead.
 */
function toLogin(req: NextRequest, pathname: string, search: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  const host = (req.headers.get("host") ?? "").split(":")[0];
  return host === "127.0.0.1" ? NextResponse.rewrite(url) : NextResponse.redirect(url);
}

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
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { data?: { security?: { mfaPending?: boolean } } } | null;
        if (!body?.data?.security?.mfaPending) return NextResponse.next();
        // Password accepted but the second factor is still pending: finish it on the sign-in page.
        return toLogin(req, pathname, search);
      }
    } catch {
      // API unreachable: fall through to the login page, which explains it.
    }
  }

  const res = toLogin(req, pathname, search);
  if (token) res.cookies.delete(COOKIE);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
