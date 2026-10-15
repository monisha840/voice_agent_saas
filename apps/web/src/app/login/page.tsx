import { AudioLines } from "lucide-react";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const query = await searchParams;
  // Only allow same-site relative redirects after login.
  const next = query.next && query.next.startsWith("/") && !query.next.startsWith("//") ? query.next : "/";

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-6">
      <div className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-700 text-white">
            <AudioLines size={18} strokeWidth={2} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-stone-900">Voice AI</div>
            <div className="text-xs text-stone-500">Sign in to continue</div>
          </div>
        </div>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
