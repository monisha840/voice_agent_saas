import { cookies } from "next/headers";
import { createApi } from "./api";

/**
 * API client for server components. Forwards the visitor's session cookie so
 * the API sees the logged-in user. Import this (not ./api) in server code.
 */
export const api = createApi(() => {
  const cookie = cookies().toString();
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return headers;
});

export { ApiError } from "./api";
