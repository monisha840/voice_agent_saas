-- Rollback of 0023 (knowledge base). DESTRUCTIVE: deletes every knowledge base, uploaded document record and searchable
-- passage of every organization, and every agent's binding to a knowledge base. Back up first (pg_dump -Fc).
-- The bindings must go too: they live in agent_knowledge_bindings (no foreign key to these tables), and a binding left
-- behind would still offer the search_knowledge tool on calls, whose search would then fail against the dropped table.
-- Run as the owner, in one transaction. Never run automatically; tested on a scratch database only
-- (db/migration-0023.test.ts). To re-apply 0023 afterwards, also delete its row from drizzle.__drizzle_migrations
-- (created_at = the 0023 journal entry's "when") and run the migrator.
BEGIN;
DELETE FROM agent_knowledge_bindings WHERE source_type = 'knowledge_base';
DROP TABLE IF EXISTS knowledge_items;
DROP TABLE IF EXISTS knowledge_documents;
DROP TABLE IF EXISTS knowledge_bases;
COMMIT;
