/**
 * PostgreSQL error inspection that works whether the driver error is raw (postgres.js) or wrapped by the ORM
 * (drizzle-orm >= 0.44 wraps it as DrizzleQueryError with the original on `cause`).
 */
interface PgLike {
  code?: unknown;
  message?: unknown;
  constraint_name?: unknown;
  cause?: unknown;
}

function chain(err: unknown): PgLike[] {
  const out: PgLike[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    out.push(cur as PgLike);
    cur = (cur as PgLike).cause;
  }
  return out;
}

/** The SQLSTATE of the underlying PostgreSQL error, if there is one (e.g. "23505" unique violation). */
export function pgErrorCode(err: unknown): string | undefined {
  for (const e of chain(err)) if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  return undefined;
}

/** The underlying PostgreSQL error message(s), joined: for diagnostics and tests. */
export function pgErrorMessage(err: unknown): string {
  return chain(err)
    .map((e) => (typeof e.message === "string" ? e.message : ""))
    .join(" | ");
}

export const isUniqueViolation = (err: unknown) => pgErrorCode(err) === "23505";
export const isForeignKeyViolation = (err: unknown) => pgErrorCode(err) === "23503";
