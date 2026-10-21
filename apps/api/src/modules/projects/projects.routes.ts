import type { FastifyInstance } from "fastify";
import { projectsService } from "./projects.service.js";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import {
  createProjectBody,
  knowledgeBody,
  draftBody,
  importBody,
  listQuery,
  membersBody,
  projectCategoryParams,
  projectIdParam,
  updateProjectBody,
} from "./projects.validation.js";

const notFound = { error: "Project not found" };

export async function projectsRoutes(app: FastifyInstance) {
  app.get("/api/projects", async (req, reply) => {
    const query = parseInput(listQuery, req.query);
    const data = await projectsService.listProjects(requireContext(req), { includeArchived: query.includeArchived === "true" });
    return reply.send({ data });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const { id } = parseInput(projectIdParam, req.params);
    const project = await projectsService.getProjectWithKnowledge(requireContext(req), { projectId: id });
    if (!project) {
      return reply.status(404).send(notFound);
    }
    return reply.send({ data: project });
  });

  app.post("/api/projects", async (req, reply) => {
    const body = parseInput(createProjectBody, req.body);
    const project = await projectsService.createProject(requireContext(req), body);
    return reply.status(201).send({ data: project });
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const { id } = parseInput(projectIdParam, req.params);
    const body = parseInput(updateProjectBody, req.body);
    const project = await projectsService.updateProject(requireContext(req), { projectId: id, ...body });
    if (!project) return reply.status(404).send(notFound);
    return reply.send({ data: project });
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/archive", async (req, reply) => {
    const { id } = parseInput(projectIdParam, req.params);
    const project = await projectsService.archiveProject(requireContext(req), { projectId: id });
    if (!project) return reply.status(404).send(notFound);
    return reply.send({ data: project });
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/unarchive", async (req, reply) => {
    const { id } = parseInput(projectIdParam, req.params);
    const project = await projectsService.unarchiveProject(requireContext(req), { projectId: id });
    if (!project) return reply.status(404).send(notFound);
    return reply.send({ data: project });
  });

  app.put<{ Params: { id: string; category: string } }>("/api/projects/:id/knowledge/:category", async (req, reply) => {
    const { id, category } = parseInput(projectCategoryParams, req.params);
    const { content } = parseInput(knowledgeBody, req.body);
    const row = await projectsService.upsertKnowledge(requireContext(req), { projectId: id, category, content });
    if (!row) return reply.status(404).send(notFound);
    return reply.send({ data: row });
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/knowledge/import", async (req, reply) => {
    const { id } = parseInput(projectIdParam, req.params);
    const body = parseInput(importBody, req.body);
    const result = await projectsService.importKnowledge(requireContext(req), { projectId: id, ...body });
    if (!result) return reply.status(404).send(notFound);
    return reply.send({ data: result });
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/knowledge/draft", async (req, reply) => {
    const { id } = parseInput(projectIdParam, req.params);
    const body = parseInput(draftBody, req.body);
    const draft = await projectsService.draftKnowledge(requireContext(req), { projectId: id, ...body });
    if (!draft) return reply.status(404).send(notFound);
    return reply.send({ data: draft });
  });

  app.delete<{ Params: { id: string; category: string } }>("/api/projects/:id/knowledge/:category", async (req, reply) => {
    const { id, category } = parseInput(projectCategoryParams, req.params);
    const removed = await projectsService.deleteKnowledge(requireContext(req), { projectId: id, category });
    if (!removed) return reply.status(404).send({ error: "Knowledge not found" });
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/members", async (req, reply) => {
    const { id } = parseInput(projectIdParam, req.params);
    const data = await projectsService.getProjectMembers(requireContext(req), { projectId: id });
    if (!data) return reply.status(404).send(notFound);
    return reply.send({ data });
  });

  app.put<{ Params: { id: string } }>("/api/projects/:id/members", async (req, reply) => {
    const { id } = parseInput(projectIdParam, req.params);
    const { userIds } = parseInput(membersBody, req.body);
    const data = await projectsService.setProjectMembers(requireContext(req), { projectId: id, userIds });
    if (!data) return reply.status(404).send(notFound);
    return reply.send({ data });
  });
}
