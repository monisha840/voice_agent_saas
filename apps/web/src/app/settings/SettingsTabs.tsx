import Link from "next/link";

/** Settings sub-navigation: General (organization + modules) and Activity (audit log). */
export function SettingsTabs({ active }: { active: "general" | "activity" }) {
  const tabs = [
    { key: "general", label: "General", href: "/settings" },
    { key: "activity", label: "Activity", href: "/settings/activity" },
  ] as const;
  return (
    <nav className="mb-6 flex gap-1 border-b border-stone-200 text-sm">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`-mb-px border-b-2 px-3 py-2 font-medium ${
            t.key === active
              ? "border-emerald-700 text-stone-900"
              : "border-transparent text-stone-500 hover:text-stone-800"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
