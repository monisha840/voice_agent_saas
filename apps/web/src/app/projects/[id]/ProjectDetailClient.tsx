"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { api } from "@/lib/api";
import { can } from "@/lib/permissions";
import type { ProjectMember, ProjectWithKnowledge, Role, TeamMember } from "@/lib/types";
import { Badge, Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";
import { KnowledgeEditors } from "./KnowledgeEditors";
import { KnowledgeDraftPanel } from "./KnowledgeDraftPanel";
import { UnansweredPanel } from "./UnansweredPanel";

export function ProjectDetailClient({
  project: initial,
  role,
  initialMembers,
  team,
}: {
  project: ProjectWithKnowledge;
  role: Role | null;
  initialMembers: ProjectMember[];
  team: TeamMember[];
}) {
  const [project, setProject] = useState(initial);
  const archived = project.status === "archived";
  // Managers' project membership is enforced by the API; the UI offers editing and lets the API refuse.
  const canEdit = can(role, "projects:update") && !archived;

  return (
    <div>
      <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-stone-500 hover:text-stone-800">
        <ChevronLeft size={14} />
        Projects
      </Link>
      <div className="mb-6 mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-stone-900">{project.name}</h1>
        {archived && <Badge>Archived</Badge>}
      </div>

      {archived && (
        <div className="mb-6">
          <Notice tone="info">This project is archived and read-only. Unarchive it to make changes.</Notice>
        </div>
      )}

      <div className="space-y-6">
        <DetailsCard
          project={project}
          role={role}
          canEdit={canEdit}
          onChange={(p) => setProject((prev) => ({ ...prev, ...p }))}
        />

        <div>
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Project knowledge</h2>
          <p className="mb-4 text-sm text-stone-500">
            This is everything the AI agent may say about the project. Anything not listed here is never invented.
          </p>
          {canEdit && (
            <div className="mb-4">
              <KnowledgeDraftPanel projectId={project.id} existing={(project.knowledge ?? []).map((k) => k.category)} />
            </div>
          )}
          <div className="mb-4">
            <UnansweredPanel projectId={project.id} />
          </div>
          <KnowledgeEditors projectId={project.id} knowledge={project.knowledge ?? []} canEdit={canEdit} />
        </div>

        {can(role, "projects:members") && (
          <MembersCard projectId={project.id} team={team} initialMembers={initialMembers} />
        )}
      </div>
    </div>
  );
}

function DetailsCard({
  project,
  role,
  canEdit,
  onChange,
}: {
  project: ProjectWithKnowledge;
  role: Role | null;
  canEdit: boolean;
  onChange: (p: Partial<ProjectWithKnowledge>) => void;
}) {
  const [name, setName] = useState(project.name);
  const [location, setLocation] = useState(project.location);
  const [description, setDescription] = useState(project.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const archived = project.status === "archived";

  async function run(action: () => Promise<Partial<ProjectWithKnowledge>>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      onChange(await action());
      setNotice(done);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Details">
      <form
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            async () => {
              const p = await api.updateProject(project.id, {
                name: name.trim(),
                location: location.trim(),
                description: description.trim(),
              });
              return { name: p.name, location: p.location, description: p.description };
            },
            "Details saved.",
          );
        }}
      >
        <Field label="Name">
          <input required disabled={!canEdit} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Location">
          <input required disabled={!canEdit} value={location} onChange={(e) => setLocation(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <textarea rows={3} disabled={!canEdit} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Field>
        {error && (
          <div className="sm:col-span-2">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        {notice && !error && (
          <div className="sm:col-span-2">
            <Notice tone="success">{notice}</Notice>
          </div>
        )}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          {canEdit && (
            <Button type="submit" busy={busy}>
              Save details
            </Button>
          )}
          {can(role, "projects:archive") &&
            (archived ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const p = await api.unarchiveProject(project.id);
                    return { status: p.status ?? "active", archivedAt: null };
                  }, "Project unarchived.")
                }
              >
                Unarchive
              </Button>
            ) : (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("Archive this project? It becomes read-only and leaves active lists.")) return;
                  void run(async () => {
                    const p = await api.archiveProject(project.id);
                    return { status: p.status ?? "archived", archivedAt: p.archivedAt ?? new Date().toISOString() };
                  }, "Project archived.");
                }}
              >
                Archive
              </Button>
            ))}
        </div>
      </form>
    </Card>
  );
}

function MembersCard({
  projectId,
  team,
  initialMembers,
}: {
  projectId: string;
  team: TeamMember[];
  initialMembers: ProjectMember[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialMembers.map((m) => m.userId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Owners and admins see every project already; membership only matters for managers and agents.
  const candidates = team.filter((t) => t.isActive && (t.role === "MANAGER" || t.role === "AGENT"));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.setProjectMembers(projectId, [...selected]);
      setNotice("Members saved.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Project members">
      <p className="mb-3 text-sm text-stone-500">
        Managers and agents only see projects they are a member of. Owners and admins see all projects.
      </p>
      {candidates.length === 0 ? (
        <p className="text-sm text-stone-500">No managers or agents in your team yet. Invite some from the Team page.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {candidates.map((t) => (
            <li key={t.userId}>
              <label className="flex cursor-pointer items-center gap-3 rounded-md border border-stone-200 px-3 py-2 text-sm hover:bg-stone-50">
                <input
                  type="checkbox"
                  checked={selected.has(t.userId)}
                  onChange={() => toggle(t.userId)}
                  className="h-4 w-4 accent-emerald-700"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-stone-900">{t.name}</span>
                  <span className="block truncate text-xs text-stone-500">{t.email}</span>
                </span>
                <Badge>{t.role}</Badge>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {notice && !error && (
        <div className="mt-3">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}
      <div className="mt-4">
        <Button busy={busy} onClick={() => void save()}>
          Save members
        </Button>
      </div>
    </Card>
  );
}
