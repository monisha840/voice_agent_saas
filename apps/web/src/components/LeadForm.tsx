"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { Lead, LeadInput, Project, TeamMember } from "@/lib/types";
import { Button, Field, Modal, Notice, errorMessage, inputClass } from "@/components/ui";

const rupees = (v: string): number | null | "invalid" => {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
};

/**
 * Create (no `lead`) or edit (`lead`) form in a modal. Phone and other
 * validation errors come back from the API and are shown inline.
 */
export function LeadFormModal({
  lead,
  projects,
  assignees,
  canAssign,
  onClose,
  onSaved,
}: {
  lead?: Lead;
  projects: Project[];
  assignees: TeamMember[];
  canAssign: boolean;
  onClose: () => void;
  onSaved: (lead: Lead) => void;
}) {
  const [name, setName] = useState(lead?.name ?? "");
  const [phone, setPhone] = useState(lead?.phone ?? "");
  const [projectId, setProjectId] = useState(lead?.projectId ?? projects[0]?.id ?? "");
  const [requirement, setRequirement] = useState(lead?.requirementConfig ?? "");
  const [budgetMin, setBudgetMin] = useState(lead?.budgetMin != null ? String(lead.budgetMin) : "");
  const [budgetMax, setBudgetMax] = useState(lead?.budgetMax != null ? String(lead.budgetMax) : "");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const min = rupees(budgetMin);
    const max = rupees(budgetMax);
    if (min === "invalid" || max === "invalid") return setError("Budget must be a positive number.");
    if (min != null && max != null && min > max) return setError("Minimum budget cannot exceed maximum budget.");
    setBusy(true);
    setError(null);
    try {
      if (lead) {
        const saved = await api.updateLead(lead.id, {
          name: name.trim(),
          phone: phone.trim(),
          requirementConfig: requirement.trim() || null,
          budgetMin: min,
          budgetMax: max,
        });
        onSaved(saved);
      } else {
        const input: LeadInput = {
          name: name.trim(),
          phone: phone.trim(),
          projectId,
          ...(requirement.trim() ? { requirementConfig: requirement.trim() } : {}),
          ...(min != null ? { budgetMin: min } : {}),
          ...(max != null ? { budgetMax: max } : {}),
          ...(assignee ? { assignedUserId: assignee } : {}),
        };
        onSaved(await api.createLead(input));
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={lead ? "Edit lead details" : "New lead"} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Phone" hint="Include the country code, e.g. +919876543210">
          <input required type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} />
        </Field>
        {!lead && (
          <Field label="Project" className="sm:col-span-2">
            <select required value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputClass}>
              {projects.length === 0 && <option value="">No projects available</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Requirement (optional)" className="sm:col-span-2">
          <input placeholder="e.g. 3 BHK" value={requirement} onChange={(e) => setRequirement(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Budget min, INR (optional)">
          <input inputMode="decimal" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Budget max, INR (optional)">
          <input inputMode="decimal" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} className={inputClass} />
        </Field>
        {!lead && canAssign && (
          <Field label="Assign to (optional)" className="sm:col-span-2">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={inputClass}>
              <option value="">Unassigned</option>
              {assignees.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          </Field>
        )}
        {error && (
          <div className="sm:col-span-2">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!lead && !projectId}>
            {lead ? "Save changes" : "Create lead"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
