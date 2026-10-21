import { z } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Parses untrusted input with a zod schema. On failure throws a
 * ValidationError whose message lists the problems; the HTTP layer turns it
 * into a 400 with those details (never a stack trace).
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`);
    throw new ValidationError(`Invalid request - ${details.join("; ")}`);
  }
  return result.data;
}
