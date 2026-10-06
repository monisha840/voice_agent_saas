import type { ReactNode } from "react";
import { Header } from "./Header";
import { ErrorState, ModuleDisabled } from "./StateViews";
import { ApiError } from "@/lib/api";

/** Standard page frame for the management screens (header + centered container). */
export function PageShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-stone-50">
      <Header />
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {title && (
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-stone-900">{title}</h1>
              {subtitle && <p className="mt-1 text-sm text-stone-500">{subtitle}</p>}
            </div>
            {actions}
          </div>
        )}
        {children}
      </div>
    </main>
  );
}

/** Error panel for a failed server-side load; 403/404 get tailored copy. */
export function LoadFailure({ err, what }: { err: unknown; what: string }) {
  if (err instanceof ApiError && err.status === 403 && /module/i.test(err.message)) {
    return <ModuleDisabled message={err.message} />;
  }
  if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
    return (
      <ErrorState
        title={err.status === 403 ? "You don't have permission" : `${what} not found`}
        message={
          err.status === 403
            ? `Your role does not allow viewing ${what.toLowerCase()}. Ask an organization admin if you need access.`
            : `This ${what.toLowerCase()} does not exist or you don't have access to it.`
        }
      />
    );
  }
  return (
    <ErrorState
      title={`Unable to load ${what.toLowerCase()}`}
      message="Please check that the backend is running and try again."
    />
  );
}
