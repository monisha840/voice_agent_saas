"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, MapPin, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { can } from "@/lib/permissions";
import type { Project, Role } from "@/lib/types";
import { Badge, Button, Field, Modal, Notice, errorMessage, inputClass } from "@/components/ui";
import { EmptyState } from "@/components/StateViews";

export function ProjectsClient({ initial, role }: { initial: Project[]; role: Role | null }) {
  const router = useRouter();
  const [projects, setProjects] = useState(initial);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const visible = projects.filter((p) => showArchived || p.status !== "archived");
  const archivedCount = projects.filter((p) => p.status === "archived").length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-4 w-4 accent-emerald-700"
          />
          Show archived ({archivedCount})
        </label>
        {can(role, "projects:create") && (
          <Button onClick={() => setCreating(true)}>
            <Plus size={14} />
            New project
          </Button>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description={
            can(role, "projects:create")
              ? "Create your first project to start adding knowledge and leads."
              : "You have not been added to any project yet. Ask an admin to add you."
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="group rounded-xl border border-stone-200 bg-white p-5 transition hover:border-stone-300"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium text-stone-900">{p.name}</h2>
                {p.status === "archived" && <Badge>Archived</Badge>}
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-stone-500">
                <MapPin size={13} />
                {p.location}
              </p>
              {p.description && <p className="mt-3 line-clamp-2 text-sm text-stone-600">{p.description}</p>}
              <div className="mt-4 flex items-center gap-1 text-xs font-medium text-emerald-700">
                Open
                <ArrowRight size={12} className="transition group-hover:translate-x-0.5" />
              </div>
            </Link>
          ))}
        </div>
      )}

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setProjects((prev) => [p, ...prev]);
            setCreating(false);
            router.push(`/projects/${p.id}`);
          }}
        />
      )}
    </div>
  );
}

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject({
        name: name.trim(),
        location: location.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onCreated(p);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Location">
          <input required value={location} onChange={(e) => setLocation(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Description (optional)">
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
