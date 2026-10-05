import type { FastifyInstance } from "fastify";
import { projectsService } from "./projects.service.js";

export async function projectsRoutes(app: FastifyInstance) {
  app.get("/api/projects", async (_req, reply) => {
    const data = await projectsService.listProjects();
    return reply.send({ data });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const project = await projectsService.getProjectWithKnowledge({ projectId: req.params.id });
    if (!project) {
      return reply.status(404).send({ error: "Project not found" });
    }
    return reply.send({ data: project });
  });
}
