/**
 * Gives the restricted runtime role (created NOLOGIN by migration 0012) a login and a password, out of band.
 *
 *   DATABASE_ADMIN_URL=postgresql://owner:...@host/db VOICE_APP_PASSWORD='<long random>' \
 *     pnpm --filter @voice-agent/api db:provision-runtime-role
 *
 * The password is read from the environment (never an argument, never printed) and applied with a parameterised
 * ALTER ROLE through quote_literal, so it cannot be used to inject SQL. Re-running rotates the password.
 */
import { pathToFileURL } from "node:url";
import { adminSql, sql } from "../db/client.js";

export async function provisionRuntimeRole(password: string | undefined) {
  if (!adminSql) throw new Error("DATABASE_ADMIN_URL is required (the owner/migration role)");
  if (!password || password.length < 24) throw new Error("VOICE_APP_PASSWORD must be set and at least 24 characters");
  const exists = await adminSql`select 1 from pg_roles where rolname = 'voice_app'`;
  if (exists.length === 0) throw new Error("Role voice_app does not exist: run the migrations first (pnpm db:migrate)");
  const [{ literal }] = await adminSql`select quote_literal(${password}) as literal`;
  await adminSql.unsafe(`ALTER ROLE voice_app LOGIN PASSWORD ${literal}`);
  await adminSql.unsafe(`ALTER ROLE voice_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provisionRuntimeRole(process.env.VOICE_APP_PASSWORD)
    .then(() => console.log("voice_app now has a login. Set DATABASE_URL to connect as voice_app; keep DATABASE_ADMIN_URL for operator scripts only."))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(async () => {
      await sql.end();
      await adminSql?.end();
    });
}
