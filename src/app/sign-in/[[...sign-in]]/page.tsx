import { SignIn } from "@clerk/nextjs";
import { AuthShell, clerkAuthAppearance } from "@/components/auth-shell";

export default function SignInPage() {
  return (
    <AuthShell
      title="Welcome back!"
      description="Sign in to continue to your Fabric workspace."
    >
      <SignIn
        appearance={clerkAuthAppearance}
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl="/"
      />
    </AuthShell>
  );
}
