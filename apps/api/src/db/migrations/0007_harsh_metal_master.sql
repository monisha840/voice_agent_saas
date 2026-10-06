CREATE TABLE IF NOT EXISTS "agent_knowledge_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_type" varchar(40) NOT NULL,
	"source_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_knowledge_bindings_agent_source_unique" UNIQUE("agent_id","source_type","source_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"persona_name" varchar(80) NOT NULL,
	"company_name" varchar(160),
	"description" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"prompt_template_key" varchar(40) DEFAULT 'generic' NOT NULL,
	"system_prompt" text,
	"extra_instructions" text,
	"call_objective" text,
	"greeting" text,
	"disclosure_text" varchar(300),
	"language" varchar(16) DEFAULT 'en-IN' NOT NULL,
	"voice" varchar(80),
	"tone" varchar(30) DEFAULT 'professional' NOT NULL,
	"behaviour" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"module_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_org_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_knowledge_bindings" ADD CONSTRAINT "agent_knowledge_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_knowledge_bindings" ADD CONSTRAINT "agent_knowledge_bindings_org_agent_fk" FOREIGN KEY ("organization_id","agent_id") REFERENCES "public"."agents"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_knowledge_bindings_source_idx" ON "agent_knowledge_bindings" USING btree ("organization_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_org_default_unique" ON "agents" USING btree ("organization_id") WHERE "agents"."is_default" and "agents"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_org_name_unique" ON "agents" USING btree ("organization_id",lower("name")) WHERE "agents"."status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_org_status_idx" ON "agents" USING btree ("organization_id","status");--> statement-breakpoint
-- Backfill (idempotent; agent_configs is left untouched). Everything uses the 'sales_real_estate' template so legacy prompts stay identical.
-- 1. One default agent per organization, from its org-default agent_configs row (or the built-in defaults).
INSERT INTO "agents" (
	"organization_id", "name", "persona_name", "company_name", "status", "is_default", "prompt_template_key",
	"extra_instructions", "call_objective", "greeting", "disclosure_text", "language", "tone",
	"behaviour", "enabled_tools", "module_config"
)
SELECT
	o."id",
	'Default agent',
	COALESCE(NULLIF(btrim(c."agent_name"), ''), 'Priya'),
	NULLIF(btrim(c."company_name"), ''),
	'active',
	true,
	'sales_real_estate',
	c."extra_instructions",
	c."call_objective",
	c."greeting",
	c."disclosure_text",
	COALESCE(c."language", 'en-IN'),
	COALESCE(c."tone", 'professional'),
	jsonb_build_object(
		'maxResponseSentences', CASE WHEN jsonb_typeof(c."call_behaviour"->'maxResponseSentences') = 'number' THEN c."call_behaviour"->'maxResponseSentences' ELSE '3'::jsonb END,
		'endCallWhenDone', CASE WHEN jsonb_typeof(c."call_behaviour"->'endCallWhenDone') = 'boolean' THEN c."call_behaviour"->'endCallWhenDone' ELSE 'true'::jsonb END,
		'conversationQuestions', CASE WHEN jsonb_typeof(c."qualification_questions") = 'array' THEN c."qualification_questions" ELSE '[]'::jsonb END
	),
	CASE
		WHEN jsonb_typeof(c."allowed_tools") = 'array' AND jsonb_array_length(c."allowed_tools") > 0 THEN
			CASE WHEN c."allowed_tools" @> '["end_call"]'::jsonb THEN c."allowed_tools" ELSE c."allowed_tools" || '["end_call"]'::jsonb END
		ELSE '["get_project_details","get_project_price","get_project_configurations","get_project_location","check_visit_slots","book_site_visit","update_lead","mark_not_interested","end_call"]'::jsonb
	END,
	jsonb_build_object('sales', jsonb_build_object(
		'offerSlots', CASE WHEN jsonb_typeof(c."site_visit_behaviour"->'offerSlots') = 'number' THEN c."site_visit_behaviour"->'offerSlots' ELSE '3'::jsonb END,
		'autoBook', CASE WHEN jsonb_typeof(c."site_visit_behaviour"->'autoBook') = 'boolean' THEN c."site_visit_behaviour"->'autoBook' ELSE 'true'::jsonb END
	))
FROM "organizations" o
LEFT JOIN "agent_configs" c ON c."organization_id" = o."id" AND c."project_id" IS NULL
WHERE NOT EXISTS (
	SELECT 1 FROM "agents" a WHERE a."organization_id" = o."id" AND a."is_default" AND a."status" = 'active'
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 2. One agent per project-override row, bound to that project. A project that already has a binding is skipped.
DO $$
DECLARE
	r record;
	new_id uuid;
	base_name text;
	candidate text;
	n integer;
BEGIN
	FOR r IN
		SELECT c.*, p."name" AS project_name
		FROM "agent_configs" c
		JOIN "projects" p ON p."organization_id" = c."organization_id" AND p."id" = c."project_id"
		WHERE c."project_id" IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM "agent_knowledge_bindings" b
				WHERE b."organization_id" = c."organization_id" AND b."source_type" = 'project' AND b."source_id" = c."project_id"
			)
		ORDER BY c."created_at", c."id"
	LOOP
		base_name := left(r.project_name, 100) || ' agent';
		candidate := base_name;
		n := 1;
		WHILE EXISTS (
			SELECT 1 FROM "agents" a
			WHERE a."organization_id" = r."organization_id" AND a."status" = 'active' AND lower(a."name") = lower(candidate)
		) LOOP
			n := n + 1;
			candidate := base_name || ' (' || n || ')';
		END LOOP;

		INSERT INTO "agents" (
			"organization_id", "name", "persona_name", "company_name", "status", "is_default", "prompt_template_key",
			"extra_instructions", "call_objective", "greeting", "disclosure_text", "language", "tone",
			"behaviour", "enabled_tools", "module_config"
		) VALUES (
			r.organization_id,
			candidate,
			COALESCE(NULLIF(btrim(r.agent_name), ''), 'Priya'),
			NULLIF(btrim(r.company_name), ''),
			'active',
			false,
			'sales_real_estate',
			r.extra_instructions,
			r.call_objective,
			r.greeting,
			r.disclosure_text,
			COALESCE(r.language, 'en-IN'),
			COALESCE(r.tone, 'professional'),
			jsonb_build_object(
				'maxResponseSentences', CASE WHEN jsonb_typeof(r.call_behaviour->'maxResponseSentences') = 'number' THEN r.call_behaviour->'maxResponseSentences' ELSE '3'::jsonb END,
				'endCallWhenDone', CASE WHEN jsonb_typeof(r.call_behaviour->'endCallWhenDone') = 'boolean' THEN r.call_behaviour->'endCallWhenDone' ELSE 'true'::jsonb END,
				'conversationQuestions', CASE WHEN jsonb_typeof(r.qualification_questions) = 'array' THEN r.qualification_questions ELSE '[]'::jsonb END
			),
			CASE
				WHEN jsonb_typeof(r.allowed_tools) = 'array' AND jsonb_array_length(r.allowed_tools) > 0 THEN
					CASE WHEN r.allowed_tools @> '["end_call"]'::jsonb THEN r.allowed_tools ELSE r.allowed_tools || '["end_call"]'::jsonb END
				ELSE '["get_project_details","get_project_price","get_project_configurations","get_project_location","check_visit_slots","book_site_visit","update_lead","mark_not_interested","end_call"]'::jsonb
			END,
			jsonb_build_object('sales', jsonb_build_object(
				'offerSlots', CASE WHEN jsonb_typeof(r.site_visit_behaviour->'offerSlots') = 'number' THEN r.site_visit_behaviour->'offerSlots' ELSE '3'::jsonb END,
				'autoBook', CASE WHEN jsonb_typeof(r.site_visit_behaviour->'autoBook') = 'boolean' THEN r.site_visit_behaviour->'autoBook' ELSE 'true'::jsonb END
			))
		) RETURNING "id" INTO new_id;

		INSERT INTO "agent_knowledge_bindings" ("organization_id", "agent_id", "source_type", "source_id")
		VALUES (r.organization_id, new_id, 'project', r.project_id)
		ON CONFLICT DO NOTHING;
	END LOOP;
END $$;
