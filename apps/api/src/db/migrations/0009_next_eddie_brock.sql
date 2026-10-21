-- Expand/contract, step 2 of 2: every call now belongs to an agent.
-- Migration 0008 backfilled agent_id for all existing calls and the application writes it on every new call.
-- Guard: refuse to apply (instead of failing half-way or losing data) if any call is still unattributed.
DO $$
DECLARE
  unattributed integer;
BEGIN
  SELECT count(*) INTO unattributed FROM "calls" WHERE "agent_id" IS NULL;
  IF unattributed > 0 THEN
    RAISE EXCEPTION 'Cannot make calls.agent_id NOT NULL: % call(s) have no agent. Re-run the 0008 backfill or fix them first.', unattributed;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "agent_id" SET NOT NULL;
