"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button, Field, Notice, errorMessage, inputClass } from "@/components/ui";

/**
 * "Forgot password", step 2: the token from the e-mail plus a new password.
 *
 * Two shapes follow from the API's behaviour and are deliberate:
 *  - a bad, expired or already-used link all come back with one identical message, so this form does not try to
 *    explain which it was; it just offers a fresh link;
 *  - a successful reset signs the user in, but if the account has two-step verification the session is pending and
 *    the second factor still has to be passed, so the user is sent to the sign-in page to complete it rather than
 *    into the app (which would bounce them straight back out).
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);

  if (!token) {
    return (
      <div className="space-y-4">
        <Notice tone="error">This reset link is missing its token. Request a new one.</Notice>
        <Link
          href="/forgot-password"
          className="block rounded-md bg-emerald-700 px-3 py-2 text-center text-sm font-medium text-white hover:bg-emerald-800"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  if (mfaRequired) {
    return (
      <div className="space-y-4">
        <Notice tone="success">Your password has been changed and every other device has been signed out.</Notice>
        <p className="text-sm text-stone-600">
          This account uses two-step verification, so one more step is needed: sign in with your authenticator app
          or one of your recovery codes. A password reset on its own never unlocks an account with two-step
          verification.
        </p>
        <Link
          href="/login"
          className="block rounded-md bg-emerald-700 px-3 py-2 text-center text-sm font-medium text-white hover:bg-emerald-800"
        >
          Continue to verification
        </Link>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) return setError("Password must be at least 10 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      const result = await api.resetPassword(token, password);
      if (result.mfaRequired) {
        setMfaRequired(true);
        setBusy(false);
        return;
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <p className="text-sm text-stone-600">
        Choose a new password. This signs you out of every device that is currently signed in.
      </p>
      <Field label="New password" hint="At least 10 characters. Avoid anything you use elsewhere.">
        <input
          type="password"
          required
          autoFocus
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className={inputClass}
        />
      </Field>
      <Field label="Confirm new password">
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
        {busy ? "Saving…" : "Set new password"}
      </Button>
      <Link href="/forgot-password" className="block text-center text-sm text-stone-600 underline">
        Request a new link
      </Link>
    </form>
  );
}
