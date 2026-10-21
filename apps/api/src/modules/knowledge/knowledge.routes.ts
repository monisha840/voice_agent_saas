import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireContext } from "../../auth/auth.plugin.js";
import { parseInput } from "../../shared/validation.js";
import { knowledgeService } from "./knowledge.service.js";

const listQuery = z.object({ includeArchived: z.enum(["true", "false"]).optional() }).strict();
type P = { id: string; itemId?: string; documentId?: string };

/** Knowledge-base endpoints. The organization is the authenticated membership; ids from another one are "not found". */
export async function knowledgeRoutes(app: FastifyInstance) {
  app.get("/api/knowledge-bases", async (req, reply) => {
    const q = parseInput(listQuery, req.query);
    return reply.send({ data: await knowledgeService.list(requireContext(req), { includeArchived: q.includeArchived === "true" }) });
  });
  app.post("/api/knowledge-bases", async (req, reply) => {
    return reply.status(201).send({ data: await knowledgeService.create(requireContext(req), req.body) });
  });
  app.get<{ Params: P }>("/api/knowledge-bases/:id", async (req, reply) => {
    return reply.send({ data: await knowledgeService.get(requireContext(req), req.params.id) });
  });
  app.patch<{ Params: P }>("/api/knowledge-bases/:id", async (req, reply) => {
    return reply.send({ data: await knowledgeService.update(requireContext(req), req.params.id, req.body) });
  });
  app.post<{ Params: P }>("/api/knowledge-bases/:id/archive", async (req, reply) => {
    return reply.send({ data: await knowledgeService.setArchived(requireContext(req), req.params.id, true) });
  });
  app.post<{ Params: P }>("/api/knowledge-bases/:id/unarchive", async (req, reply) => {
    return reply.send({ data: await knowledgeService.setArchived(requireContext(req), req.params.id, false) });
  });
  app.post<{ Params: P }>("/api/knowledge-bases/:id/items", async (req, reply) => {
    return reply.status(201).send({ data: await knowledgeService.addItem(requireContext(req), req.params.id, req.body) });
  });
  app.patch<{ Params: P }>("/api/knowledge-bases/:id/items/:itemId", async (req, reply) => {
    return reply.send({ data: await knowledgeService.updateItem(requireContext(req), req.params.id, req.params.itemId ?? "", req.body) });
  });
  app.delete<{ Params: P }>("/api/knowledge-bases/:id/items/:itemId", async (req, reply) => {
    return reply.send({ data: await knowledgeService.deleteItem(requireContext(req), req.params.id, req.params.itemId ?? "") });
  });
  // Text documents only (.txt, .md, .csv), JSON with base64 content; a slightly higher body limit than the default.
  app.post<{ Params: P }>("/api/knowledge-bases/:id/documents", { bodyLimit: 400 * 1024 }, async (req, reply) => {
    return reply.status(201).send({ data: await knowledgeService.uploadDocument(requireContext(req), req.params.id, req.body) });
  });
  app.delete<{ Params: P }>("/api/knowledge-bases/:id/documents/:documentId", async (req, reply) => {
    return reply.send({ data: await knowledgeService.deleteDocument(requireContext(req), req.params.id, req.params.documentId ?? "") });
  });
  // Which knowledge bases an agent uses (only knowledge-base bindings; other binding types are untouched).
  app.put<{ Params: P }>("/api/agents/:id/knowledge-bases", async (req, reply) => {
    return reply.send({ data: await knowledgeService.setAgentKnowledgeBases(requireContext(req), req.params.id, req.body) });
  });
  app.post<{ Params: P }>("/api/knowledge-bases/:id/search", async (req, reply) => {
    return reply.send({ data: await knowledgeService.searchPreview(requireContext(req), req.params.id, req.body) });
  });
}
