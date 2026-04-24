import { AuthShell } from "@/components/auth-shell";
import { JoinSubdomainOrganization } from "@/components/join-subdomain-organization";

export default function JoinOrganizationPage() {
  return (
    <AuthShell
      title="Joining your workspace"
      description="We are connecting your account to this Fabric workspace."
    >
      <JoinSubdomainOrganization />
    </AuthShell>
  );
}
