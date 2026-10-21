"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { OrganizationModule } from "@/lib/types";
import { ORG_MODULES_CHANGED_EVENT } from "@/lib/modules";
import { Badge, Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";

export function SettingsClient({
  initialName,
  initialModules,
  canManage,
}: {
  initialName: string;
  initialModules: OrganizationModule[];
  /** Only the organization owner can rename the organization or switch modules (the API enforces it). */
  canManage: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [modules, setModules] = useState(initialModules);
  const [moduleBusy, setModuleBusy] = useState<string | null>(null);
  const [moduleError, setModuleError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const org = await api.renameOrganization(name.trim());
      setName(org.name);
      setNotice("Organization renamed.");
      router.refresh(); // header shows the organization name
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleModule(m: OrganizationModule) {
    setModuleBusy(m.key);
    setModuleError(null);
    try {
      const updated = await api.setModuleEnabled(m.key, !m.enabled);
      setModules((prev) => prev.map((x) => (x.key === updated.key ? updated : x)));
      window.dispatchEvent(new Event(ORG_MODULES_CHANGED_EVENT)); // the client-side navigation reloads /auth/me
      router.refresh(); // server-rendered pages pick up the new state
    } catch (err) {
      setModuleError(errorMessage(err));
    } finally {
      setModuleBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card title="Organization">
        <form onSubmit={(e) => void submit(e)} className="max-w-md space-y-4">
          <Field label="Organization name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage}
              className={inputClass}
            />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          {notice && !error && <Notice tone="success">{notice}</Notice>}
          {canManage && (
            <Button type="submit" busy={busy} disabled={name.trim() === initialName}>
              Save
            </Button>
          )}
        </form>
      </Card>

      <Card title="Modules">
        <p className="mb-4 text-sm text-stone-500">
          Optional feature packs on top of the Voice AI core. Turning a module off hides its pages and blocks its API for
          your team; its data is kept and comes back when you turn it on again.
        </p>
        <ul className="divide-y divide-stone-100">
          {modules.map((m) => (
            <li key={m.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-stone-900">
                  {m.label}
                  <Badge tone={m.enabled ? "success" : "neutral"}>{m.enabled ? "Enabled" : "Disabled"}</Badge>
                </div>
                <div className="mt-0.5 text-sm text-stone-500">{m.description}</div>
              </div>
              {canManage && (
                <Button variant="secondary" busy={moduleBusy === m.key} onClick={() => void toggleModule(m)}>
                  {m.enabled ? "Disable" : "Enable"}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {moduleError && (
          <div className="mt-3">
            <Notice tone="error">{moduleError}</Notice>
          </div>
        )}
        {!canManage && (
          <div className="mt-3">
            <Notice tone="info">Only the organization owner can change modules.</Notice>
          </div>
        )}
      </Card>
    </div>
  );
}
