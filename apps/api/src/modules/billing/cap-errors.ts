/**
 * Turns the database's plan-cap violations (migration 0020: SQLSTATE VA010 agents, VA011 team) into a LimitExceededError
 * with a stable code and a safe, human message. The raw driver error (which echoes the failed statement) is never shown.
 */
import { pgErrorCode, pgErrorMessage } from "../../db/pg-error.js";
import { LimitExceededError } from "../../shared/errors.js";

export function translatePlanCapError(err: unknown): LimitExceededError | null {
  const code = pgErrorCode(err);
  if (code !== "VA010" && code !== "VA011") return null;
  const cap = /plan_limit:(?:agents|team):(\d+)/.exec(pgErrorMessage(err))?.[1];
  if (code === "VA010") {
    return new LimitExceededError(
      `Your plan allows ${cap ?? "a limited number of"} active agents. Archive an agent or upgrade your plan in Billing.`,
      "AGENT_LIMIT_REACHED",
    );
  }
  return new LimitExceededError(
    `Your plan allows ${cap ?? "a limited number of"} team members, including pending invitations. Remove a member or invitation, or upgrade your plan in Billing.`,
    "TEAM_MEMBER_LIMIT_REACHED",
  );
}
