// Apex landing — pure marketing, no auth UI.
// Tenants sign in via their own subdomain (e.g. biz-group.bizfabric.ai/sign-in);
// landing on the apex never offers a sign-in option, so anyone arriving here
// (signed in or not) just sees the brand page.

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-100 text-black">
      <div className="relative flex-1 overflow-hidden p-12">
        <div className="absolute inset-0 opacity-[0.2]">
          <svg
            className="absolute -right-32 top-1/4 h-[600px] w-[600px]"
            viewBox="0 0 600 600"
            fill="none"
          >
            <circle cx="300" cy="300" r="200" stroke="black" strokeWidth="1" />
            <circle cx="300" cy="300" r="260" stroke="black" strokeWidth="0.5" />
            <circle cx="300" cy="300" r="140" stroke="black" strokeWidth="0.5" />
          </svg>
        </div>

        <div className="relative z-10 flex h-full flex-col justify-between">
          <div className="mt-16 max-w-2xl">
            <h1 className="text-6xl font-bold tracking-tight leading-tight">
              Fabric.
            </h1>
            <p className="mt-6 text-lg text-neutral-600 leading-relaxed">
              Capture how your organization works through conversations. Build a
              living knowledge base, effortlessly.
            </p>
          </div>

          <p className="text-sm text-neutral-400">
            &copy; {new Date().getFullYear()} Fabric. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
