import { describe, expect, it } from "vitest";
import { resolveMigrationTarget } from "./migrate-guard.js";

const DEV = "postgresql://owner:secret@127.0.0.1:5440/voice_agent_mvp";
const TEST = "postgresql://owner:secret@127.0.0.1:5440/voice_agent_test";

describe("migration target guard", () => {
  it("uses DATABASE_URL alone", () => {
    const t = resolveMigrationTarget({ DATABASE_URL: DEV });
    expect(t.label).toBe("127.0.0.1:5440/voice_agent_mvp");
    expect(t.user).toBe("owner");
  });

  it("allows a different user on the same database (runtime role vs owner)", () => {
    const t = resolveMigrationTarget({
      DATABASE_URL: "postgresql://voice_app:x@localhost:5440/voice_agent_mvp",
      DATABASE_MIGRATION_URL: DEV,
    });
    expect(t.user).toBe("owner");
  });

  it("refuses when the two URLs name different databases", () => {
    expect(() => resolveMigrationTarget({ DATABASE_URL: TEST, DATABASE_MIGRATION_URL: DEV })).toThrow(/Refusing to migrate/);
  });

  it("refuses a different host or port as well", () => {
    expect(() =>
      resolveMigrationTarget({ DATABASE_URL: "postgresql://o:s@127.0.0.1:5432/voice_agent_mvp", DATABASE_MIGRATION_URL: DEV })
    ).toThrow(/Refusing to migrate/);
  });

  it("proceeds only when MIGRATION_TARGET_CONFIRM names the migration database", () => {
    expect(() =>
      resolveMigrationTarget({ DATABASE_URL: TEST, DATABASE_MIGRATION_URL: DEV, MIGRATION_TARGET_CONFIRM: "voice_agent_test" })
    ).toThrow(/Refusing to migrate/);
    const t = resolveMigrationTarget({ DATABASE_URL: TEST, DATABASE_MIGRATION_URL: DEV, MIGRATION_TARGET_CONFIRM: "voice_agent_mvp" });
    expect(t.database).toBe("voice_agent_mvp");
  });

  it("never exposes the password in the printable label", () => {
    const t = resolveMigrationTarget({ DATABASE_URL: DEV });
    expect(t.label).not.toContain("secret");
  });

  it("requires some URL", () => {
    expect(() => resolveMigrationTarget({})).toThrow(/not set/);
  });
});
