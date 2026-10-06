import { Building2 } from "lucide-react";
import { AcceptInviteForm } from "./AcceptInviteForm";

export default function AcceptInvitePage({ searchParams }: { searchParams: { token?: string } }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-700 text-white">
            <Building2 size={18} strokeWidth={2} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-stone-900">Voice AI Sales Console</div>
            <div className="text-xs text-stone-500">Accept your invitation</div>
          </div>
        </div>
        <AcceptInviteForm token={searchParams.token ?? ""} />
      </div>
    </main>
  );
}
