import { projectsRepository } from "../../db/repositories/projects.repository.js";
import { NotFoundError } from "../../shared/errors.js";

/**
 * Service boundary for project data. Routes and AI tools (get_project_*)
 * call this service — never the repository or raw SQL directly. All
 * project facts the AI may quote come from project_knowledge rows
 * fetched here, never hardcoded in this service or in any AI adapter.
 */
export const projectsService = {
  async getProjectWithKnowledge(params: { projectId: string }) {
    const project = await projectsRepository.findById({ id: params.projectId });
    if (!project) return null;

    const knowledge = await projectsRepository.getKnowledge({ projectId: params.projectId });
    return { ...project, knowledge };
  },

  async listProjects() {
    return projectsRepository.list();
  },

  /** Returns the single demo project. MVP has exactly one project; a later
   * phase (multi-tenant) would scope this by tenant instead of taking the
   * first row. */
  async getDefaultProject() {
    const [project] = await projectsRepository.list();
    if (!project) {
      throw new NotFoundError("No project found. Run the seed script: pnpm db:seed");
    }
    return project;
  },

  async getKnowledgeByCategory(params: { projectId: string; category: string }) {
    const knowledge = await projectsRepository.getKnowledge({ projectId: params.projectId });
    return knowledge.filter((k) => k.category === params.category);
  },
};
