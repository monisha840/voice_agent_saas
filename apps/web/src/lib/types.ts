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
  status: string;
}

export interface ProjectKnowledge {
  id: string;
  projectId: string;
  category: "pricing" | "configurations" | "amenities" | "possession" | "faq" | "location";
  content: unknown;
}

export interface ProjectWithKnowledge extends Project {
  knowledge: ProjectKnowledge[];
}

export interface Lead {
  id: string;
  projectId: string;
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
