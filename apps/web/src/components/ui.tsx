"use client";

import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import { ApiError } from "@/lib/api";

export const inputClass =
  "w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 focus:border-emerald-600 focus:outline-none disabled:bg-stone-100 disabled:text-stone-500";

/** Human-readable text for a failed API call. 403 gets a friendly permission message. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You don't have permission to do that.";
    return err.message;
  }
  return "Unable to reach the server. Please check that the backend is running.";
}

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 block font-medium text-stone-700">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-emerald-700 text-white hover:bg-emerald-800",
  secondary: "border border-stone-300 bg-white text-stone-700 hover:bg-stone-100",
  danger: "border border-red-300 bg-white text-red-700 hover:bg-red-50",
  ghost: "text-stone-600 hover:bg-stone-100",
};

export function Button({
  variant = "primary",
  busy = false,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {busy && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

type BadgeTone = "neutral" | "success" | "info" | "warn" | "error";
const BADGE: Record<BadgeTone, string> = {
  neutral: "bg-stone-100 text-stone-600 ring-stone-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  info: "bg-blue-50 text-blue-700 ring-blue-200",
  warn: "bg-amber-50 text-amber-700 ring-amber-200",
  error: "bg-red-50 text-red-700 ring-red-200",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Notice({ tone, children }: { tone: "error" | "success" | "info"; children: ReactNode }) {
  const styles = {
    error: "bg-red-50 text-red-700",
    success: "bg-emerald-50 text-emerald-800",
    info: "bg-stone-100 text-stone-700",
  }[tone];
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-md px-3 py-2 text-sm ${styles}`}>
      {children}
    </p>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/40 px-4 py-10">
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-stone-400 hover:bg-stone-100">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white">
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}
