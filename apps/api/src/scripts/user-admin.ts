/**
 * Operator tool for account-level security actions that tenant users cannot perform themselves.
 *
 *   pnpm --filter @voice-agent/api user:admin deactivate     <email> [reason...]
 *   pnpm --filter @voice-agent/api user:admin reset-mfa      <email> [reason...]
 *   NEW_PASSWORD='<the new password>' \
 *     pnpm --filter @voice-agent/api user:admin reset-password <email> [reason...]
 *
 * Needs DATABASE_ADMIN_URL (the administrative role). Every action is recorded as a security event naming the
 * operator (OPERATOR env var, or the OS user).
 *
 * reset-password is the lock-out remedy: the account keeps its email, role and MFA factor and only its password
 * changes. The password is read from the environment (never an argument, so it stays out of shell history) and is
 * never printed or logged. It must pass the SAME policy as a self-service change (auth/password-policy.ts) and is
 * hashed with the application's own hasher (auth/password.ts), so no second credential format can appear in the
 * users table. Setting it ends EVERY session of the account in the same transaction (see RESET-PASSWORD below).
 */
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { adminSql, sql } from "../db/client.js";
import { runAsAdmin } from "../db/tenant-context.js";
import { usersRepository } from "../db/repositories/users.repository.js";
import { accountService } from "../auth/account.service.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { checkPassword, PASSWORD_PROBLEM_MESSAGE } from "../auth/password-policy.js";
import { securityEvents } from "../security/security-events.js";

const COMMANDS = ["deactivate", "reset-mfa", "reset-password"] as const;
export type UserAdminCommand = (typeof COMMANDS)[number];

const USAGE = `Usage: user:admin <${COMMANDS.join("|")}> <email> [reason...]   (reset-password also needs NEW_PASSWORD)`;

/**
 * RESET-PASSWORD, and why it revokes every session.
 *
 * A password reset that leaves live sessions alone is not a reset: whoever holds a stolen session cookie keeps the
 * account until that cookie expires, which is exactly the situation the reset is meant to end. The application's own
 * change-password route already ends ALL sessions (modules/auth/account-security.routes.ts, keepSessionId: null) and
 * both existing operator actions here (deactivate, reset-mfa) do the same, so this is the house rule, not a new one.
 * An operator reset has no session of its own to keep, so nothing is spared: the user signs in again with the new
 * password (and their second factor, which this does not touch).
 *
 * It is done by the repository's single transaction (changePasswordRevokingSessions), so there is no instant at which
 * the old password is already gone but old cookies still work - and it writes password_changed_at in the same
 * statement.
 */
async function resetPassword(params: {
  user: { id: string; email: string; name: string; passwordHash: string; isActive: boolean };
  newPassword: string;
  operator: string;
  reason?: string;
}) {
  const { user, newPassword, operator, reason } = params;
  const problem = await checkPassword({ password: newPassword, email: user.email, name: user.name });
  if (problem) {
    await securityEvents.record({
      type: "auth.password.rejected",
      outcome: "denied",
      userId: user.id,
      metadata: { operator, reason: reason ?? null, byOperator: true, problem },
    });
    throw new Error(`${PASSWORD_PROBLEM_MESSAGE[problem]} (policy: ${problem})`);
  }
  // Re-setting the password the account already has would revoke sessions while leaving the credential unchanged.
  if (await verifyPassword(newPassword, user.passwordHash)) {
    throw new Error("NEW_PASSWORD is the password this account already has; choose a different one");
  }

  const sessionsRevoked = await usersRepository.changePasswordRevokingSessions({
    id: user.id,
    passwordHash: await hashPassword(newPassword),
    keepSessionId: null, // an operator reset keeps no session: every device signs in again
  });
  await securityEvents.record({
    // There is no dedicated "reset_by_operator" password event type yet; the operator is named in the metadata, as
    // the other subcommands do. The account timeline therefore shows every password change in one place.
    type: "auth.password.changed",
    outcome: "success",
    userId: user.id,
    metadata: { operator, reason: reason ?? null, byOperator: true, sessionsRevoked },
  });
  // The account can still be deactivated: say so, because the new password alone will not let anyone in.
  return { sessionsRevoked, accountActive: user.isActive };
}

export async function runUserAdmin(args: string[], opts: { newPassword?: string } = {}) {
  const [command, email, ...reasonWords] = args;
  if (!adminSql) throw new Error("DATABASE_ADMIN_URL is required for user:admin");
  if (!command || !email || !(COMMANDS as readonly string[]).includes(command)) throw new Error(USAGE);
  const operator = process.env.OPERATOR || userInfo().username;
  const reason = reasonWords.join(" ") || undefined;
  const newPassword = opts.newPassword ?? process.env.NEW_PASSWORD;
  if (command === "reset-password" && !newPassword) {
    throw new Error("NEW_PASSWORD is required for reset-password (pass it in the environment, never as an argument)");
  }
  return runAsAdmin(async () => {
    const user = await usersRepository.findByEmail({ email });
    if (!user) throw new Error(`No user with email ${email}`);
    if (command === "deactivate") return accountService.deactivate({ userId: user.id, operator, reason });
    if (command === "reset-password") return resetPassword({ user, newPassword: newPassword!, operator, reason });
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
