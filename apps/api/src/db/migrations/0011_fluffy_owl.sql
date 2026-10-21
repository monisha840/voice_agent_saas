ALTER TYPE "project_knowledge_category" ADD VALUE 'nearby';--> statement-breakpoint
ALTER TYPE "project_knowledge_category" ADD VALUE 'approvals';--> statement-breakpoint
ALTER TYPE "project_knowledge_category" ADD VALUE 'builder';--> statement-breakpoint
ALTER TYPE "project_knowledge_category" ADD VALUE 'about';
--> statement-breakpoint
-- Real-estate agents get the new get_nearby_places tool (read-only lookup of the project's own data).
UPDATE "agents" SET "enabled_tools" = "enabled_tools" || '["get_nearby_places"]'::jsonb
WHERE "prompt_template_key" = 'sales_real_estate'
  AND jsonb_typeof("enabled_tools") = 'array'
  AND NOT ("enabled_tools" @> '["get_nearby_places"]'::jsonb);
