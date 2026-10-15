import { PageShell } from "@/components/PageShell";
import { AccountSecurityClient } from "./AccountSecurityClient";

/** Account security: sessions, password and multi-factor authentication. Available to every signed-in role. */
export default function AccountSecurityPage() {
  return (
    <PageShell title="Account security" subtitle="Where you are signed in, your password, and two-step verification.">
      <AccountSecurityClient />
    </PageShell>
  );
}
