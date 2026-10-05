import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { Header } from "@/components/Header";
import { ErrorState } from "@/components/StateViews";
import { LeadDetailClient } from "./LeadDetailClient";

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  try {
    const lead = await api.getLead(params.id);
    return <LeadDetailClient initial={lead} />;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
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
