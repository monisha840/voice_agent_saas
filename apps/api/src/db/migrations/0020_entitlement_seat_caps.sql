-- Plan seat caps (maxAgents, maxTeamMembers), enforced in the database so they hold for every code path and under
-- concurrent requests. ADDITIVE: three functions and three triggers; no table, policy, role or grant is altered.
--
--  * A cap applies only to organizations that HAVE a subscription (unmanaged organizations are unaffected) and only
--    when the plan/override defines the key. A missing key means "no cap" (NULL), never "zero".
--  * Triggers run as the invoking role (SECURITY INVOKER): they read `subscriptions`/`plans` under the caller's own
--    tenant scope, so row-level security is not bypassed.
--  * Concurrency: a per-organization transaction advisory lock serialises the count-then-insert, so N parallel
--    creations cannot all pass. (READ COMMITTED: the count after the lock sees every earlier committed row.)
--  * The SQLSTATE VA010 / VA011 and the message `plan_limit:<what>:<cap>` are translated into a 429 by
--    modules/billing/cap-errors.ts. Existing rows are never touched: a downgrade below current usage only blocks NEW seats.

CREATE OR REPLACE FUNCTION billing_cap_for(p_org uuid, p_key text) RETURNS integer
  LANGUAGE sql STABLE AS $$
    SELECT coalesce((s.limit_overrides ->> p_key)::int, (p.entitlements ->> p_key)::int)
    FROM subscriptions s JOIN plans p ON p.key = s.plan_key
    WHERE s.organization_id = p_org
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing_enforce_agent_cap() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_cap integer;
  v_used integer;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN RETURN NEW; END IF;
  v_cap := billing_cap_for(NEW.organization_id, 'maxAgents');
  IF v_cap IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cap:agents:' || NEW.organization_id::text, 0));
  SELECT count(*) INTO v_used FROM agents
    WHERE organization_id = NEW.organization_id AND status = 'active' AND id <> NEW.id;
  IF v_used >= v_cap THEN
    RAISE EXCEPTION 'plan_limit:agents:%', v_cap USING ERRCODE = 'VA010';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_agent_cap_trg ON agents;
--> statement-breakpoint
CREATE TRIGGER billing_agent_cap_trg BEFORE INSERT OR UPDATE OF status ON agents
  FOR EACH ROW EXECUTE FUNCTION billing_enforce_agent_cap();
--> statement-breakpoint

-- Team seats = members + pending (usable) invitations, so an invitation can never be issued that cannot be accepted.
CREATE OR REPLACE FUNCTION billing_enforce_member_cap() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_cap integer;
  v_used integer;
BEGIN
  v_cap := billing_cap_for(NEW.organization_id, 'maxTeamMembers');
  IF v_cap IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cap:team:' || NEW.organization_id::text, 0));
  SELECT (SELECT count(*) FROM memberships WHERE organization_id = NEW.organization_id)
       + (SELECT count(*) FROM invitations
            WHERE organization_id = NEW.organization_id AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
              AND (TG_TABLE_NAME <> 'invitations' OR id <> NEW.id))
    INTO v_used;
  -- A membership insert for an invitation being accepted: that invitation was already counted as pending until it
  -- was claimed (accepted_at set earlier in the same transaction), so no double count.
  IF v_used >= v_cap THEN
    RAISE EXCEPTION 'plan_limit:team:%', v_cap USING ERRCODE = 'VA011';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_member_cap_trg ON memberships;
--> statement-breakpoint
CREATE TRIGGER billing_member_cap_trg BEFORE INSERT ON memberships
  FOR EACH ROW EXECUTE FUNCTION billing_enforce_member_cap();
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_invitation_cap_trg ON invitations;
--> statement-breakpoint
CREATE TRIGGER billing_invitation_cap_trg BEFORE INSERT ON invitations
  FOR EACH ROW EXECUTE FUNCTION billing_enforce_member_cap();
