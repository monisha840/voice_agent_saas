"use client";

import { useCallback, useEffect, useState } from "react";
import { Laptop, ShieldCheck, ShieldAlert } from "lucide-react";
import { api, ApiError, type MfaStatus, type SessionInfo } from "@/lib/api";
import { Badge, Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";

/** Re-authentication prompt state: sensitive actions retry after the password is confirmed. */
type Pending = { run: () => Promise<void> } | null;

export function AccountSecurityClient() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [reauth, setReauth] = useState<Pending>(null);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api.listSessions(), api.mfaStatus()]);
      setSessions(s);
      setMfa(m);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a sensitive action; if the server asks for the password again, prompts and retries once. */
  async function sensitive(action: () => Promise<void>) {
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.code === "REAUTH_REQUIRED") {
        setReauth({ run: action });
        return;
      }
      setNotice({ tone: "error", text: errorMessage(err) });
    }
  }

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!sessions || !mfa) return <p className="text-sm text-stone-500">Loading…</p>;

  return (
    <div className="space-y-6">
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {reauth && (
        <ReauthPrompt
          onCancel={() => setReauth(null)}
          onConfirmed={async () => {
            const pending = reauth;
            setReauth(null);
            await sensitive(pending.run);
          }}
        />
      )}
      <MfaCard mfa={mfa} sensitive={sensitive} onChanged={load} setNotice={setNotice} />
      <PasswordCard setNotice={setNotice} onChanged={load} />
      <SessionsCard sessions={sessions} onChanged={load} setNotice={setNotice} />
    </div>
  );
}

function ReauthPrompt({ onCancel, onConfirmed }: { onCancel: () => void; onConfirmed: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Confirm your password">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.reauthenticate(password);
            await onConfirmed();
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-stone-600">For your security, please enter your password to continue.</p>
        <Field label="Password" error={error}>
          <input type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" busy={busy}>Confirm</Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function MfaCard({
  mfa,
  sensitive,
  onChanged,
  setNotice,
}: {
  mfa: MfaStatus;
  sensitive: (a: () => Promise<void>) => Promise<void>;
  onChanged: () => Promise<void>;
  setNotice: (n: { tone: "success" | "error"; text: string } | null) => void;
}) {
  const [enrol, setEnrol] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [regenCode, setRegenCode] = useState("");
  const [showRegen, setShowRegen] = useState(false);

  async function start() {
    setBusy(true);
    await sensitive(async () => {
      const r = await api.mfaEnroll();
      setEnrol({ secret: r.secret, qrDataUrl: r.qrDataUrl });
    });
    setBusy(false);
  }

  async function confirm() {
    setBusy(true);
    await sensitive(async () => {
      const r = await api.mfaConfirm(code.trim());
      setRecoveryCodes(r.recoveryCodes);
      setEnrol(null);
      setCode("");
      setNotice({ tone: "success", text: "Two-step verification is on. Your other devices were signed out." });
      await onChanged();
    });
    setBusy(false);
  }

  return (
    <Card
      title="Two-step verification"
      action={mfa.enabled ? <Badge tone="success">On</Badge> : <Badge tone={mfa.enforcement === "enforce" ? "error" : "warn"}>Off</Badge>}
    >
      <div className="space-y-4 text-sm text-stone-700">
        {recoveryCodes && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-4" role="alert">
            <p className="font-medium text-amber-900">Save these recovery codes now</p>
            <p className="mt-1 text-amber-800">
              Each works once if you lose your authenticator. They are shown only this one time.
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button className="mt-3" variant="secondary" onClick={() => setRecoveryCodes(null)}>
              I have saved them
            </Button>
          </div>
        )}

        {!mfa.enabled && !enrol && (
          <>
            <p className="flex items-start gap-2">
              <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
              Add a second step to sign-in using an authenticator app (Google Authenticator, Microsoft Authenticator,
              1Password, Authy).
              {mfa.enforcement === "enforce" && " Your role requires it before you can continue."}
            </p>
            <Button busy={busy} onClick={() => void start()}>Set up two-step verification</Button>
          </>
        )}

        {enrol && (
          <div className="space-y-3">
            <p>1. Scan this QR code with your authenticator app.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrol.qrDataUrl} alt="QR code to add this account to your authenticator app" width={180} height={180} className="rounded border border-stone-200" />
            <p className="text-stone-600">
              Cannot scan? Enter this key manually: <code className="break-all rounded bg-stone-100 px-1.5 py-0.5">{enrol.secret}</code>
            </p>
            <p>2. Enter the 6-digit code it shows.</p>
            <div className="flex max-w-xs gap-2">
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="6-digit code"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={inputClass}
                placeholder="123456"
              />
              <Button busy={busy} onClick={() => void confirm()} disabled={code.trim().length < 6}>Verify</Button>
            </div>
          </div>
        )}

        {mfa.enabled && (
          <>
            <p className="flex items-start gap-2">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-600" />
              Sign-in requires a code from your authenticator app. Recovery codes left: <strong>{mfa.recoveryCodesRemaining}</strong>.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setShowRegen((s) => !s)}>New recovery codes</Button>
              <Button variant="danger" onClick={() => setShowDisable((s) => !s)}>Turn off</Button>
            </div>
            {showRegen && (
              <form
                className="flex max-w-sm items-end gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  await sensitive(async () => {
                    const r = await api.mfaRecoveryCodes(regenCode.trim());
                    setRecoveryCodes(r.recoveryCodes);
                    setShowRegen(false);
                    setRegenCode("");
                    await onChanged();
                  });
                  setBusy(false);
                }}
              >
                <Field label="Code from your authenticator" className="flex-1">
                  <input value={regenCode} onChange={(e) => setRegenCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" className={inputClass} />
                </Field>
                <Button type="submit" busy={busy}>Generate</Button>
              </form>
            )}
            {showDisable && (
              <form
                className="max-w-sm space-y-3 rounded-md border border-red-200 p-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    await api.mfaDisable(disablePassword, disableCode.trim());
                    setShowDisable(false);
                    setDisablePassword("");
                    setDisableCode("");
                    setNotice({ tone: "success", text: "Two-step verification is off. Your other devices were signed out." });
                    await onChanged();
                  } catch (err) {
                    setNotice({ tone: "error", text: errorMessage(err) });
                  }
                  setBusy(false);
                }}
              >
                <p className="text-red-700">Turning this off makes your account easier to take over.</p>
                <Field label="Password">
                  <input type="password" autoComplete="current-password" required value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Authenticator code">
                  <input required inputMode="numeric" autoComplete="one-time-code" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} className={inputClass} />
                </Field>
                <Button type="submit" variant="danger" busy={busy}>Turn off two-step verification</Button>
              </form>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function PasswordCard({
  setNotice,
  onChanged,
}: {
  setNotice: (n: { tone: "success" | "error"; text: string } | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Password">
      <form
        className="max-w-sm space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await api.changePassword(current, next);
            setCurrent("");
            setNext("");
            setNotice({
              tone: "success",
              text: r.otherSessionsRevoked > 0
                ? `Password changed. ${r.otherSessionsRevoked} other session(s) were signed out.`
                : "Password changed.",
            });
            await onChanged();
          } catch (err) {
            setNotice({ tone: "error", text: errorMessage(err) });
          }
          setBusy(false);
        }}
      >
        <Field label="Current password">
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={inputClass} />
        </Field>
        <Field label="New password" hint="At least 10 characters. A long, unique passphrase is best.">
          <input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} className={inputClass} />
        </Field>
        <Button type="submit" busy={busy}>Change password</Button>
        <p className="text-xs text-stone-500">Changing your password signs you out everywhere else.</p>
      </form>
    </Card>
  );
}

function SessionsCard({
  sessions,
  onChanged,
  setNotice,
}: {
  sessions: SessionInfo[];
  onChanged: () => Promise<void>;
  setNotice: (n: { tone: "success" | "error"; text: string } | null) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const others = sessions.filter((s) => !s.current).length;

  async function revoke(id: string) {
    setBusyId(id);
    try {
      await api.revokeSession(id);
      setNotice({ tone: "success", text: "That device was signed out." });
      await onChanged();
    } catch (err) {
      setNotice({ tone: "error", text: errorMessage(err) });
    }
    setBusyId(null);
  }

  return (
    <Card
      title="Where you are signed in"
      action={
        others > 0 ? (
          <Button
            variant="secondary"
            busy={busyId === "others"}
            onClick={async () => {
              setBusyId("others");
              try {
                const r = await api.revokeOtherSessions();
                setNotice({ tone: "success", text: `Signed out ${r.revoked} other device(s).` });
                await onChanged();
              } catch (err) {
                setNotice({ tone: "error", text: errorMessage(err) });
              }
              setBusyId(null);
            }}
          >
            Sign out all other devices
          </Button>
        ) : undefined
      }
    >
      <ul className="divide-y divide-stone-100">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div className="flex items-start gap-3">
              <Laptop size={18} className="mt-0.5 text-stone-400" />
              <div>
                <div className="font-medium text-stone-900">
                  {s.device} {s.current && <Badge tone="success">This device</Badge>}
                </div>
                <div className="text-xs text-stone-500">
                  {s.ip ? `${s.ip} · ` : ""}Last active {new Date(s.lastSeenAt).toLocaleString()} · Signed in {new Date(s.createdAt).toLocaleString()}
                </div>
              </div>
            </div>
            {!s.current && (
              <Button variant="danger" busy={busyId === s.id} onClick={() => void revoke(s.id)}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
