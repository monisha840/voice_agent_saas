"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { createNumbersApi, formatWhen, STATE_LABEL, type PhoneNumberView, type ProviderSetup } from "@/lib/numbers";
import { Badge, Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";
import { EmptyState } from "@/components/StateViews";

const numbersApi = createNumbersApi();

export function ProviderStatus({ provider }: { provider: ProviderSetup }) {
  if (provider.simulated) {
    return (
      <Notice tone="info">
        Simulated telephony: this environment does not receive real calls. Numbers and routing can be set up and tested, but
        no caller can reach them here.
      </Notice>
    );
  }
  if (!provider.configured) {
    return (
      <Notice tone="error">
        The {provider.provider} connection is not fully set up
        {provider.missing.length > 0 ? ` (missing: ${provider.missing.join(", ")})` : ""}
        {provider.problems.length > 0 ? `. ${provider.problems.join(" ")}` : ""}. Calls cannot reach your agents until support
        completes it.
      </Notice>
    );
  }
  return (
    <Notice tone="success">
      Connected to {provider.provider}. Each number must also have an incoming-call flow pointing at this platform; use
      &ldquo;Check connection&rdquo; on a number to confirm.
    </Notice>
  );
}

export function NumbersClient({
  provider,
  numbers,
  agents,
  canManage,
}: {
  provider: ProviderSetup;
  numbers: PhoneNumberView[];
  agents: Array<{ id: string; name: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!phone.trim()) return setError("Enter the number in international format, for example +918012345678.");
    if (!agentId) return setError("Choose the agent that should answer this number.");
    setBusy(true);
    setError(null);
    try {
      const n = await numbersApi.add({ phoneNumber: phone.trim(), agentId, label: label.trim() || null });
      router.push(`/numbers/${n.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <ProviderStatus provider={provider} />

      {adding && (
        <Card title="Add a number">
          <div className="space-y-4">
            <Field label="Phone number" hint="The number callers dial (your ExoPhone), in international format.">
              <input className={inputClass} value={phone} maxLength={32} onChange={(e) => setPhone(e.target.value)} placeholder="+918012345678" autoFocus />
            </Field>
            <Field label="Answering agent">
              <select className={inputClass} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Label" hint="Optional, for your team, e.g. “Main line”.">
              <input className={inputClass} value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            {agents.length === 0 && <Notice tone="error">Create or unarchive an agent first.</Notice>}
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex gap-2">
              <Button busy={busy} onClick={() => void add()} disabled={agents.length === 0}>
                Add number
              </Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card
        title={`${numbers.length} number${numbers.length === 1 ? "" : "s"}`}
        action={
          canManage && !adding ? (
            <Button onClick={() => setAdding(true)}>
              <Plus size={14} />
              Add number
            </Button>
          ) : undefined
        }
      >
        {numbers.length === 0 ? (
          <EmptyState
            title="No phone numbers yet"
            description={canManage ? "Add the number your callers dial and choose the agent that answers it." : "Ask an admin to add your phone numbers."}
          />
        ) : (
          <ul className="-my-2 divide-y divide-stone-100">
            {numbers.map((n) => (
              <li key={n.id}>
                <Link href={`/numbers/${n.id}`} className="block py-3 text-sm hover:bg-stone-50">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-stone-900">
                      {n.phoneNumber}
                      {n.label && <span className="ml-2 font-normal text-stone-500">{n.label}</span>}
                    </span>
                    <Badge tone={STATE_LABEL[n.state].tone}>{STATE_LABEL[n.state].text}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                    <span>Agent: {n.agent.name}</span>
                    <span>
                      {n.calls.total} call{n.calls.total === 1 ? "" : "s"} in {n.calls.windowDays} days
                      {n.calls.failed > 0 ? ` · ${n.calls.failed} failed` : ""}
                    </span>
                    {n.refused.count > 0 && <span className="text-amber-700">{n.refused.count} refused</span>}
                    <span>Last call: {formatWhen(n.lastInboundAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
