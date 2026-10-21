"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { SiteVisit } from "@/lib/types";
import { Badge, Button, Field, Modal, Notice, errorMessage, inputClass } from "@/components/ui";

/** "YYYY-MM-DDTHH:mm" in the browser's local time, for a datetime-local input. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The state of a visit as the customer sees it. Attendance is not recorded, so a past booking is just "Past". */
export function visitState(v: { status: string; scheduledAt: string }, now = Date.now()): "upcoming" | "past" | "cancelled" {
  if (v.status === "cancelled") return "cancelled";
  return new Date(v.scheduledAt).getTime() > now ? "upcoming" : "past";
}

export function VisitStateBadge({ visit }: { visit: { status: string; scheduledAt: string } }) {
  const state = visitState(visit);
  if (state === "upcoming") return <Badge tone="success">Upcoming</Badge>;
  if (state === "cancelled") return <Badge tone="neutral">Cancelled</Badge>;
  return <Badge tone="info">Past</Badge>;
}

/**
 * Pick a time and submit once (the button is disabled while saving, so a double click cannot book twice; the API
 * also refuses a second upcoming visit for the same lead).
 */
export function VisitTimeModal({
  title,
  submitLabel,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (iso: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial ? toLocalInput(new Date(initial)) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const min = toLocalInput(new Date(Date.now() + 5 * 60_000));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const when = new Date(value);
    if (!value || Number.isNaN(when.getTime())) return setError("Choose a date and time.");
    if (when.getTime() <= Date.now()) return setError("Choose a time in the future.");
    setBusy(true);
    setError(null);
    try {
      await onSubmit(when.toISOString());
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Date and time" hint="Shown in your local time.">
          <input
            type="datetime-local"
            required
            value={value}
            min={min}
            onChange={(e) => setValue(e.target.value)}
            className={inputClass}
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Back
          </Button>
          <Button type="submit" busy={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Confirmation before cancelling; the API refuses cancelling a visit that is already cancelled or in the past. */
export function CancelVisitModal({
  when,
  who,
  onConfirm,
  onClose,
}: {
  when: string;
  who?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Modal title="Cancel site visit" onClose={busy ? () => undefined : onClose}>
      <p className="text-sm text-stone-700">
        Cancel the visit{who ? ` for ${who}` : ""} on <span className="font-medium">{formatDateTime(when)}</span>? This cannot be
        undone; book a new visit if plans change again. The lead&apos;s status is not changed.
      </p>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Keep visit
        </Button>
        <Button variant="danger" busy={busy} onClick={() => void confirm()}>
          Cancel visit
        </Button>
      </div>
    </Modal>
  );
}

/** A lead's visits with Book / Reschedule / Cancel, for the lead page. */
export function LeadVisitsPanel({
  leadId,
  leadName,
  visits,
  canManage,
  onChanged,
}: {
  leadId: string;
  leadName: string;
  visits: SiteVisit[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<null | { kind: "book" } | { kind: "move" | "cancel"; visit: SiteVisit }>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sorted = [...visits].sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());
  const upcoming = sorted.find((v) => visitState(v) === "upcoming") ?? null;

  const done = (message: string) => {
    setDialog(null);
    setNotice(message);
    onChanged();
  };

  return (
    <div className="space-y-3">
      {sorted.length === 0 ? (
        <p className="text-sm text-stone-500">No site visit booked.</p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {sorted.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <div className="text-sm font-medium text-stone-900">{formatDateTime(v.scheduledAt)}</div>
                <div className="mt-1">
                  <VisitStateBadge visit={v} />
                </div>
              </div>
              {canManage && visitState(v) === "upcoming" && (
                <div className="flex gap-1">
                  <Button variant="ghost" onClick={() => setDialog({ kind: "move", visit: v })}>
                    Reschedule
                  </Button>
                  <Button variant="ghost" onClick={() => setDialog({ kind: "cancel", visit: v })}>
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && <Notice tone="success">{notice}</Notice>}
      {canManage && !upcoming && (
        <Button variant="secondary" onClick={() => setDialog({ kind: "book" })}>
          Book site visit
        </Button>
      )}

      {dialog?.kind === "book" && (
        <VisitTimeModal
          title={`Book a site visit for ${leadName}`}
          submitLabel="Book visit"
          onClose={() => setDialog(null)}
          onSubmit={async (iso) => {
            await api.bookSiteVisit(leadId, iso);
            done(`Visit booked for ${formatDateTime(iso)}.`);
          }}
        />
      )}
      {dialog?.kind === "move" && (
        <VisitTimeModal
          title="Reschedule site visit"
          submitLabel="Save new time"
          initial={dialog.visit.scheduledAt}
          onClose={() => setDialog(null)}
          onSubmit={async (iso) => {
            await api.rescheduleSiteVisit(dialog.visit.id, iso);
            done(`Visit moved to ${formatDateTime(iso)}.`);
          }}
        />
      )}
      {dialog?.kind === "cancel" && (
        <CancelVisitModal
          when={dialog.visit.scheduledAt}
          who={leadName}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.cancelSiteVisit(dialog.visit.id);
            done("Visit cancelled.");
          }}
        />
      )}
    </div>
  );
}
