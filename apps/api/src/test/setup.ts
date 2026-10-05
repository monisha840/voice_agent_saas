/**
 * Shared test setup: loads env (so DATABASE_URL etc. are available) once,
 * before any test file's module-level imports run. Tests that touch the
 * database assume the local docker-compose Postgres is running and
 * migrated (same container used for `pnpm db:seed`), matching how this
 * MVP's "do not mock the database" testing approach is documented in
 * MVP_IMPLEMENTATION_PLAN.md — only external providers (Exotel/Sarvam)
 * are mocked, never our own Postgres.
 */
import { loadEnv } from "../config/env.js";
loadEnv();
