"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button, Notice, errorMessage } from "@/components/ui";

type State =
  | { phase: "working" }
  | { phase: "done"; email: string }
  | { phase: "failed"; message: string }
  | { phase: "missing" };

/**
 * Confirms an e-mail address from the link in the verification mail.
 *
 * The confirmation is a POST, so it cannot be driven by the page load alone being a GET - the click on the e-mail
 * link lands here and this component makes the call once. The guard ref matters: React's development double-render
 * would otherwise fire it twice, and the token is single-use, so the second call would legitimately be refused and
 * the user would see a failure for a verification that actually succeeded.
 *
 * Signing in is NOT required to confirm: the token is the credential, and a user who has just been invited may not
 * have a session in this browser.
 */
export function VerifyEmailClient({ token }: { token: string }) {
  const [state, setState] = useState<State>(token ? { phase: "working" } : { phase: "missing" });
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api
      .confirmEmailVerification(token)
      .then((r) => setState({ phase: "done", email: r.email }))
      .catch((err) => setState({ phase: "failed", message: errorMessage(err) }));
  }, [token]);

  async function resend() {
    setResending(true);
    setResent(null);
    try {
      const r = await api.sendEmailVerification();
      setResent(
        r.alreadyVerified
          ? `${r.email} is already confirmed.`
          : `A new confirmation link is on its way to ${r.email}.`,
      );
    } catch (err) {
      setResent(errorMessage(err));
    } finally {
      setResending(false);
    }
  }

  if (state.phase === "missing") {
    return (
      <div className="space-y-4">
        <Notice tone="error">This confirmation link is missing its token.</Notice>
        <p className="text-sm text-stone-600">Sign in and ask for a new one from your account security page.</p>
        <Link
          href="/login"
          className="block rounded-md bg-emerald-700 px-3 py-2 text-center text-sm font-medium text-white hover:bg-emerald-800"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  if (state.phase === "working") {
    return <Notice tone="info">Confirming your address…</Notice>;
  }

  if (state.phase === "done") {
    return (
      <div className="space-y-4">
        <Notice tone="success">{state.email} is confirmed. Thank you.</Notice>
        <Link
          href="/"
          className="block rounded-md bg-emerald-700 px-3 py-2 text-center text-sm font-medium text-white hover:bg-emerald-800"
        >
          Continue
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Notice tone="error">{state.message}</Notice>
      <p className="text-sm text-stone-600">
        A confirmation link works once and expires after a day. If you are signed in, you can send yourself a new
        one.
      </p>
      {resent && <Notice tone="info">{resent}</Notice>}
      <Button variant="secondary" busy={resending} className="w-full" onClick={() => void resend()}>
        {resending ? "Sending…" : "Send a new link"}
      </Button>
      <Link href="/login" className="block text-center text-sm text-stone-600 underline">
        Back to sign in
      </Link>
    </div>
  );
}
