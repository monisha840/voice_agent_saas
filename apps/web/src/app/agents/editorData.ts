import { api, ApiError } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { hasModule } from "@/lib/modules";
import type { Project, ToolInfo } from "@/lib/types";

/** Shared server-side loading for the agent editor pages. Tools and projects degrade to empty if unavailable. */
export async function loadEditorData() {
  const me = await api.me();
  const role = me.organization?.role;
  if (!can(role, "agents:read")) throw new ApiError("Forbidden", 403);
  const sales = hasModule(me.organization, "sales");
  const [tools, projects] = await Promise.all([
    api.listTools().catch((): ToolInfo[] | null => null),
    sales ? api.listProjectsAll(false).catch((): Project[] => []) : Promise.resolve([] as Project[]),
  ]);
  return { canManage: can(role, "agents:manage"), sales, tools, projects };
}
