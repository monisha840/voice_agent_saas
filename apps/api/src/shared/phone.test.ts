import { describe, it, expect } from "vitest";
import { normalizeIndianMobile } from "./phone.js";
import { ValidationError } from "./errors.js";

describe("normalizeIndianMobile", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["+919876543210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["0091 98765 43210", "+919876543210"],
    ["+91 (98765)-43210", "+919876543210"],
    ["  7000000001 ", "+917000000001"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each(["", "12345", "5876543210", "98765432101", "+14155550123", "abc", "98765-4321x", "+91 12345 67890"])(
    "rejects %j with a ValidationError",
    (input) => {
      expect(() => normalizeIndianMobile(input)).toThrow(ValidationError);
    },
  );
});
