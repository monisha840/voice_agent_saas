import { cookies } from "next/headers";
import { createApi } from "./api";

/**
 * Headers every server-side API call carries: the visitor's session cookie, so the API sees the logged-in user.
 *
 * Deliberately NOT forwarded: the visitor's address (X-Forwarded-For). The API's public-access guard treats any request
 * carrying X-Forwarded-* as coming from the public internet and serves it only /health and the Exotel endpoints, so
 * forwarding it here would 404 the whole dashboard. Per-user and per-organization budgets (API rate limiter) keep
 * users behind this server from sharing one budget instead. See docs/security/rate-limiting.md.
 *
 * Import this module (not ./api) in server code.
 */
export async function serverHeaders(): Promise<Record<string, string>> {
  // Next 15: request APIs are asynchronous.
  const cookie = (await cookies()).toString();
  return cookie ? { cookie } : {};
}

export const api = createApi(serverHeaders);

export { ApiError } from "./api";
