"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-stone-500">
      <Loader2 size={16} className="animate-spin" />
      {label}
    </div>
  );
}

export function ErrorState({
  title = "Unable to load",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-5">
      <div className="flex items-center gap-2 text-red-800">
        <AlertCircle size={18} />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <p className="text-sm text-red-700">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-50"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 bg-stone-50/60 px-6 py-10 text-center">
      <p className="text-sm font-medium text-stone-700">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-stone-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Shown instead of a module's pages when the organization has that module switched off. */
export function ModuleDisabled({ moduleName = "Sales", message }: { moduleName?: string; message?: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-6">
      <div className="text-sm font-semibold text-stone-900">{moduleName} module is not enabled</div>
      <p className="mt-1 text-sm text-stone-500">
        {message ?? `This organization has not enabled the ${moduleName} module.`} An organization owner can turn it on
        in Settings.
      </p>
    </div>
  );
}
