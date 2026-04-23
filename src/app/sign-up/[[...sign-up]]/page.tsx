import { SignUp } from "@clerk/nextjs";
import { AuthShell, clerkAuthAppearance } from "@/components/auth-shell";

export default function SignUpPage() {
  return (
    <AuthShell
      title="Create your account"
      description="Join your Fabric workspace and start capturing how work gets done."
    >
      <SignUp
        appearance={clerkAuthAppearance}
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/"
      />
    </AuthShell>
  );
}
