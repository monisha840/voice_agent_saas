"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demoEnabled, setDemoEnabled] = useState(false);
  // Second factor step: the password was accepted but the account has two-step verification.
  const [secondFactor, setSecondFactor] = useState(false);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((u) => {
        if (u.security?.mfaPending) setSecondFactor(true);
      })
      .catch(() => undefined);
    api
      .authConfig()
      .then((c) => setDemoEnabled(c.demoLoginEnabled))
      .catch(() => setDemoEnabled(false));
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      const result = (await action()) as { mfaRequired?: boolean } | undefined;
      if (result?.mfaRequired) {
        setSecondFactor(true);
        setBusy(false);
        return;
      }
      // The browser must actually have kept the session cookie; if it dropped it
      // (e.g. page and API opened on different hosts) say so instead of looping.
      await api.me().catch(() => {
        throw new Error(
          "Signed in, but the browser did not keep the session. Open this page at http://127.0.0.1:3000 (or use the same host for the web app and API) and try again.",
        );
      });
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError || (err instanceof Error && err.message.startsWith("Signed in"))
          ? err.message
          : "Unable to reach the server. Please check that the backend is running.",
      );
      setBusy(false);
    }
  }

  if (secondFactor) {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.mfaVerify(useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() }));
        }}
      >
        <p className="text-sm text-stone-600">
          {useRecovery
            ? "Enter one of your recovery codes. Each can be used once."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-stone-700">{useRecovery ? "Recovery code" : "Verification code"}</span>
          <input
            required
            autoFocus
            inputMode={useRecovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
          />
        </label>
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60"
        >
          {busy ? "Verifying…" : "Verify"}
        </button>
        <button
          type="button"
          onClick={() => {
            setUseRecovery((r) => !r);
            setCode("");
            setError(null);
          }}
          className="w-full text-center text-sm text-stone-600 underline"
        >
          {useRecovery ? "Use my authenticator app instead" : "Use a recovery code instead"}
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.login(email, password));
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-stone-700">Email</span>
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="font-medium text-stone-700">Password</span>
            {/* The only way back in for a locked-out customer. Carries the address already typed, so the reset
                page does not ask for it twice; it reveals nothing, since that page answers identically for every
                address. */}
            <Link
              href={email.trim() ? `/forgot-password?email=${encodeURIComponent(email.trim())}` : "/forgot-password"}
              className="text-xs text-stone-500 underline hover:text-stone-700"
            >
              Forgot your password?
            </Link>
          </div>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
          />
        </label>
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {demoEnabled && (
        <div className="border-t border-stone-200 pt-4">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.demoLogin())}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-100 disabled:opacity-60"
          >
            Continue as demo user
          </button>
          <p className="mt-2 text-center text-xs text-stone-500">Development only — not available in production.</p>
        </div>
      )}
    </div>
  );
}
