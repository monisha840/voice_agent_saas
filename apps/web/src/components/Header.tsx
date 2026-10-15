"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AudioLines, ChevronDown, LogOut } from "lucide-react";
import { api, type AuthUser } from "@/lib/api";
import { can } from "@/lib/permissions";
import { ORG_MODULES_CHANGED_EVENT, hasModule } from "@/lib/modules";
import { Badge } from "@/components/ui";

/**
 * Top navigation: daily work first (Overview, Agents, Knowledge, Numbers, Projects, Leads, Calls, Site Visits, Follow-ups), then tools and
 * administration (Test, Usage, Team, Settings). Sales items appear only when the organization has the module
 * enabled. Items are
 * shown only to roles that can use them; the API enforces the same rules regardless.
 */
export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  // Module toggles in Settings change what the navigation shows; reload who-am-I when that happens.
  useEffect(() => {
    const reload = () => {
      api
        .me()
        .then(setUser)
        .catch(() => undefined); // keep the current navigation if the refresh fails
    };
    window.addEventListener(ORG_MODULES_CHANGED_EVENT, reload);
    return () => window.removeEventListener(ORG_MODULES_CHANGED_EVENT, reload);
  }, []);

  const org = user?.organization ?? null;
  const role = org?.role ?? null;
  const orgs = user?.organizations ?? [];

  const sales = hasModule(org, "sales");
  // Daily work first (Sales items only when the module is on), then the tools and administration.
  const coreItems = [
    { label: "Overview", href: "/", active: pathname === "/", show: true },
    { label: "Agents", href: "/agents", active: pathname.startsWith("/agents"), show: can(role, "agents:read") },
    // Core (no module): knowledge bases are read with agents:read and changed with agents:manage (the API enforces both).
    { label: "Knowledge", href: "/knowledge", active: pathname.startsWith("/knowledge"), show: can(role, "agents:read") },
    // Phone numbers and inbound routing: readable with agents:read, changed with agents:manage (the API enforces both).
    { label: "Numbers", href: "/numbers", active: pathname.startsWith("/numbers"), show: can(role, "agents:read") },
    { label: "Projects", href: "/projects", active: pathname.startsWith("/projects"), show: sales },
    { label: "Leads", href: "/leads", active: pathname.startsWith("/leads"), show: sales },
    { label: "Calls", href: "/calls", active: pathname.startsWith("/calls"), show: can(role, "calls:read") },
    { label: "Site Visits", href: "/site-visits", active: pathname.startsWith("/site-visits"), show: sales },
    { label: "Follow-ups", href: "/follow-ups", active: pathname.startsWith("/follow-ups"), show: sales },
  ].filter((i) => i.show);

  const toolItems = [
    { label: "Test", href: "/test", active: pathname.startsWith("/test"), show: can(role, "calls:create") },
    { label: "Usage", href: "/usage", active: pathname.startsWith("/usage"), show: can(role, "usage:read") },
    { label: "Team", href: "/team", active: pathname.startsWith("/team"), show: can(role, "users:read") },
    { label: "Settings", href: "/settings", active: pathname.startsWith("/settings"), show: can(role, "audit:read") },
    { label: "Demo", href: "/demo", active: pathname === "/demo", show: sales },
  ].filter((i) => i.show);

  async function switchOrg(organizationId: string) {
    setBusy(true);
    try {
      await api.switchOrganization(organizationId);
      const me = await api.me();
      setUser(me);
      setMenuOpen(false);
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await api.logout();
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6 sm:py-4">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-700 text-white">
            <AudioLines size={18} strokeWidth={2} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-stone-900">{org?.name ?? "Voice AI"}</div>
            <div className="text-xs text-stone-500">Voice AI</div>
          </div>
        </Link>

        <nav className="order-3 flex w-full items-center gap-1 overflow-x-auto text-sm md:order-none md:w-auto">
          {coreItems.map((item) => (
            <NavLink key={item.label} {...item} />
          ))}
          {toolItems.length > 0 && (
            <>
              <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-stone-200" />
              {toolItems.map((item) => (
                <NavLink key={item.label} {...item} />
              ))}
            </>
          )}
        </nav>

        {user && (
          <div className="flex items-center gap-2 text-sm">
            {role && <Badge tone="success">{role}</Badge>}
            {orgs.length > 1 ? (
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((o) => !o)}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="inline-flex items-center gap-1 rounded-md border border-stone-300 px-2.5 py-1.5 font-medium text-stone-700 hover:bg-stone-100"
                >
                  <span className="max-w-[10rem] truncate">{org?.name ?? "Organization"}</span>
                  <ChevronDown size={14} />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 z-40 mt-1 w-56 rounded-md border border-stone-200 bg-white py-1 shadow-lg"
                  >
                    {orgs.map((o) => (
                      <button
                        key={o.id}
                        role="menuitem"
                        disabled={busy || o.id === org?.id}
                        onClick={() => void switchOrg(o.id)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-60"
                      >
                        <span className="truncate">{o.name}</span>
                        <span className="text-xs text-stone-400">{o.id === org?.id ? "current" : o.role}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            <Link
              href="/account/security"
              className={`rounded-md px-2.5 py-1.5 font-medium hover:bg-stone-100 ${
                pathname.startsWith("/account") ? "bg-stone-100 text-stone-900" : "text-stone-600 hover:text-stone-900"
              }`}
            >
              Security
            </Link>
            <button
              onClick={() => void signOut()}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900"
            >
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        )}
      </div>
      {user?.security?.mfaEnrollmentRequired && (
        <div role="alert" className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
          Your role requires two-step verification.{" "}
          <Link href="/account/security" className="font-medium underline">
            Set it up now
          </Link>{" "}
          to continue using the dashboard.
        </div>
      )}
      {user && !user.security?.mfaEnabled && !user.security?.mfaEnrollmentRequired && (role === "OWNER" || role === "ADMIN") && user.security?.mfaEnforcement === "warn" && (
        <div className="border-t border-stone-200 bg-stone-50 px-4 py-1.5 text-center text-xs text-stone-600">
          Protect this admin account:{" "}
          <Link href="/account/security" className="font-medium underline">
            turn on two-step verification
          </Link>
          .
        </div>
      )}
    </header>
  );
}

function NavLink({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`whitespace-nowrap rounded-md px-3 py-1.5 font-medium transition ${
        active ? "bg-stone-100 text-stone-900" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
      }`}
    >
      {label}
    </Link>
  );
}
