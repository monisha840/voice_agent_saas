/**
 * Tests never run against the development database. They use a separate
 * database on the same server (default name `voice_agent_test`, or the
 * full TEST_DATABASE_URL), which is wiped, migrated and seeded at the start
 * of every test run (see global-setup.ts).
 */
export function getTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  const base = explicit || process.env.DATABASE_URL;
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
