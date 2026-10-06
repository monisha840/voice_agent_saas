"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button, Field, Notice, errorMessage, inputClass } from "@/components/ui";

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return <Notice tone="error">This invitation link is missing its token. Ask your admin for a new link.</Notice>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) return setError("Password must be at least 10 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      await api.acceptInvite(token, name.trim(), password);
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <Field label="Your name">
        <input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={inputClass} />
      </Field>
      <Field label="Password" hint="At least 10 characters.">
        <input
          type="password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      <Field label="Confirm password">
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" busy={busy} className="w-full">
        {busy ? "Creating account…" : "Accept invitation"}
      </Button>
    </form>
  );
}
