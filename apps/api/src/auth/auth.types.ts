import type { OrgRole } from "./context.js";

export interface AuthOrganization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
}

/** Who is making a request, resolved from the session cookie. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  /** The organization this session is working in, or null if the user belongs to none. */
  organizationId: string | null;
  role: OrgRole | null;
  /** Every organization the user can switch to. */
  organizations: AuthOrganization[];
  /** The account has a confirmed second factor. */
  mfaEnabled: boolean;
  /** The account has MFA but this session has not passed it yet: only the second-factor step is reachable. */
  mfaPending: boolean;
  /** Policy requires MFA for this role and the account has none: only enrolment is reachable. */
  mfaEnrollmentRequired: boolean;
  /** Epoch ms of the last password proof for this session (login or re-authentication). */
  lastAuthAt: number;
}
