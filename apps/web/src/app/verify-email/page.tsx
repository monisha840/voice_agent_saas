import { MailCheck } from "lucide-react";
import { VerifyEmailClient } from "./VerifyEmailClient";

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-700 text-white">
            <MailCheck size={18} strokeWidth={2} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-stone-900">Voice AI</div>
            <div className="text-xs text-stone-500">Confirm your e-mail address</div>
          </div>
        </div>
        <VerifyEmailClient token={token ?? ""} />
      </div>
    </main>
  );
}
