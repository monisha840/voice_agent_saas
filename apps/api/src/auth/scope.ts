/**
 * Data-level access scopes, layered on top of role permissions.
 * OWNER/ADMIN (and system actors) see everything in their organization.
 * MANAGER sees the projects they are a member of, and all leads in them.
 * AGENT sees only the leads assigned to them (and those leads' projects).
 */
export type LeadScope =
  | { kind: "all" }
  | { kind: "projects"; projectIds: string[] }
  | { kind: "assigned"; userId: string };

export type ProjectScope = { kind: "all" } | { kind: "ids"; projectIds: string[] };
