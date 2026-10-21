import { describe, expect, it } from "vitest";
import { adminSql } from "../db/client.js";
import { inspectRuntimeRole } from "./db-role-check.js";

describe("runtime database role self-check", () => {
  it("accepts the restricted runtime role", async () => {
    const report = await inspectRuntimeRole();
    expect(report.role).toBe("voice_app");
    expect(report.problems).toEqual([]);
  });

  it("flags an owner/superuser connection, which bypasses or can disable row-level security", async () => {
    const report = await inspectRuntimeRole(adminSql!);
    expect(report.problems.join(" ")).toMatch(/SUPERUSER|owns \d+ table/);
  });
});
