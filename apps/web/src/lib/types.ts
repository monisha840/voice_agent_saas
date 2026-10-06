export type LeadStatus =
  | "NEW"
  | "CALLING"
  | "NO_ANSWER"
  | "BUSY"
  | "RETRY"
  | "ANSWERED"
  | "QUALIFICATION"
  | "INTERESTED"
  | "NOT_INTERESTED"
  | "DNC"
  | "VISIT_OFFERED"
  | "VISIT_BOOKED"
  | "CONFIRMED"
  | "VISITED"
  | "NO_SHOW"
  | "FOLLOW_UP";

export type CallStatus = "initiating" | "ringing" | "in_progress" | "completed" | "failed";

export interface Project {
  id: string;
  name: string;
  location: string;
  description?: string | null;
  status: string;
  archivedAt?: string | null;
  createdAt?: string;
}

export type Role = "OWNER" | "ADMIN" | "MANAGER" | "AGENT";

export const KNOWLEDGE_CATEGORIES = [
  "pricing",
  "configurations",
  "amenities",
  "possession",
  "location",
  "faq",
  "rera",
  "loan",
  "booking",
  "maintenance",
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export interface ProjectKnowledge {
  id: string;
  projectId: string;
  category: KnowledgeCategory;
  content: unknown;
}

export interface ProjectWithKnowledge extends Project {
  knowledge: ProjectKnowledge[];
}

export interface Lead {
  id: string;
  projectId: string;
  assignedUserId?: string | null;
  assigneeName?: string | null;
  name: string;
  phone: string;
  requirementConfig: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  status: LeadStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Call {
  id: string;
  leadId: string;
  providerCallId: string | null;
  status: CallStatus;
  startedAt: string | null;
  endedAt: string | null;
  recordingUrl: string | null;
  createdAt: string;
}

export interface TranscriptTurn {
  speaker: "ai" | "lead";
  text: string;
  timestamp: string;
}

export interface Qualification {
  summary: string;
  interestLevel: "high" | "medium" | "low" | "unknown";
  configuration: string | null;
  budget: string | null;
  purchaseTimeline: string | null;
  loanRequirement: string | null;
  locationPreference: string | null;
  customerQuestions: string[];
  siteVisitStatus: "booked" | "offered" | "declined" | "not_discussed";
  recommendedNextAction: string;
  recommendedLeadStatus: string;
}

export interface Conversation {
  id: string;
  callId: string;
  transcript: TranscriptTurn[];
  summary: string | null;
  qualification: Qualification | null;
  createdAt: string;
}

export interface SiteVisit {
  id: string;
  leadId: string;
  projectId: string;
  scheduledAt: string;
  status: "booked" | "cancelled";
  createdAt: string;
}

export interface LeadDetail extends Lead {
  callHistory: Call[];
  siteVisits: SiteVisit[];
  latestConversation: Conversation | null;
}

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  joinedAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
}

export interface AgentConfig {
  agentName: string;
  companyName: string;
  greeting: string;
  disclosureText: string;
  language: string;
  tone: string;
  callObjective: string;
  qualificationQuestions: string[];
  callBehaviour: { maxResponseSentences: number; endCallWhenDone: boolean };
  allowedTools: string[];
  siteVisitBehaviour: { offerSlots: boolean; autoBook: boolean };
  extraInstructions: string;
}

export interface AgentConfigResponse {
  config: AgentConfig;
  source: "project" | "organization" | "default";
  editable: boolean;
}

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorType: string;
  actorUserId: string | null;
  actorSource: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface UsageSummary {
  totals: { calls: number; callSeconds: number; aiTurns: number; siteVisits: number };
  byType?: unknown[];
}

export interface LeadInput {
  name: string;
  phone: string;
  projectId: string;
  requirementConfig?: string | null;
  budgetMin?: number | null;
  budgetMax?: number | null;
  assignedUserId?: string | null;
}

/** One row of the core calls list. `leadId`/`leadName` are null for calls that are not tied to a lead. */
export interface CallListItem {
  id: string;
  leadId: string | null;
  leadName: string | null;
  leadPhone: string | null;
  status: CallStatus;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  summary: string | null;
  agentId?: string | null;
  agentName?: string | null;
  callType?: CallType;
  counterpartyNumber?: string | null;
  counterpartyName?: string | null;
}

export type CallType = "outbound" | "inbound" | "test";

/** GET /api/calls/:id: the call row plus its conversation and agent context. */
export interface CallDetail {
  id: string;
  leadId: string | null;
  providerCallId: string | null;
  status: CallStatus;
  startedAt: string | null;
  endedAt: string | null;
  recordingUrl: string | null;
  createdAt: string;
  conversation: Conversation | null;
  agent?: { id: string; name: string; personaName: string } | null;
  callType?: CallType;
  counterpartyNumber?: string | null;
  counterpartyName?: string | null;
}

export type PromptTemplateKey = "generic" | "sales_real_estate";

/** What every role that can place calls may see of an agent: just enough to pick it and show its name. */
export interface AgentOption {
  id: string;
  name: string;
  personaName: string;
  status: string;
}

export interface Agent {
  id: string;
  name: string;
  personaName: string;
  companyName: string | null;
  description: string | null;
  status: "active" | "archived";
  isDefault: boolean;
  promptTemplateKey: PromptTemplateKey;
  systemPrompt: string | null;
  extraInstructions: string | null;
  callObjective: string | null;
  greeting: string | null;
  disclosureText: string | null;
  language: string;
  voice: string | null;
  tone: string;
  behaviour: { maxResponseSentences: number; endCallWhenDone: boolean; conversationQuestions: string[] };
  enabledTools: string[];
  moduleConfig: { sales?: { offerSlots: boolean; autoBook: boolean } };
  knowledge: { sourceType: string; sourceId: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted by POST/PATCH /api/agents. */
export type AgentInput = Partial<
  Omit<Agent, "id" | "status" | "isDefault" | "knowledge" | "createdAt" | "updatedAt" | "voice">
>;

export interface ToolInfo {
  name: string;
  description: string;
  module: "core" | "sales";
  requires: string[];
  available: boolean;
}

export interface SiteVisitRow {
  id: string;
  leadId: string;
  projectId: string;
  scheduledAt: string;
  status: string;
  createdAt?: string;
  leadName?: string | null;
  projectName?: string | null;
}

export interface OrganizationModule {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}
