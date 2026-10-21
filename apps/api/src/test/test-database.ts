/**
 * Tests never run against the development database. They use a separate
 * database on the same server (default name `voice_agent_test`, or the
 * full TEST_DATABASE_URL), which is wiped, migrated and seeded at the start
 * of every test run (see global-setup.ts).
 */
export function getTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  // The owner URL: when the dev environment connects as the restricted runtime role (DATABASE_URL), the test run
  // still needs the owner to create and migrate its throw-away database (DATABASE_MIGRATION_URL).
  const base = explicit || process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL (or TEST_DATABASE_URL) is not set.");
  const url = new URL(base);
  // TEST_DATABASE_NAME lets parallel workers each use their own database on the same server.
  if (!explicit) url.pathname = `/${process.env.TEST_DATABASE_NAME || "voice_agent_test"}`;
  assertSafeTestDatabase(url);
  return url.toString();
}

/** Refuse to wipe anything that is not obviously a test database. */
export function assertSafeTestDatabase(url: URL): void {
  const name = url.pathname.replace(/^\//, "");
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to use database "${name}" for tests: its name must contain "test".`);
  }
}

/** The restricted runtime role the application connects as in tests (created by global-setup). */
export const TEST_RUNTIME_ROLE = "voice_app";
export const TEST_RUNTIME_PASSWORD = "voice_app_test_password";

/** The test database as the restricted runtime role: not an owner, subject to row-level security. */
export function getTestRuntimeUrl(): string {
  const url = new URL(getTestDatabaseUrl());
  url.username = TEST_RUNTIME_ROLE;
  url.password = TEST_RUNTIME_PASSWORD;
  return url.toString();
}
