"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, CircleSlash, AlertTriangle, XCircle } from "lucide-react";
import {
  createNumbersApi,
  formatWhen,
  REFUSAL_REASONS,
  STATE_LABEL,
  type CheckResult,
  type LineCall,
  type PhoneNumberDetail,
} from "@/lib/numbers";
import { Badge, Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";
import { CallStatusBadge } from "@/components/CallStatusBadge";
import { ProviderStatus } from "../NumbersClient";

const numbersApi = createNumbersApi();

const STEP_ICON = {
  pass: <CheckCircle2 size={16} className="text-emerald-600" />,
  warn: <AlertTriangle size={16} className="text-amber-600" />,
  fail: <XCircle size={16} className="text-red-600" />,
  skip: <CircleSlash size={16} className="text-stone-400" />,
};

function CallList({ rows, empty }: { rows: LineCall[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-stone-500">{empty}</p>;
  return (
    <ul className="-my-2 divide-y divide-stone-100">
      {rows.map((c) => (
        <li key={c.id}>
          <Link href={`/calls/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm hover:bg-stone-50">
            <span className="text-stone-800">
              {c.counterpartyNumber ?? "Unknown caller"} <span className="text-stone-500">→ {c.agentName}</span>
            </span>
            <span className="flex items-center gap-3 text-xs text-stone-500">
              {formatWhen(c.createdAt)}
              <CallStatusBadge status={c.status} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function NumberDetailClient({
  initial,
  agents,
  canManage,
}: {
  initial: PhoneNumberDetail;
  agents: Array<{ id: string; name: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [n, setN] = useState(initial);
  const [label, setLabel] = useState(initial.label ?? "");
  const [agentId, setAgentId] = useState(initial.agent.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const agentOptions = agents.some((a) => a.id === n.agent.id) ? agents : [{ id: n.agent.id, name: `${n.agent.name} (archived)` }, ...agents];

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const liveNote = n.calls.live > 0 ? ` ${n.calls.live} call(s) in progress will finish normally.` : "";

  const saveLabel = () =>
    run("label", async () => {
      setN(await numbersApi.update(n.id, { label: label.trim() || null }));
      setNotice("Label saved.");
    });

  const reassign = () =>
    run("agent", async () => {
      if (agentId === n.agent.id) return;
      const target = agents.find((a) => a.id === agentId)?.name ?? "the selected agent";
      if (n.routingEnabled && !window.confirm(`New calls to ${n.phoneNumber} will be answered by "${target}" instead of "${n.agent.name}".${liveNote} Continue?`)) {
        setAgentId(n.agent.id);
        return;
      }
      setN(await numbersApi.update(n.id, { agentId, expectedAgentId: n.agent.id, confirm: true }));
      setNotice(`Calls to ${n.phoneNumber} now go to "${target}".`);
    });

  const toggleRouting = () =>
    run("routing", async () => {
      if (n.routingEnabled) {
        if (!window.confirm(`Pause ${n.phoneNumber}? New calls to it will be refused until you resume it.${liveNote}`)) return;
        setN(await numbersApi.update(n.id, { routingEnabled: false, confirm: true }));
        setNotice("Paused. Calls to this number are refused.");
      } else {
        setN(await numbersApi.update(n.id, { routingEnabled: true }));
        setNotice("Resumed. Calls to this number are answered again.");
      }
    });

  const remove = () =>
    run("remove", async () => {
      if (!window.confirm(`Remove ${n.phoneNumber}? Calls to it will no longer reach any agent. Its call history is kept.`)) return;
      await numbersApi.remove(n.id);
      router.push("/numbers");
      router.refresh();
    });

  const runCheck = () =>
    run("check", async () => {
      const result = await numbersApi.check(n.id);
      setCheck(result);
      setN(result.number);
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">{n.phoneNumber}</h1>
          {n.label && <p className="text-sm text-stone-500">{n.label}</p>}
        </div>
        <Badge tone={STATE_LABEL[n.state].tone}>{STATE_LABEL[n.state].text}</Badge>
      </div>

      <ProviderStatus provider={n.setup} />
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}
      {n.state === "agent_inactive" && <Notice tone="error">The answering agent is archived, so calls are refused. Choose an active agent below.</Notice>}

      <Card title="Routing">
        <div className="space-y-4 text-sm">
          {canManage ? (
            <>
              <Field label="Answering agent">
                <div className="flex gap-2">
                  <select className={inputClass} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                    {agentOptions.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <Button variant="secondary" busy={busy === "agent"} disabled={agentId === n.agent.id} onClick={() => void reassign()}>
                    Change agent
                  </Button>
                </div>
              </Field>
              <Field label="Label">
                <div className="flex gap-2">
                  <input className={inputClass} value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
                  <Button variant="secondary" busy={busy === "label"} disabled={label === (n.label ?? "")} onClick={() => void saveLabel()}>
                    Save label
                  </Button>
                </div>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant={n.routingEnabled ? "secondary" : "primary"} busy={busy === "routing"} onClick={() => void toggleRouting()}>
                  {n.routingEnabled ? "Pause routing" : "Resume routing"}
                </Button>
                <Button variant="danger" busy={busy === "remove"} onClick={() => void remove()}>
                  Remove number
                </Button>
              </div>
            </>
          ) : (
            <p>
              Answered by <span className="font-medium">{n.agent.name}</span>. Ask an admin to change routing.
            </p>
          )}
          <dl className="grid grid-cols-1 gap-2 text-xs text-stone-600 sm:grid-cols-3">
            <div>
              <dt className="text-stone-500">Last answered call</dt>
              <dd>{formatWhen(n.lastInboundAt)}</dd>
            </div>
            <div>
              <dt className="text-stone-500">Refused attempts</dt>
              <dd>
                {n.refused.count}
                {n.refused.lastAt && ` · last ${formatWhen(n.refused.lastAt)} (${REFUSAL_REASONS[n.refused.lastReason ?? ""] ?? n.refused.lastReason})`}
              </dd>
            </div>
            <div>
              <dt className="text-stone-500">Calls in {n.calls.windowDays} days</dt>
              <dd>
                {n.calls.total} · {n.calls.failed} failed · {n.calls.live} in progress
              </dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card
        title="Connection check"
        action={
          canManage ? (
            <Button variant="secondary" busy={busy === "check"} onClick={() => void runCheck()}>
              Check connection
            </Button>
          ) : undefined
        }
      >
        <div className="space-y-3 text-sm">
          {n.provider.checkedAt && (
            <p className="text-xs text-stone-500">
              Provider check {formatWhen(n.provider.checkedAt)}: {n.provider.detail}
            </p>
          )}
          {check ? (
            <ul className="space-y-2" aria-label="Check results">
              {check.steps.map((s) => (
                <li key={s.key} className="flex items-start gap-2">
                  <span className="mt-0.5">{STEP_ICON[s.status]}</span>
                  <span>
                    <span className="font-medium text-stone-800">{s.label}</span>
                    <span className="block text-xs text-stone-600">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-stone-500">
              Runs the inbound routing for this number (without placing a call) and, where the provider supports it, confirms the
              number on the provider account.
            </p>
          )}
        </div>
      </Card>

      <Card title="Recent failed calls">
        <CallList rows={n.recentFailures} empty="No failed calls on this number." />
      </Card>
      <Card title="Recent calls">
        <CallList rows={n.recentCalls} empty="No calls on this number yet." />
      </Card>
    </div>
  );
}
