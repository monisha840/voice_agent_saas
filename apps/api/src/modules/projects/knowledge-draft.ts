/**
 * Turning a brochure, price sheet or FAQ (pasted as text) into a DRAFT of the project's structured knowledge.
 *
 * The model proposes; nothing is saved. Every proposed category is checked against the same schema a person's own entry
 * goes through, the result is shown to a person, and only what they approve is written (through the ordinary knowledge
 * save). What the model returns is untrusted text: it is parsed, validated and size-limited here.
 */
import { KNOWLEDGE_CATEGORIES, knowledgeSchemas, type KnowledgeCategory } from "./knowledge.schemas.js";

export const MAX_DRAFT_SOURCE_CHARS = 20_000;

/** The shapes the model is asked to produce. Kept short: it only has to be understood, the schema is what enforces. */
const SHAPES = `
pricing: {"currency":"INR","ranges":[{"type":"2 BHK","min":6500000,"max":7800000}],"perSqft":{"min":5000,"max":6000},"notes":""}  (amounts are whole rupees)
configurations: {"units":[{"type":"2 BHK","areaSqft":1150,"plotNumber":"","facing":"","status":"available|sold|hold","pricePerSqft":0,"price":0}]}
amenities: {"items":["Clubhouse","Gym"]}
possession: {"expectedDate":"YYYY-MM-DD","notes":""}
location: {"address":"","landmarks":["Near ITPL"]}
nearby: {"items":[{"name":"","type":"school|college|hospital|it_park|office|mall|market|metro|railway|bus|airport|highway|temple|park|other","distanceKm":0,"travelMinutes":0}]}
approvals: {"items":[{"authority":"","number":"","notes":""}]}
builder: {"name":"","yearsInBusiness":0,"completedProjects":0,"notes":""}
about: {"text":"the project described in 2-3 sentences, using the document's own words"}
rera: {"registrationNumber":"","authority":"","notes":""}
loan: {"assistanceAvailable":true,"banks":[""],"notes":""}
booking: {"bookingAmount":0,"currency":"INR","paymentPlan":"","notes":""}
maintenance: {"chargesPerSqftPerMonth":0,"currency":"INR","notes":""}
faq: {"items":[{"question":"","answer":""}]}`;

export function buildDraftMessages(text: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: `You read a real-estate brochure, price sheet or FAQ and extract the facts into JSON for a sales assistant's knowledge base.
Rules:
- Reply with ONE JSON object and nothing else. Its keys are category names; include a category only if the document states facts for it.
- Use ONLY facts written in the document. Never guess, round or infer a number, date, distance or approval. If a field is not stated, leave it out.
- Amounts are whole rupees (6500000 for 65 lakhs; 1.1 crore is 11000000). Distances are kilometres.
- Do not include a discount or an offer.
Categories and their shapes:${SHAPES}`,
    },
    { role: "user", content: text.slice(0, MAX_DRAFT_SOURCE_CHARS) },
  ];
}

export interface KnowledgeDraft {
  /** Content that passed the category's schema, ready to be saved after a person approves it. */
  drafts: Partial<Record<KnowledgeCategory, unknown>>;
  /** Categories the model proposed that did not pass, with why (so the person can fix the source or enter it by hand). */
  rejected: Array<{ category: string; reason: string }>;
}

/** The first balanced-looking JSON object in a model reply (it may add words or a code fence around it). */
function extractJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseKnowledgeDraft(raw: string): KnowledgeDraft {
  const out: KnowledgeDraft = { drafts: {}, rejected: [] };
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(KNOWLEDGE_CATEGORIES as readonly string[]).includes(key)) {
      out.rejected.push({ category: key.slice(0, 50), reason: "not a knowledge category" });
      continue;
    }
    const category = key as KnowledgeCategory;
    const result = knowledgeSchemas[category].safeParse(value);
    if (result.success) out.drafts[category] = result.data;
    else out.rejected.push({ category, reason: result.error.issues[0] ? `${result.error.issues[0].path.join(".") || "content"}: ${result.error.issues[0].message}` : "invalid" });
  }
  return out;
}
