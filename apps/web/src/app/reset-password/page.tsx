import { KeyRound } from "lucide-react";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-700 text-white">
            <KeyRound size={18} strokeWidth={2} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-stone-900">Voice AI</div>
            <div className="text-xs text-stone-500">Choose a new password</div>
          </div>
        </div>
        <ResetPasswordForm token={token ?? ""} />
      </div>
    </main>
  );
}
