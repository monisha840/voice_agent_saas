"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Button, Field, Notice, inputClass } from "@/components/ui";

/**
 * "Forgot password", step 1.
 *
 * The API answers identically whether or not the address has an account - that is its central security property -
 * so this form must never say "no account with that address", must not shape itself around a lookup, and must show
 * the SAME confirmation in every successful case. The only error it can show is a transport failure or a rate
 * limit, neither of which depends on whether the account exists.
 */
export function ForgotPasswordForm({ initialEmail }: { initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      // A 429 is the one meaningful failure: too many requests from this address or this network.
      setError(
        err instanceof ApiError
          ? err.message
          : "Unable to reach the server. Please check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <Notice tone="success">
          If an account uses that address, a reset link is on its way. Check your inbox - and your spam folder.
        </Notice>
        <p className="text-sm text-stone-600">
          The link works once and expires in an hour. Choosing a new password signs you out of every other device.
        </p>
        <div className="flex flex-col gap-2">
          <Button variant="secondary" className="w-full" onClick={() => setSent(false)}>
            Use a different address
          </Button>
          <Link href="/login" className="text-center text-sm text-stone-600 underline">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <p className="text-sm text-stone-600">
        Enter the address you sign in with. We will e-mail you a link to choose a new password.
      </p>
      <Field label="Email">
        <input
          type="email"
          required
          autoFocus
          maxLength={320}
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" busy={busy} className="w-full">
        {busy ? "Sending…" : "Send reset link"}
      </Button>
      <Link href="/login" className="block text-center text-sm text-stone-600 underline">
        Back to sign in
      </Link>
    </form>
  );
}
