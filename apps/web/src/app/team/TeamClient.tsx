"use client";

import { useState } from "react";
import { Check, Copy, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { can, canManageMember, grantableRoles } from "@/lib/permissions";
import type { Invitation, Role, TeamMember } from "@/lib/types";
import { Badge, Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";

export function TeamClient({
  initialUsers,
  initialInvitations,
  role,
  selfId,
}: {
  initialUsers: TeamMember[];
  initialInvitations: Invitation[];
  role: Role | null;
  selfId: string;
}) {
  const [users, setUsers] = useState(initialUsers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const manage = can(role, "users:manage");

  async function guard(id: string, action: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  const changeRole = (u: TeamMember, next: Role) =>
    guard(u.userId, async () => {
      await api.changeRole(u.userId, next);
      setUsers((prev) => prev.map((x) => (x.userId === u.userId ? { ...x, role: next } : x)));
    });

  const remove = (u: TeamMember) => {
    if (!window.confirm(`Remove ${u.name} from this organization?`)) return Promise.resolve();
    return guard(u.userId, async () => {
      await api.removeUser(u.userId);
      setUsers((prev) => prev.filter((x) => x.userId !== u.userId));
    });
  };

  const revoke = (inv: Invitation) =>
    guard(inv.id, async () => {
      await api.revokeInvitation(inv.id);
      setInvitations((prev) => prev.filter((x) => x.id !== inv.id));
    });

  return (
    <div className="space-y-6">
      {error && <Notice tone="error">{error}</Notice>}

      <Card title={`Members (${users.length})`}>
        <div className="-mx-5 -my-5 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-400">
              <tr>
                <th className="px-5 py-3 font-medium">Member</th>
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-5 py-3 font-medium">Status</th>
                {manage && <th className="px-5 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {users.map((u) => {
                const editable = manage && u.userId !== selfId && canManageMember(role, u.role);
                // Role choices always include the member's current role so the select renders it.
                const options = Array.from(new Set([u.role, ...grantableRoles(role)]));
                return (
                  <tr key={u.userId}>
                    <td className="px-5 py-3">
                      <div className="font-medium text-stone-900">
                        {u.name}
                        {u.userId === selfId && <span className="ml-1 text-xs font-normal text-stone-400">(you)</span>}
                      </div>
                      <div className="text-xs text-stone-500">{u.email}</div>
                    </td>
                    <td className="px-5 py-3">
                      {editable ? (
                        <select
                          value={u.role}
                          disabled={busyId === u.userId}
                          onChange={(e) => void changeRole(u, e.target.value as Role)}
                          aria-label={`Role for ${u.name}`}
                          className="rounded-md border border-stone-300 px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
                        >
                          {options.map((r) => (
                            <option key={r} value={r} disabled={!grantableRoles(role).includes(r)}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge>{u.role}</Badge>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={u.isActive ? "success" : "neutral"}>{u.isActive ? "Active" : "Inactive"}</Badge>
                    </td>
                    {manage && (
                      <td className="px-5 py-3 text-right">
                        {editable && (
                          <Button variant="danger" disabled={busyId === u.userId} onClick={() => void remove(u)}>
                            Remove
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {manage && (
        <>
          <InviteCard
            role={role}
            onInvited={(inv) => setInvitations((prev) => [inv, ...prev.filter((x) => x.id !== inv.id)])}
          />
          <Card title={`Pending invitations (${invitations.length})`}>
            {invitations.length === 0 ? (
              <p className="text-sm text-stone-500">No pending invitations.</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {invitations.map((inv) => (
                  <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                    <div>
                      <div className="font-medium text-stone-900">{inv.email}</div>
                      <div className="text-xs text-stone-500">
                        {inv.role} · expires {new Date(inv.expiresAt).toLocaleDateString("en-IN")}
                      </div>
                    </div>
                    <Button variant="secondary" disabled={busyId === inv.id} onClick={() => void revoke(inv)}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function InviteCard({ role, onInvited }: { role: Role | null; onInvited: (inv: Invitation) => void }) {
  const roles = grantableRoles(role);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>(roles.includes("AGENT") ? "AGENT" : roles[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    setCopied(false);
    try {
      const res = await api.inviteUser(email.trim(), inviteRole);
      // The token is only returned once, so build the shareable link now.
      setLink(`${window.location.origin}${res.acceptPath}`);
      onInvited(res.invitation);
      setEmail("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError("Could not copy automatically. Select the link and copy it manually.");
    }
  }

  return (
    <Card title="Invite a teammate">
      <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <Field label="Email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Role">
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} className={inputClass}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" busy={busy}>
          <UserPlus size={14} />
          Create invite
        </Button>
      </form>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {link && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-sm font-medium text-emerald-900">Invitation link created</div>
          <p className="mt-1 text-xs text-emerald-800">
            This link is shown only once, and no email is sent. Copy it and send it to the invitee yourself.
          </p>
          <div className="mt-3 flex gap-2">
            <input readOnly value={link} onFocus={(e) => e.target.select()} className={`${inputClass} font-mono text-xs`} />
            <Button variant="secondary" onClick={() => void copy()}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
