import { z } from "zod";

/**
 * One zod schema per knowledge category. Everything the voice agent may quote
 * to a lead is validated here on write, so the AI tools can rely on the shape.
 * Unknown keys are stripped (not stored); sizes are capped to keep prompts small.
 */
const short = z.string().trim().min(1).max(200);
const note = z.string().trim().max(1000);
const currency = z.string().trim().min(1).max(10);
const money = z.number().int().min(0).max(1_000_000_000_000);

const pricing = z.object({
  currency: currency.default("INR"),
  ranges: z
    .array(z.object({ type: short, min: money, max: money }).refine((r) => r.max >= r.min, { message: "max must be >= min", path: ["max"] }))
    .max(50),
  /** Price per square foot across the project, for land and plotted projects. */
  perSqft: z
    .object({ min: z.number().positive().max(10_000_000), max: z.number().positive().max(10_000_000) })
    .refine((r) => r.max >= r.min, { message: "max must be >= min", path: ["max"] })
    .optional(),
  notes: note.optional(),
});

/** A unit: an apartment type, or an individual plot (number, facing, availability, its own price or rate). */
const unit = z.object({
  type: short,
  areaSqft: z.number().int().positive().max(1_000_000),
  plotNumber: short.optional(),
  facing: short.optional(),
  status: z.enum(["available", "sold", "hold"]).optional(),
  pricePerSqft: z.number().positive().max(10_000_000).optional(),
  price: money.optional(),
});

const configurations = z.object({
  units: z.array(unit).max(500),
});

const amenities = z.object({ items: z.array(short).max(100) });

const possession = z.object({
  expectedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .refine((s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, "not a real calendar date"),
  notes: note.optional(),
});

const location = z.object({
  address: z.string().trim().min(1).max(500),
  landmarks: z.array(short).max(50),
});

const faq = z.object({
  items: z.array(z.object({ question: z.string().trim().min(1).max(500), answer: z.string().trim().min(1).max(2000) })).max(100),
});

const rera = z.object({
  registrationNumber: z.string().trim().min(1).max(100),
  authority: short.optional(),
  notes: note.optional(),
});

const loan = z.object({
  assistanceAvailable: z.boolean(),
  banks: z.array(short).max(50).optional(),
  notes: note.optional(),
});

const booking = z.object({
  bookingAmount: money.optional(),
  currency: currency.optional(),
  paymentPlan: z.string().trim().max(1000).optional(),
  notes: note.optional(),
});

const maintenance = z.object({
  chargesPerSqftPerMonth: z.number().min(0).max(100_000).optional(),
  currency: currency.optional(),
  notes: note.optional(),
});

export const knowledgeSchemas = { pricing, configurations, amenities, possession, location, faq, rera, loan, booking, maintenance } as const;

export type KnowledgeCategory = keyof typeof knowledgeSchemas;

export const KNOWLEDGE_CATEGORIES = Object.keys(knowledgeSchemas) as KnowledgeCategory[];

export function isKnowledgeCategory(value: string): value is KnowledgeCategory {
  return Object.prototype.hasOwnProperty.call(knowledgeSchemas, value);
}
