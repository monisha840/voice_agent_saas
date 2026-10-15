import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api.server";
import { Header } from "@/components/Header";
import { can } from "@/lib/permissions";
import { ErrorState, ModuleDisabled } from "@/components/StateViews";
import { LeadDetailClient } from "./LeadDetailClient";

export default async function LeadDetailPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  try {
    const lead = await api.getLead(params.id);
    const role = (await api.me().catch(() => null))?.organization?.role ?? null;
    const projects = await api.listProjectsAll(true).catch(() => []);
    const assignees = can(role, "leads:assign") ? await api.listUsers().catch(() => []) : [];
    return <LeadDetailClient initial={lead} role={role} projects={projects} assignees={assignees} />;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    if (err instanceof ApiError && err.status === 403 && /module/i.test(err.message)) {
      return (
        <main className="min-h-screen bg-stone-50">
          <Header />
          <div className="mx-auto max-w-6xl px-6 py-16">
            <ModuleDisabled message={err.message} />
          </div>
        </main>
      );
    }
    return (
      <main className="min-h-screen bg-stone-50">
        <Header />
        <div className="mx-auto max-w-6xl px-6 py-16">
          <ErrorState
            title="Unable to load lead"
            message="Please check that the backend is running and try again."
          />
        </div>
      </main>
    );
  }
}
