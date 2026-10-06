import { z } from "zod";

export const projectIdParam = z.object({ id: z.string().uuid("must be a valid id") });
export const projectCategoryParams = z.object({ id: z.string().uuid("must be a valid id"), category: z.string().min(1).max(50) });

export const createProjectBody = z.object({
  name: z.string().trim().min(2).max(255),
  location: z.string().trim().min(1).max(255),
  description: z.string().trim().max(5000).optional(),
});

export const updateProjectBody = z
  .object({
    name: z.string().trim().min(2).max(255).optional(),
    location: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "at least one field is required" });

export const knowledgeBody = z.object({ content: z.record(z.string(), z.unknown()) });

export const membersBody = z.object({ userIds: z.array(z.string().uuid()).max(500) });

export const listQuery = z.object({ includeArchived: z.enum(["true", "false"]).optional() });
