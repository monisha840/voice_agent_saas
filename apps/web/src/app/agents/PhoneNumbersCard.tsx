"use client";

import { useEffect, useState } from "react";
import { Phone, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { AgentPhoneNumber } from "@/lib/types";
import { Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";
import { EmptyState, LoadingState } from "@/components/StateViews";

/**
 * The numbers an agent answers. These are routing records: they tell the platform which agent should pick up when
 * a call arrives on that number. The number itself must already be set up with your telephony provider and pointed
 * at this server's inbound webhook. Works for every agent, with or without any optional module.
 */
export function PhoneNumbersCard({ agentId, canManage }: { agentId: string; canManage: boolean }) {
  const [numbers, setNumbers] = useState<AgentPhoneNumber[] | null>(null);
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listAgentPhoneNumbers(agentId)
      .then((rows) => !cancelled && setNumbers(rows))
      .catch((err) => {
        if (cancelled) return;
        setNumbers([]);
        setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function add() {
    if (!phone.trim()) {
      setError("Enter a phone number in international format, for example +918012345678.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const row = await api.addAgentPhoneNumber(agentId, { phoneNumber: phone.trim(), label: label.trim() || null });
      setNumbers((rows) => [...(rows ?? []), row]);
      setPhone("");
      setLabel("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: AgentPhoneNumber) {
    if (!window.confirm(`Stop this agent answering ${row.phoneNumber}? Calls to it will no longer be picked up.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeAgentPhoneNumber(agentId, row.id);
      setNumbers((rows) => (rows ?? []).filter((r) => r.id !== row.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Inbound phone numbers">
      <div className="space-y-4">
        <p className="text-sm text-stone-500">
          When a call arrives on one of these numbers, this agent answers it. A number can belong to only one agent.
        </p>
        {error && <Notice tone="error">{error}</Notice>}

        {numbers === null ? (
          <LoadingState label="Loading numbers…" />
        ) : numbers.length === 0 ? (
          <EmptyState title="No numbers yet" description="This agent does not answer any inbound calls." />
        ) : (
          <ul className="divide-y divide-stone-100 rounded-md border border-stone-200">
            {numbers.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="flex items-center gap-2">
                  <Phone size={14} className="text-stone-400" />
                  <span className="font-medium text-stone-900">{n.phoneNumber}</span>
                  {n.label && <span className="text-stone-500">{n.label}</span>}
                </span>
                {canManage && (
                  <Button variant="ghost" disabled={busy} onClick={() => void remove(n)} aria-label={`Remove ${n.phoneNumber}`}>
                    <Trash2 size={14} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="Phone number" hint="International format, e.g. +918012345678">
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Label (optional)">
              <input value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
            </Field>
            <Button busy={busy} onClick={() => void add()}>
              Add number
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
