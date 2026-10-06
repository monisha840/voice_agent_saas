import { getProjectDetails } from "./get_project_details.js";
import { getProjectPrice } from "./get_project_price.js";
import { getProjectConfigurations } from "./get_project_configurations.js";
import { getProjectLocation } from "./get_project_location.js";
import { checkVisitSlots } from "./check_visit_slots.js";
import { bookSiteVisit } from "./book_site_visit.js";
import { updateLead } from "./update_lead.js";
import { markNotInterested } from "./mark_not_interested.js";

/** Every tool the Sales module owns, in the order the LLM and the UI have always seen them. */
export const SALES_TOOLS = [
  getProjectDetails,
  getProjectPrice,
  getProjectConfigurations,
  getProjectLocation,
  checkVisitSlots,
  bookSiteVisit,
  updateLead,
  markNotInterested,
] as const;
