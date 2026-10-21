import { KeyRound } from "lucide-react";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-700 text-white">
            <KeyRound size={18} strokeWidth={2} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-stone-900">Voice AI</div>
            <div className="text-xs text-stone-500">Reset your password</div>
          </div>
        </div>
        <ForgotPasswordForm initialEmail={typeof email === "string" ? email.slice(0, 320) : ""} />
      </div>
    </main>
  );
}
