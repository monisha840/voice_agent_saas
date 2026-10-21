"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { LeadFormModal } from "@/components/LeadForm";
import type { Project, TeamMember } from "@/lib/types";

/** Fired after a lead is created so client-side lead lists reload. */
export const LEADS_CHANGED_EVENT = "leads:changed";

export function NewLeadButton({ projects, assignees }: { projects: Project[]; assignees: TeamMember[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus size={14} />
        New lead
      </Button>
      {open && (
        <LeadFormModal
          projects={projects}
          assignees={assignees}
          canAssign
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
            router.refresh();
          }}
        />
      )}
    </>
  );
}
