"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2 } from "lucide-react";

/**
 * Top navigation. "Overview" and "Leads" both point at the dashboard
 * route (one screen already covers both, per the existing MVP) — only
 * "Demo" is a genuinely separate route, added for the MD walkthrough.
 * No nav item links anywhere the API doesn't actually back.
 */
export function Header() {
  const pathname = usePathname();

  const navItems = [
    { label: "Overview", href: "/", active: pathname === "/" },
    { label: "Leads", href: "/", active: pathname.startsWith("/leads") },
    { label: "Demo", href: "/demo", active: pathname === "/demo" },
  ];

  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-700 text-white">
            <Building2 size={18} strokeWidth={2} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-stone-900">Green Valley Developers</div>
            <div className="text-xs text-stone-500">Voice AI Sales Console</div>
          </div>
        </Link>

        <nav className="flex items-center gap-1 text-sm">
          {navItems.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className={`rounded-md px-3 py-1.5 font-medium transition ${
                item.active
                  ? "bg-stone-100 text-stone-900"
                  : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
