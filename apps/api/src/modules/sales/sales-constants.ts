/** Sales-owned constants. They used to live in the core agents constants. */

export const SALES_MODULE_KEY = "sales";
export const SALES_PROMPT_TEMPLATE_KEY = "sales_real_estate";

/** The full tool list of the real-estate template (matches the migration backfill); equality with SALES_TOOLS is tested. */
export const SALES_TOOL_NAMES: readonly string[] = [
  "get_project_details",
  "get_project_price",
  "get_project_configurations",
  "get_project_location",
  "get_nearby_places",
  "check_visit_slots",
  "book_site_visit",
  "update_lead",
  "mark_not_interested",
  "request_follow_up",
  "end_call",
];

export const DEFAULT_SALES_CONFIG = Object.freeze({ offerSlots: 3, autoBook: true });

/** The knowledge source type a Sales agent binds to. */
export const SOURCE_TYPE_PROJECT = "project";
