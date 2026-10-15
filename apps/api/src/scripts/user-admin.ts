/**
 * Operator tool for account-level security actions that tenant users cannot perform themselves.
 *
 *   pnpm --filter @voice-agent/api user:admin deactivate <email> [reason...]
 *   pnpm --filter @voice-agent/api user:admin reset-mfa   <email> [reason...]
 *
 * Needs DATABASE_ADMIN_URL (the administrative role). Every action is recorded as a security event naming the
 * operator (OPERATOR env var, or the OS user).
 */
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { adminSql, sql } from "../db/client.js";
import { runAsAdmin } from "../db/tenant-context.js";
import { usersRepository } from "../db/repositories/users.repository.js";
import { accountService } from "../auth/account.service.js";

export async function runUserAdmin(args: string[]) {
  const [command, email, ...reasonWords] = args;
  if (!adminSql) throw new Error("DATABASE_ADMIN_URL is required for user:admin");
  if (!command || !email || !["deactivate", "reset-mfa"].includes(command)) {
    throw new Error("Usage: user:admin <deactivate|reset-mfa> <email> [reason...]");
  }
  const operator = process.env.OPERATOR || userInfo().username;
  const reason = reasonWords.join(" ") || undefined;
  return runAsAdmin(async () => {
    const user = await usersRepository.findByEmail({ email });
    if (!user) throw new Error(`No user with email ${email}`);
    if (command === "deactivate") return accountService.deactivate({ userId: user.id, operator, reason });
    await accountService.resetMfa({ userId: user.id, operator, reason });
    return { ok: true };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUserAdmin(process.argv.slice(2))
    .then((r) => console.log("Done.", JSON.stringify(r)))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(async () => {
      await sql.end();
      await adminSql?.end();
    });
}
