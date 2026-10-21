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
    return (
      <Notice tone="error">
        This invitation link is incomplete — some mail clients cut long links. Open the link in your invitation email again, or ask an
        admin to resend the invitation.
      </Notice>
    );
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
      const message = errorMessage(err);
      // The API answers identically for an unknown, used, revoked or expired token (deliberately: a caller must not
      // be able to probe which tokens exist), so the page adds the one next step that fits all of them and nothing
      // that would distinguish them. An invitation lasts 7 days, so expiry is the likeliest of the four.
      const expired = /invalid or expired invitation/i.test(message);
      setError(expired ? `${message}. Ask an admin to resend your invitation.` : message);
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
